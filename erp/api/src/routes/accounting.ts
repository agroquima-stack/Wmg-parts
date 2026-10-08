import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { can, HttpError } from '../auth.js';
import { audit } from '../audit.js';
import { assertRefs } from '../crud.js';
import { balanceSheet, consistencyChecks, dre, post, reverseEntry, syncLedger, trialBalance } from '../accounting.js';
import { text } from '../schemas.js';

const date = z.string().date();
const monthStart = () => new Date().toISOString().slice(0, 7) + '-01';
const today = () => new Date().toISOString().slice(0, 10);
const money = z.coerce.number().min(0).max(1e11);

export async function accountingRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Plano de contas
  app.get('/accounting/accounts', async (req) => {
    const a = can(req, 'accounting:view');
    const r = await pool.query(`select a.*, coalesce((select sum(l.debit - l.credit) from journal_lines l where l.account_id = a.id),0) as balance_dc,
      (select count(*)::int from journal_lines l where l.account_id = a.id) as movements from ledger_accounts a where a.company_id = $1 order by a.code`, [a.companyId]);
    return { items: r.rows.map((x) => ({ ...x, balance: ['ativo', 'despesa', 'custo', 'deducao'].includes(x.type) ? Number(x.balance_dc) : -Number(x.balance_dc) })) };
  });
  const accBody = z.object({ code: z.string().trim().regex(/^\d+(\.\d+)*$/, 'Código no formato 1.1.1.01'), name: z.string().trim().min(2).max(120), type: z.enum(['ativo', 'passivo', 'pl', 'receita', 'deducao', 'custo', 'despesa', 'outros']),
    dre_group: z.enum(['receita_bruta', 'deducoes', 'impostos', 'cmv', 'desp_comercial', 'desp_administrativa', 'desp_financeira', 'rec_financeira', 'outros']).nullish().transform((v) => v ?? null) });
  app.post('/accounting/accounts', async (req, reply) => {
    const a = can(req, 'accounting:create'); const b = accBody.parse(req.body);
    const needsGroup = ['receita', 'deducao', 'custo', 'despesa', 'outros'].includes(b.type); if (needsGroup && !b.dre_group) throw new HttpError(422, 'Conta de resultado exige o grupo da DRE.');
    const r = (await pool.query(`insert into ledger_accounts (company_id, code, name, type, dre_group) values ($1,$2,$3,$4,$5) returning *`, [a.companyId, b.code, b.name, b.type, needsGroup ? b.dre_group : null])).rows[0];
    await audit(pool, a, 'ledger_account', r.id, 'create', null, r); return reply.code(201).send(r);
  });
  app.patch('/accounting/accounts/:id', async (req) => {
    const a = can(req, 'accounting:edit'); const id = (req.params as { id: string }).id;
    const b = z.object({ code: z.string().trim().regex(/^\d+(\.\d+)*$/).optional(), name: z.string().trim().min(2).max(120).optional(), active: z.boolean().optional() }).parse(req.body);
    return tx(async (db) => {
      const acc = (await db.query('select * from ledger_accounts where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0]; if (!acc) throw new HttpError(404, 'Conta não encontrada.');
      if (b.active === false) {
        const bal = Number((await db.query('select coalesce(sum(debit - credit),0) s from journal_lines where account_id = $1', [id])).rows[0].s);
        if (Math.abs(bal) > 0.004) throw new HttpError(409, 'Conta com saldo não pode ser inativada.');
        if (acc.system_key) throw new HttpError(409, 'Conta usada pelos lançamentos automáticos não pode ser inativada (renomeie ou renumere).');
      }
      const r = (await db.query(`update ledger_accounts set code = coalesce($2, code), name = coalesce($3, name), active = coalesce($4, active) where id = $1 returning *`, [id, b.code ?? null, b.name ?? null, b.active ?? null])).rows[0];
      await audit(db, a, 'ledger_account', id, 'update', acc, r); return r;
    });
  });
  /** Mapeia uma categoria financeira para a conta contábil que recebe seu lançamento. */
  app.put('/accounting/category-map/:id', async (req) => {
    const a = can(req, 'accounting:edit'); const { ledger_account_id } = z.object({ ledger_account_id: z.string().uuid() }).parse(req.body); const id = (req.params as { id: string }).id;
    await assertRefs(pool, a.companyId, { ledger_account_id }, { ledger_account_id: 'ledger_accounts' });
    const r = await pool.query('update finance_categories set ledger_account_id = $3 where id = $1 and company_id = $2 returning id', [id, a.companyId, ledger_account_id]); if (!r.rowCount) throw new HttpError(404, 'Categoria não encontrada.');
    await audit(pool, a, 'finance_category', id, 'ledger_map', null, { ledger_account_id }); return { ok: true };
  });
  app.get('/accounting/category-map', async (req) => {
    const a = can(req, 'accounting:view');
    return { items: (await pool.query(`select c.id, c.name, c.kind, c.ledger_account_id, la.code, la.name as account_name from finance_categories c left join ledger_accounts la on la.id = c.ledger_account_id where c.company_id = $1 and c.active order by c.kind, c.name`, [a.companyId])).rows };
  });

  // ---------------------------------------------------------------- Lançamentos manuais (abertura, ajustes do contador)
  app.get('/accounting/entries', async (req) => {
    const a = can(req, 'accounting:view'); const q = req.query as Record<string, string>; const p: unknown[] = [a.companyId]; let w = 'e.company_id = $1';
    if (q.kind) { p.push(q.kind); w += ` and e.kind = $${p.length}`; } if (q.from) { p.push(q.from); w += ` and e.entry_date >= $${p.length}`; } if (q.to) { p.push(q.to); w += ` and e.entry_date <= $${p.length}`; }
    if (q.account_id) { p.push(q.account_id); w += ` and exists (select 1 from journal_lines l where l.entry_id = e.id and l.account_id = $${p.length})`; }
    if (q.q?.trim()) { p.push(`%${q.q.trim()}%`); w += ` and e.description ilike $${p.length}`; }
    const r = await pool.query(`select e.*, (select coalesce(sum(debit),0) from journal_lines where entry_id = e.id) as total,
      (select json_agg(json_build_object('code', ac.code, 'name', ac.name, 'debit', l.debit, 'credit', l.credit) order by l.debit desc, ac.code) from journal_lines l join ledger_accounts ac on ac.id = l.account_id where l.entry_id = e.id) as lines
      from journal_entries e where ${w} order by e.entry_date desc, e.created_at desc limit 200`, p);
    return { items: r.rows };
  });
  app.post('/accounting/entries', async (req, reply) => {
    const a = can(req, 'accounting:approve');
    const b = z.object({ date, competence: date.optional(), description: z.string().trim().min(3).max(200), kind: z.enum(['manual', 'abertura']).default('manual'),
      lines: z.array(z.object({ account_id: z.string().uuid(), debit: money.default(0), credit: money.default(0), cost_center_id: z.string().uuid().nullish().transform((v) => v ?? null), description: text(200) })).min(2).max(50) }).parse(req.body);
    const d = Math.round(b.lines.reduce((s, l) => s + l.debit, 0) * 100) / 100, c = Math.round(b.lines.reduce((s, l) => s + l.credit, 0) * 100) / 100;
    if (b.lines.some((l) => (l.debit > 0) === (l.credit > 0))) throw new HttpError(422, 'Cada linha deve ter débito OU crédito.'); if (d !== c) throw new HttpError(422, `Lançamento desbalanceado: débitos R$ ${d.toFixed(2)} ≠ créditos R$ ${c.toFixed(2)}.`);
    return tx(async (db) => {
      for (const l of b.lines) await assertRefs(db, a.companyId, { account_id: l.account_id, cost_center_id: l.cost_center_id }, { account_id: 'ledger_accounts', cost_center_id: 'cost_centers' });
      const id = await post(db, a.companyId, { date: b.date, competence: b.competence, description: b.description, refType: 'manual', refId: (await db.query('select gen_random_uuid() id')).rows[0].id, kind: b.kind, userId: a.userId,
        lines: b.lines.map((l) => ({ accountId: l.account_id, debit: l.debit, credit: l.credit, dims: { cost_center_id: l.cost_center_id }, description: l.description ?? undefined })) });
      await audit(db, a, 'journal_entry', String(id), b.kind === 'abertura' ? 'opening_entry' : 'manual_entry', null, { description: b.description, total: d }); return reply.code(201).send({ id });
    });
  });
  app.post('/accounting/entries/:id/reverse', async (req) => {
    const a = can(req, 'accounting:approve'); const id = (req.params as { id: string }).id; const { reason } = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
    return tx(async (db) => {
      const e = (await db.query('select * from journal_entries where id = $1 and company_id = $2', [id, a.companyId])).rows[0]; if (!e) throw new HttpError(404, 'Lançamento não encontrado.');
      if ((await db.query('select 1 from journal_entries where reversal_of = $1', [id])).rowCount) throw new HttpError(409, 'Lançamento já estornado.');
      if (e.reversal_of) throw new HttpError(409, 'Não se estorna um estorno: faça um novo lançamento.');
      const rid = await reverseEntry(db, a.companyId, id, { refType: 'manual_reversal', refId: id, description: `Estorno: ${e.description} (${reason})`, userId: a.userId, kind: 'manual' });
      await audit(db, a, 'journal_entry', id, 'reversed', null, { reason, reversal: rid }); return { reversal_id: rid };
    });
  });
  app.post('/accounting/sync', async (req) => { const a = can(req, 'accounting:approve'); const r = await tx((db) => syncLedger(db, a.companyId)); await audit(pool, a, 'ledger', 'sync', 'sync', null, r); return r; });

  // ---------------------------------------------------------------- Relatórios
  app.get('/accounting/dre', async (req) => {
    const a = can(req, 'accounting:view'); const q = z.object({ from: date.default(monthStart()), to: date.default(today()), branch_id: z.string().uuid().optional(), channel: z.string().optional(), customer_id: z.string().uuid().optional(),
      category_id: z.string().uuid().optional(), brand_id: z.string().uuid().optional(), group_by: z.enum(['none', 'branch', 'channel', 'category', 'brand', 'customer', 'month']).default('none') }).parse(req.query);
    return dre(pool, a.companyId, { ...q, from: q.from.slice(0, 7) + '-01', to: q.to });
  });
  app.get('/accounting/balance-sheet', async (req) => { const a = can(req, 'accounting:view'); const { as_of } = z.object({ as_of: date.default(today()) }).parse(req.query); return balanceSheet(pool, a.companyId, as_of); });
  app.get('/accounting/trial-balance', async (req) => { const a = can(req, 'accounting:view'); const q = z.object({ from: date.default(monthStart()), to: date.default(today()) }).parse(req.query); return trialBalance(pool, a.companyId, q.from, q.to); });
  app.get('/accounting/ledger', async (req) => {
    const a = can(req, 'accounting:view'); const q = z.object({ account_id: z.string().uuid(), from: date.default('1900-01-01'), to: date.default('2999-12-31') }).parse(req.query);
    const acc = (await pool.query('select * from ledger_accounts where id = $1 and company_id = $2', [q.account_id, a.companyId])).rows[0]; if (!acc) throw new HttpError(404, 'Conta não encontrada.');
    const open = Number((await pool.query(`select coalesce(sum(l.debit - l.credit),0) s from journal_lines l join journal_entries e on e.id = l.entry_id where l.account_id = $1 and e.entry_date < $2`, [q.account_id, q.from])).rows[0].s);
    const rows = (await pool.query(`select e.id as entry_id, e.entry_date::text as entry_date, e.competence::text as competence, e.description, e.kind, l.debit, l.credit from journal_lines l join journal_entries e on e.id = l.entry_id where l.account_id = $1 and e.entry_date between $2 and $3 order by e.entry_date, e.created_at, l.id`, [q.account_id, q.from, q.to])).rows;
    let run = open; return { account: acc, opening: Math.round(open * 100) / 100, items: rows.map((r) => { run += Number(r.debit) - Number(r.credit); return { ...r, balance: Math.round(run * 100) / 100 }; }), closing: Math.round(run * 100) / 100, note: 'Saldo: positivo = devedor, negativo = credor.' };
  });
  /** Despesas por centro de custo no período (competência). */
  app.get('/accounting/cost-centers', async (req) => {
    const a = can(req, 'accounting:view'); const q = z.object({ from: date.default(monthStart()), to: date.default(today()) }).parse(req.query);
    const r = await pool.query(`select cc.id, coalesce(cc.name, 'Sem centro de custo') as name, a.dre_group, coalesce(sum(l.debit - l.credit),0) as amount from journal_lines l join journal_entries e on e.id = l.entry_id join ledger_accounts a on a.id = l.account_id
      left join cost_centers cc on cc.id = l.cost_center_id where l.company_id = $1 and a.type = 'despesa' and e.competence between $2 and $3 group by cc.id, cc.name, a.dre_group order by 2, 3`, [a.companyId, q.from.slice(0, 7) + '-01', q.to]);
    const by = new Map<string, any>(); for (const x of r.rows) { const k = x.name; const o = by.get(k) ?? { name: k, total: 0, groups: {} as Record<string, number> }; o.total += Number(x.amount); o.groups[x.dre_group ?? 'outros'] = (o.groups[x.dre_group ?? 'outros'] ?? 0) + Number(x.amount); by.set(k, o); }
    return { from: q.from, to: q.to, items: [...by.values()].map((o) => ({ ...o, total: Math.round(o.total * 100) / 100 })).sort((x, y) => y.total - x.total) };
  });
  app.get('/accounting/checks', async (req) => { const a = can(req, 'accounting:view'); return consistencyChecks(pool, a.companyId); });
}
