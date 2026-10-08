import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db.js';
import { can, HttpError, type Auth } from '../auth.js';
import { audit } from '../audit.js';
import { assertRefs, insertRow, pageParams } from '../crud.js';
import { ymd, accountBalance, calcCharges, cashflow, categoryId, collectionProfile, getFinanceSettings, loadTitle, reverseSettlement, settle, today, type Horizon } from '../finance.js';
import { extractLines, guessMapping, norm, parseCsv, type CsvMapping } from '../lib/csv.js';
import { text } from '../schemas.js';
import { KIND_FALLBACK, postBankOpening, postMovement, postPayableCreated, postReceivableCreated } from '../accounting.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = z.coerce.number().min(0).max(1e10);
const date = z.string().date();
const OUT_R = `t.amount - coalesce((select sum(principal) from settlements s where s.receivable_id = t.id and s.reversed_at is null), 0)`;
const OUT_P = `t.amount - coalesce((select sum(principal) from settlements s where s.payable_id = t.id and s.reversed_at is null), 0)`;

const settleBody = z.object({ date: date.optional(), account_id: z.string().uuid(), principal: money.optional(), discount: money.optional(), interest: money.optional(), fine: money.optional(), fee: money.optional(), method: text(30), note: text(300) });

export async function financeRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Configuração e cadastros de apoio
  app.get('/finance/settings', async (req) => { const a = can(req, 'finance:view'); return getFinanceSettings(pool, a.companyId); });
  app.put('/finance/settings', async (req) => {
    const a = can(req, 'finance:approve');
    const b = z.object({ fine_pct: z.coerce.number().min(0).max(20), interest_monthly_pct: z.coerce.number().min(0).max(20), grace_days: z.coerce.number().int().min(0).max(30),
      default_accounts: z.record(z.string(), z.string().uuid()).default(() => ({})) }).parse(req.body);
    for (const k of Object.keys(b.default_accounts)) if (!['dinheiro', 'pix', 'cartao_debito'].includes(k)) throw new HttpError(422, `Forma de pagamento inválida: ${k}.`);
    for (const id of Object.values(b.default_accounts)) await assertRefs(pool, a.companyId, { id }, { id: 'bank_accounts' });
    const before = await getFinanceSettings(pool, a.companyId);
    await pool.query(`insert into company_settings (company_id, key, value) values ($1,'finance',$2) on conflict (company_id, key) do update set value = $2, updated_at = now()`, [a.companyId, JSON.stringify(b)]);
    await audit(pool, a, 'settings', 'finance', 'update', before, b); return b;
  });
  app.get('/finance/categories', async (req) => { const a = can(req, 'finance:view'); return { items: (await pool.query('select * from finance_categories where company_id = $1 and active order by kind, name', [a.companyId])).rows }; });
  app.post('/finance/categories', async (req, reply) => {
    const a = can(req, 'finance:create');
    const b = z.object({ name: z.string().trim().min(2).max(80), kind: z.enum(['receita', 'despesa', 'imposto', 'financeira', 'investimento', 'estoque', 'outras']), dre_group: text(40), ledger_account_id: z.string().uuid().nullish().transform((v) => v ?? null) }).parse(req.body);
    if (b.ledger_account_id) await assertRefs(pool, a.companyId, b, { ledger_account_id: 'ledger_accounts' });
    else b.ledger_account_id = (await pool.query('select id from ledger_accounts where company_id = $1 and system_key = $2', [a.companyId, KIND_FALLBACK[b.kind]])).rows[0]?.id ?? null;
    const r = await insertRow(pool, 'finance_categories', a.companyId, b); await audit(pool, a, 'finance_category', String(r.id), 'create', null, r); return reply.code(201).send(r);
  });
  app.get('/finance/cost-centers', async (req) => { const a = can(req, 'finance:view'); return { items: (await pool.query('select * from cost_centers where company_id = $1 and active order by name', [a.companyId])).rows }; });
  app.post('/finance/cost-centers', async (req, reply) => {
    const a = can(req, 'finance:create'); const b = z.object({ name: z.string().trim().min(2).max(60) }).parse(req.body);
    const r = await insertRow(pool, 'cost_centers', a.companyId, b); await audit(pool, a, 'cost_center', String(r.id), 'create', null, r); return reply.code(201).send(r);
  });

  // ---------------------------------------------------------------- Contas (bancos, caixa, aplicações)
  app.get('/bank-accounts', async (req) => {
    const a = can(req, 'finance:view');
    const r = await pool.query(`select a.id, a.name, a.kind, a.bank_name, a.agency, a.account_number, a.opening_balance, a.opening_date, a.active, a.csv_profile is not null as has_profile,
      a.opening_balance + coalesce((select sum(amount) from account_movements m where m.account_id = a.id and not m.reversed), 0) as balance,
      (select count(*)::int from bank_statement_lines l where l.account_id = a.id and l.status = 'pendente') as pending_lines
      from bank_accounts a where a.company_id = $1 order by a.kind, a.name`, [a.companyId]);
    return { items: r.rows };
  });
  const accountBody = z.object({ name: z.string().trim().min(2).max(80), kind: z.enum(['banco', 'caixa', 'aplicacao']).default('banco'), bank_name: text(60), agency: text(20), account_number: text(30),
    opening_balance: z.coerce.number().min(-1e10).max(1e10).default(0), opening_date: date.optional(), active: z.boolean().optional() });
  app.post('/bank-accounts', async (req, reply) => {
    const a = can(req, 'finance:create'); const b = accountBody.parse(req.body);
    const r = await tx(async (db) => { const x = await insertRow(db, 'bank_accounts', a.companyId, b); await postBankOpening(db, String(x.id)); await audit(db, a, 'bank_account', String(x.id), 'create', null, x); return x; }); return reply.code(201).send(r);
  });
  app.patch('/bank-accounts/:id', async (req) => {
    const a = can(req, 'finance:edit'); const id = (req.params as { id: string }).id; const b = accountBody.partial().omit({ opening_balance: true, opening_date: true }).parse(req.body);
    const cols = Object.keys(b); if (!cols.length) throw new HttpError(422, 'Nada para atualizar.');
    const r = await pool.query(`update bank_accounts set ${cols.map((c, i) => `${c} = $${i + 3}`).join(',')} where id = $1 and company_id = $2 returning *`, [id, a.companyId, ...cols.map((c) => (b as Record<string, unknown>)[c])]);
    if (!r.rowCount) throw new HttpError(404, 'Conta não encontrada.'); await audit(pool, a, 'bank_account', id, 'update', null, b); return r.rows[0];
  });
  /** Extrato do ERP: movimentos com saldo acumulado. */
  app.get('/bank-accounts/:id/statement', async (req) => {
    const a = can(req, 'finance:view'); const id = (req.params as { id: string }).id; const q = req.query as Record<string, string>;
    const acc = (await pool.query('select * from bank_accounts where id = $1 and company_id = $2', [id, a.companyId])).rows[0]; if (!acc) throw new HttpError(404, 'Conta não encontrada.');
    const from = q.from || '1900-01-01', to = q.to || '2999-12-31';
    const prev = Number(acc.opening_balance) + Number((await pool.query('select coalesce(sum(amount),0) s from account_movements where account_id = $1 and not reversed and movement_date < $2', [id, from])).rows[0].s);
    const rows = (await pool.query(`select m.*, c.name as category_name, (select l.status from bank_statement_lines l where l.movement_id = m.id limit 1) as recon from account_movements m left join finance_categories c on c.id = m.category_id
      where m.account_id = $1 and m.movement_date between $2 and $3 order by m.movement_date, m.created_at`, [id, from, to])).rows;
    let run = prev; const items = rows.map((m) => { if (!m.reversed) run += Number(m.amount); return { ...m, balance: r2(run) }; });
    return { account: acc, opening: r2(prev), closing: r2(run), items };
  });
  app.post('/bank-accounts/transfer', async (req, reply) => {
    const a = can(req, 'finance:create');
    const b = z.object({ from_account_id: z.string().uuid(), to_account_id: z.string().uuid(), amount: z.coerce.number().positive().max(1e10), date: date.optional(), kind: z.enum(['transferencia', 'aplicacao', 'resgate']).default('transferencia'), description: text(200) }).parse(req.body);
    if (b.from_account_id === b.to_account_id) throw new HttpError(422, 'Origem e destino devem ser diferentes.');
    const out = await tx(async (db) => {
      await assertRefs(db, a.companyId, { f: b.from_account_id, t: b.to_account_id } as never, { f: 'bank_accounts', t: 'bank_accounts' });
      const d = b.date ?? today(); const ref = (await db.query('select gen_random_uuid() id')).rows[0].id as string; const desc = b.description ?? 'Transferência entre contas';
      const o = (await db.query(`insert into account_movements (company_id, account_id, movement_date, amount, kind, description, ref_type, ref_id, created_by) values ($1,$2,$3,$4,$5,$6,'transfer',$7,$8) returning id`, [a.companyId, b.from_account_id, d, -b.amount, b.kind, desc, ref, a.userId])).rows[0]; await postMovement(db, o.id);
      const i = (await db.query(`insert into account_movements (company_id, account_id, movement_date, amount, kind, description, ref_type, ref_id, created_by) values ($1,$2,$3,$4,$5,$6,'transfer',$7,$8) returning id`, [a.companyId, b.to_account_id, d, b.amount, b.kind, desc, ref, a.userId])).rows[0]; await postMovement(db, i.id);
      await audit(db, a, 'transfer', ref, 'create', null, b); return { transfer_id: ref, out_movement: o.id, in_movement: i.id };
    });
    return reply.code(201).send(out);
  });
  /** Lançamentos avulsos: tarifas, juros, rendimentos, ajustes. Valor com sinal (− saída, + entrada). */
  app.post('/account-movements', async (req, reply) => {
    const a = can(req, 'finance:create');
    const b = z.object({ account_id: z.string().uuid(), date: date.optional(), amount: z.coerce.number().refine((v) => v !== 0, 'Valor não pode ser zero').refine((v) => Math.abs(v) < 1e10), kind: z.enum(['tarifa', 'juros', 'rendimento', 'ajuste']),
      category_id: z.string().uuid().nullish().transform((v) => v ?? null), description: z.string().trim().min(3).max(200) }).parse(req.body);
    if (b.kind === 'ajuste' && !a.permissions.has('finance:approve')) throw new HttpError(403, 'Ajuste manual de saldo exige aprovação (finance:approve).');
    const row = await tx(async (db) => {
      await assertRefs(db, a.companyId, { account_id: b.account_id, category_id: b.category_id }, { account_id: 'bank_accounts', category_id: 'finance_categories' });
      const cat = b.category_id ?? await categoryId(db, a.companyId, b.kind === 'tarifa' ? 'Tarifas bancárias' : b.kind === 'rendimento' ? 'Rendimentos de aplicação' : b.kind === 'juros' ? (b.amount < 0 ? 'Juros e multas pagos' : 'Juros e multas recebidos') : null as never);
      const r = (await db.query(`insert into account_movements (company_id, account_id, movement_date, amount, kind, description, category_id, ref_type, created_by) values ($1,$2,$3,$4,$5,$6,$7,'manual',$8) returning *`, [a.companyId, b.account_id, b.date ?? today(), b.amount, b.kind, b.description, cat, a.userId])).rows[0];
      await postMovement(db, r.id); await audit(db, a, 'account_movement', r.id, 'create', null, r); return r;
    });
    return reply.code(201).send(row);
  });

  // ---------------------------------------------------------------- Contas a receber
  const recSelect = `select t.*, ${OUT_R} as outstanding, c.legal_name as customer_name, (t.due_date < current_date and t.status in ('aberto','parcial')) as overdue,
      greatest(0, current_date - t.due_date) as days_late, s.number as sale_number, cat.name as category_name
    from receivables t left join customers c on c.id = t.customer_id left join sales s on s.id = t.sale_id left join finance_categories cat on cat.id = t.category_id`;
  app.get('/receivables', async (req) => {
    const a = can(req, 'finance:view'); const q = req.query as Record<string, string>; const { page, pageSize, offset } = pageParams(q);
    const p: unknown[] = [a.companyId]; let w = 't.company_id = $1';
    if (q.status === 'aberto') w += ` and t.status in ('aberto','parcial')`; else if (q.status) { p.push(q.status); w += ` and t.status = $${p.length}`; }
    if (q.overdue === 'true') w += ` and t.due_date < current_date and t.status in ('aberto','parcial')`;
    if (q.customer_id) { p.push(q.customer_id); w += ` and t.customer_id = $${p.length}`; }
    if (q.from) { p.push(q.from); w += ` and t.due_date >= $${p.length}`; } if (q.to) { p.push(q.to); w += ` and t.due_date <= $${p.length}`; }
    if (q.q?.trim()) { p.push(`%${q.q.trim()}%`); w += ` and (unaccent(coalesce(c.legal_name,'')) ilike unaccent($${p.length}) or coalesce(t.description,'') ilike $${p.length} or s.number::text = trim(both '%' from $${p.length}))`; }
    const from = ` from (${recSelect} where ${w}) t`;
    const [items, tot, sum] = await Promise.all([pool.query(`select * ${from} order by t.due_date, t.created_at limit ${pageSize} offset ${offset}`, p), pool.query(`select count(*)::int n ${from}`, p),
      pool.query(`select coalesce(sum(outstanding) filter (where status in ('aberto','parcial')),0) as open, coalesce(sum(outstanding) filter (where overdue),0) as overdue ${from}`, p)]);
    return { items: items.rows, total: tot.rows[0].n, page, pageSize, open_amount: sum.rows[0].open, overdue_amount: sum.rows[0].overdue };
  });
  app.get('/receivables/aging', async (req) => {
    const a = can(req, 'finance:view');
    const r = await pool.query(`select case when t.due_date >= current_date then 'a vencer' when current_date - t.due_date <= 30 then '1-30' when current_date - t.due_date <= 60 then '31-60' when current_date - t.due_date <= 90 then '61-90' else '+90' end as bucket,
      count(*)::int as titles, coalesce(sum(${OUT_R}),0)::numeric(14,2) as amount from receivables t where t.company_id = $1 and t.status in ('aberto','parcial') group by 1`, [a.companyId]);
    return { buckets: ['a vencer', '1-30', '31-60', '61-90', '+90'].map((b) => ({ bucket: b, titles: r.rows.find((x) => x.bucket === b)?.titles ?? 0, amount: r.rows.find((x) => x.bucket === b)?.amount ?? '0.00' })) };
  });
  app.post('/receivables', async (req, reply) => {
    const a = can(req, 'finance:create');
    const b = z.object({ customer_id: z.string().uuid().nullish().transform((v) => v ?? null), due_date: date, amount: z.coerce.number().positive().max(1e10), description: z.string().trim().min(3).max(200), category_id: z.string().uuid().nullish().transform((v) => v ?? null), method: text(30) }).parse(req.body);
    const r = await tx(async (db) => {
      await assertRefs(db, a.companyId, b, { customer_id: 'customers', category_id: 'finance_categories' });
      const row = (await db.query(`insert into receivables (company_id, customer_id, installment_no, installments, due_date, amount, method, description, category_id, competence) values ($1,$2,1,1,$3,$4,$5,$6,$7,date_trunc('month', current_date)::date) returning *`,
        [a.companyId, b.customer_id, b.due_date, b.amount, b.method ?? 'boleto', b.description, b.category_id ?? await categoryId(db, a.companyId, 'Outras receitas')])).rows[0];
      await postReceivableCreated(db, row.id); await audit(db, a, 'receivable', row.id, 'create', null, row); return row;
    });
    return reply.code(201).send(r);
  });
  const charges = async (db: Db, a: Auth, kind: 'receivable' | 'payable', id: string, on?: string) => {
    const t = await loadTitle(db, kind, id, a.companyId); const s = await getFinanceSettings(db, a.companyId);
    const c = calcCharges({ outstanding: t.outstanding, due_date: t.due_date, on_date: on ?? today(), fine_already_charged: t.fine_paid > 0, last_settle_date: t.last_settle }, s);
    return { outstanding: r2(t.outstanding), due_date: t.due_date, on_date: on ?? today(), ...c, total_due: r2(t.outstanding + c.total), policy: { fine_pct: s.fine_pct, interest_monthly_pct: s.interest_monthly_pct, grace_days: s.grace_days } };
  };
  app.get('/receivables/:id', async (req) => {
    const a = can(req, 'finance:view'); const id = (req.params as { id: string }).id; const r = (await pool.query(`${recSelect} where t.id = $1 and t.company_id = $2`, [id, a.companyId])).rows[0];
    if (!r) throw new HttpError(404, 'Título não encontrado.');
    const settlements = (await pool.query('select s.*, ba.name as account_name from settlements s left join bank_accounts ba on ba.id = s.account_id where s.receivable_id = $1 order by s.created_at', [id])).rows;
    return { ...r, settlements, charges: ['aberto', 'parcial'].includes(r.status) ? await charges(pool, a, 'receivable', id) : null };
  });
  app.get('/receivables/:id/charges', async (req) => { const a = can(req, 'finance:view'); return charges(pool, a, 'receivable', (req.params as { id: string }).id, (req.query as { date?: string }).date); });
  app.post('/receivables/:id/settle', async (req) => {
    const a = can(req, 'finance:edit'); const b = settleBody.parse(req.body);
    return tx((db) => settle(db, a, { kind: 'receivable', docId: (req.params as { id: string }).id, date: b.date, accountId: b.account_id, principal: b.principal, discount: b.discount, interest: b.interest, fine: b.fine, fee: b.fee, method: b.method, note: b.note }));
  });
  app.post('/receivables/:id/cancel', async (req) => {
    const a = can(req, 'finance:delete'); const id = (req.params as { id: string }).id; const { reason } = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
    return tx(async (db) => {
      const t = await loadTitle(db, 'receivable', id, a.companyId, true);
      if (t.sale_id) throw new HttpError(409, 'Título gerado por venda: cancele a venda.');
      const used = await db.query('select 1 from settlements where receivable_id = $1 and reversed_at is null', [id]); if (used.rowCount) throw new HttpError(409, 'Título com baixas: estorne as baixas antes de cancelar.');
      await db.query(`update receivables set status = 'cancelado' where id = $1`, [id]); await audit(db, a, 'receivable', id, 'cancel', { status: t.status }, { reason }); return { status: 'cancelado' };
    });
  });

  // ---------------------------------------------------------------- Contas a pagar
  const payOutstanding = `case when t.kind = 'credito' then ${OUT_P} else ${OUT_P} end`;
  const paySelect = `select t.*, ${payOutstanding} as outstanding, sup.legal_name as supplier_name, u.name as payee_name, cat.name as category_name, cc.name as cost_center_name,
      (t.due_date < current_date and t.status in ('aberto','parcial') and t.kind = 'titulo') as overdue
    from payables t left join suppliers sup on sup.id = t.supplier_id left join users u on u.id = t.payee_user_id left join finance_categories cat on cat.id = t.category_id left join cost_centers cc on cc.id = t.cost_center_id`;
  app.get('/payables', async (req) => {
    const a = can(req, 'finance:view'); const q = req.query as Record<string, string>; const { page, pageSize, offset } = pageParams(q);
    const p: unknown[] = [a.companyId]; let w = 't.company_id = $1';
    if (q.status === 'aberto') w += ` and t.status in ('aberto','parcial')`; else if (q.status) { p.push(q.status); w += ` and t.status = $${p.length}`; }
    if (q.overdue === 'true') w += ` and t.due_date < current_date and t.status in ('aberto','parcial') and t.kind = 'titulo'`;
    if (q.kind) { p.push(q.kind); w += ` and t.kind = $${p.length}`; }
    if (q.supplier_id) { p.push(q.supplier_id); w += ` and t.supplier_id = $${p.length}`; }
    if (q.from) { p.push(q.from); w += ` and t.due_date >= $${p.length}`; } if (q.to) { p.push(q.to); w += ` and t.due_date <= $${p.length}`; }
    if (q.q?.trim()) { p.push(`%${q.q.trim()}%`); w += ` and (unaccent(coalesce(sup.legal_name,'')) ilike unaccent($${p.length}) or coalesce(t.description,'') ilike $${p.length} or coalesce(t.doc_number,'') ilike $${p.length})`; }
    const from = ` from (${paySelect} where ${w}) t`;
    const [items, tot, sum] = await Promise.all([pool.query(`select * ${from} order by t.due_date, t.created_at limit ${pageSize} offset ${offset}`, p), pool.query(`select count(*)::int n ${from}`, p),
      pool.query(`select coalesce(sum(outstanding) filter (where status in ('aberto','parcial') and kind = 'titulo'),0) as open, coalesce(sum(outstanding) filter (where overdue),0) as overdue, coalesce(sum(outstanding) filter (where status in ('aberto','parcial') and kind = 'credito'),0) as credits ${from}`, p)]);
    return { items: items.rows, total: tot.rows[0].n, page, pageSize, open_amount: sum.rows[0].open, overdue_amount: sum.rows[0].overdue, credit_amount: sum.rows[0].credits };
  });
  app.post('/payables', async (req, reply) => {
    const a = can(req, 'finance:create');
    const b = z.object({ supplier_id: z.string().uuid().nullish().transform((v) => v ?? null), description: z.string().trim().min(3).max(200), doc_number: text(30), category_id: z.string().uuid(), cost_center_id: z.string().uuid().nullish().transform((v) => v ?? null),
      competence: date.optional(), first_due_date: date, amount: z.coerce.number().positive().max(1e10), installments: z.coerce.number().int().min(1).max(60).default(1), repeat_monthly: z.boolean().default(false) }).parse(req.body);
    const rows = await tx(async (db) => {
      await assertRefs(db, a.companyId, b, { supplier_id: 'suppliers', category_id: 'finance_categories', cost_center_id: 'cost_centers' });
      const cat = (await db.query(`select c.kind, c.name, la.type from finance_categories c left join ledger_accounts la on la.id = c.ledger_account_id where c.id = $1`, [b.category_id])).rows[0];
      if (cat.kind === 'estoque' || cat.type === 'passivo') throw new HttpError(422, `A categoria "${cat.name}" é reconhecida por fluxo próprio (NF de compra, DAS, comissões ou restituições) e não pode ser lançada como despesa avulsa.`, 'category_not_allowed');
      const n = b.installments; const base = Math.floor(b.amount / n * 100) / 100; const out = [];
      for (let k = 0; k < n; k++) {
        const amount = b.repeat_monthly ? b.amount : (k === n - 1 ? r2(b.amount - base * (n - 1)) : base);
        const due = (await db.query(`select ($1::date + ($2 || ' months')::interval)::date::text d`, [b.first_due_date, String(k)])).rows[0].d;
        const comp = b.competence ? (await db.query(`select date_trunc('month', $1::date + ($2 || ' months')::interval)::date::text d`, [b.competence, String(k)])).rows[0].d : due.slice(0, 7) + '-01';
        out.push((await db.query(`insert into payables (company_id, supplier_id, installment_no, installments, due_date, amount, description, category_id, cost_center_id, competence, doc_number) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
          [a.companyId, b.supplier_id, k + 1, n, due, amount, b.description, b.category_id, b.cost_center_id, comp, b.doc_number])).rows[0]);
        await postPayableCreated(db, out[out.length - 1].id);
      }
      await audit(db, a, 'payable', out[0].id, 'create', null, { count: n, amount: b.amount, repeat: b.repeat_monthly }); return out;
    });
    return reply.code(201).send({ items: rows });
  });
  app.get('/payables/:id', async (req) => {
    const a = can(req, 'finance:view'); const id = (req.params as { id: string }).id; const r = (await pool.query(`${paySelect} where t.id = $1 and t.company_id = $2`, [id, a.companyId])).rows[0];
    if (!r) throw new HttpError(404, 'Título não encontrado.');
    const settlements = (await pool.query('select s.*, ba.name as account_name from settlements s left join bank_accounts ba on ba.id = s.account_id where s.payable_id = $1 order by s.created_at', [id])).rows;
    return { ...r, settlements, charges: r.kind === 'titulo' && ['aberto', 'parcial'].includes(r.status) ? await charges(pool, a, 'payable', id) : null };
  });
  app.get('/payables/:id/charges', async (req) => { const a = can(req, 'finance:view'); return charges(pool, a, 'payable', (req.params as { id: string }).id, (req.query as { date?: string }).date); });
  app.post('/payables/:id/settle', async (req) => {
    const a = can(req, 'finance:edit'); const b = settleBody.parse(req.body);
    return tx((db) => settle(db, a, { kind: 'payable', docId: (req.params as { id: string }).id, date: b.date, accountId: b.account_id, principal: b.principal, discount: b.discount, interest: b.interest, fine: b.fine, method: b.method, note: b.note }));
  });
  /** Compensa um crédito do fornecedor (ex.: devolução) contra um título em aberto do mesmo fornecedor. Sem movimento bancário. */
  app.post('/payables/:id/apply-credit', async (req) => {
    const a = can(req, 'finance:edit'); const id = (req.params as { id: string }).id; const b = z.object({ credit_id: z.string().uuid(), amount: z.coerce.number().positive() }).parse(req.body);
    return tx(async (db) => {
      const [t, c] = [await loadTitle(db, 'payable', id, a.companyId, true), await loadTitle(db, 'payable', b.credit_id, a.companyId, true)];
      if (t.kind !== 'titulo' || c.kind !== 'credito') throw new HttpError(422, 'Informe um título e um crédito.');
      if (t.supplier_id !== c.supplier_id) throw new HttpError(422, 'Crédito e título são de fornecedores diferentes.');
      if (['cancelado', 'pago'].includes(t.status) || ['cancelado', 'pago'].includes(c.status)) throw new HttpError(409, 'Título ou crédito já quitado/cancelado.');
      const amt = r2(b.amount); if (amt > t.outstanding + 0.005 || amt > c.outstanding + 0.005) throw new HttpError(422, `Valor acima do saldo (título R$ ${t.outstanding.toFixed(2)}, crédito R$ ${c.outstanding.toFixed(2)}).`);
      for (const [doc, left] of [[t, t.outstanding - amt], [c, c.outstanding - amt]] as const) {
        await db.query(`insert into settlements (company_id, kind, payable_id, settle_date, principal, method, note, created_by) values ($1,'payable',$2,current_date,$3,'compensacao',$4,$5)`, [a.companyId, doc.id, amt, `Compensação ${t.id.slice(0, 8)} × ${c.id.slice(0, 8)}`, a.userId]);
        await db.query(`update payables set status = $2 where id = $1`, [doc.id, left <= 0.004 ? 'pago' : 'parcial']);
      }
      await audit(db, a, 'payable', id, 'credit_applied', null, { credit_id: b.credit_id, amount: amt }); return { applied: amt };
    });
  });
  app.post('/payables/:id/cancel', async (req) => {
    const a = can(req, 'finance:delete'); const id = (req.params as { id: string }).id; const { reason } = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
    return tx(async (db) => {
      const t = await loadTitle(db, 'payable', id, a.companyId, true);
      if (t.receiving_id && t.kind === 'titulo') throw new HttpError(409, 'Título gerado por recebimento de NF: trate por devolução/crédito.');
      const used = await db.query('select 1 from settlements where payable_id = $1 and reversed_at is null', [id]); if (used.rowCount) throw new HttpError(409, 'Título com baixas: estorne as baixas antes de cancelar.');
      await db.query(`update payables set status = 'cancelado' where id = $1`, [id]); await audit(db, a, 'payable', id, 'cancel', { status: t.status }, { reason }); return { status: 'cancelado' };
    });
  });
  app.post('/settlements/:id/reverse', async (req) => { const a = can(req, 'finance:approve'); return tx((db) => reverseSettlement(db, a, (req.params as { id: string }).id)); });

  // ---------------------------------------------------------------- Extrato CSV e conciliação
  const csvBody = z.object({ csv: z.string().min(10).max(5_000_000), mapping: z.object({ delimiter: z.string().max(1).optional(), decimal: z.enum([',', '.']).optional(), header_row: z.number().int().min(0).optional(),
    date: z.number().int().min(0), description: z.number().int().min(0).optional(), amount: z.number().int().min(0).optional(), debit: z.number().int().min(0).optional(), credit: z.number().int().min(0).optional(), doc: z.number().int().min(0).optional() }).optional(), save_profile: z.boolean().default(false) });
  const accountOf = async (a: Auth, id: string) => { const r = (await pool.query('select * from bank_accounts where id = $1 and company_id = $2', [id, a.companyId])).rows[0]; if (!r) throw new HttpError(404, 'Conta não encontrada.'); return r; };
  const analyse = (csv: string, saved: CsvMapping | null, given?: CsvMapping) => {
    const parsed = parseCsv(csv, given?.delimiter ?? saved?.delimiter); const guess = guessMapping(parsed.rows);
    const mapping: CsvMapping | null = given ?? saved ?? (guess.mapping ? { ...guess.mapping, delimiter: parsed.delimiter, decimal: ',' } : null);
    return { rows: parsed.rows, delimiter: parsed.delimiter, mapping, guessed: !given && !saved && !!guess.mapping, header_row: mapping?.header_row ?? guess.header_row };
  };
  app.post('/bank-accounts/:id/statement/preview', async (req) => {
    const a = can(req, 'finance:view'); const id = (req.params as { id: string }).id; const acc = await accountOf(a, id); const b = csvBody.parse(req.body);
    const an = analyse(b.csv, acc.csv_profile, b.mapping);
    const out: Record<string, unknown> = { delimiter: an.delimiter, mapping: an.mapping, guessed: an.guessed, total_rows: an.rows.length, headers: an.rows[an.header_row] ?? [], sample_rows: an.rows.slice(0, 8) };
    if (an.mapping) { const x = extractLines(an.rows, an.mapping, id); const dup = x.lines.length ? (await pool.query('select count(*)::int n from bank_statement_lines where account_id = $1 and hash = any($2)', [id, x.lines.map((l) => l.hash)])).rows[0].n : 0;
      out.lines = x.lines.slice(0, 15); out.line_count = x.lines.length; out.skipped = x.skipped.slice(0, 20); out.duplicates = dup; out.total_in = r2(x.lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0)); out.total_out = r2(x.lines.filter((l) => l.amount < 0).reduce((s, l) => s - l.amount, 0)); }
    else out.needs_mapping = true;
    return out;
  });
  app.post('/bank-accounts/:id/statement/import', async (req, reply) => {
    const a = can(req, 'finance:create'); const id = (req.params as { id: string }).id; const acc = await accountOf(a, id); const b = csvBody.parse(req.body);
    const an = analyse(b.csv, acc.csv_profile, b.mapping); if (!an.mapping) throw new HttpError(422, 'Não foi possível identificar as colunas: informe o mapeamento.', 'needs_mapping');
    const x = extractLines(an.rows, an.mapping, id); if (!x.lines.length) throw new HttpError(422, 'Nenhuma linha válida encontrada no arquivo.', 'no_lines');
    const out = await tx(async (db) => {
      const batch = (await db.query('select gen_random_uuid() id')).rows[0].id as string; let inserted = 0;
      for (const l of x.lines) inserted += (await db.query(`insert into bank_statement_lines (company_id, account_id, line_date, description, amount, doc_ref, hash, batch_id) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (account_id, hash) do nothing`, [a.companyId, id, l.line_date, l.description, l.amount, l.doc_ref, l.hash, batch])).rowCount ?? 0;
      if (b.save_profile) await db.query('update bank_accounts set csv_profile = $2 where id = $1', [id, JSON.stringify(an.mapping)]);
      await audit(db, a, 'bank_statement', batch, 'import', null, { account: acc.name, lines: x.lines.length, inserted, skipped: x.skipped.length });
      const auto = await autoReconcile(db, a, id); return { batch_id: batch, inserted, duplicates: x.lines.length - inserted, skipped: x.skipped.length, auto_reconciled: auto };
    });
    return reply.code(201).send(out);
  });

  /** Concilia automaticamente linha ↔ movimento do ERP quando há UM candidato exato (mesma conta, mesmo valor, data até ±5 dias) e ele não serve a outra linha. */
  async function autoReconcile(db: Db, a: Auth, accountId: string) {
    const lines = (await db.query(`select * from bank_statement_lines where account_id = $1 and company_id = $2 and status = 'pendente' order by line_date`, [accountId, a.companyId])).rows;
    const mvs = (await db.query(`select m.* from account_movements m where m.account_id = $1 and m.company_id = $2 and not m.reversed and not exists (select 1 from bank_statement_lines l where l.movement_id = m.id and l.status = 'conciliado')`, [accountId, a.companyId])).rows;
    const near = (l: { amount: string; line_date: Date | string }) => mvs.filter((m) => Number(m.amount) === Number(l.amount) && Math.abs(Date.parse(ymd(m.movement_date)) - Date.parse(ymd(l.line_date))) <= 5 * 86400000);
    const claimed = new Set<string>(); let n = 0;
    const cand = lines.map((l) => ({ l, c: near(l) })); const usage = new Map<string, number>(); for (const { c } of cand) for (const m of c) usage.set(m.id, (usage.get(m.id) ?? 0) + 1);
    for (const { l, c } of cand) {
      if (c.length !== 1 || usage.get(c[0].id) !== 1 || claimed.has(c[0].id)) continue;
      claimed.add(c[0].id);
      await db.query(`update bank_statement_lines set status = 'conciliado', movement_id = $2, reconciled_by = $3, reconciled_at = now(), note = 'conciliação automática' where id = $1`, [l.id, c[0].id, a.userId]); n++;
    }
    if (n) await audit(db, a, 'bank_statement', accountId, 'auto_reconcile', null, { matched: n });
    return n;
  }
  app.post('/reconciliation/auto', async (req) => { const a = can(req, 'finance:edit'); const { account_id } = z.object({ account_id: z.string().uuid() }).parse(req.body); await accountOf(a, account_id); return { matched: await tx((db) => autoReconcile(db, a, account_id)) }; });
  app.get('/reconciliation/lines', async (req) => {
    const a = can(req, 'finance:view'); const q = req.query as Record<string, string>; const { page, pageSize, offset } = pageParams(q);
    const { account_id } = z.object({ account_id: z.string().uuid() }).parse(q); const p: unknown[] = [a.companyId, account_id]; let w = 'l.company_id = $1 and l.account_id = $2';
    if (q.status) { p.push(q.status); w += ` and l.status = $${p.length}`; }
    const r = await pool.query(`select l.*, m.description as movement_description from bank_statement_lines l left join account_movements m on m.id = l.movement_id where ${w} order by l.line_date desc, l.created_at limit ${pageSize} offset ${offset}`, p);
    const n = await pool.query(`select count(*)::int n from bank_statement_lines l where ${w}`, p); return { items: r.rows, total: n.rows[0].n, page, pageSize };
  });
  app.get('/reconciliation/summary', async (req) => {
    const a = can(req, 'finance:view'); const { account_id } = z.object({ account_id: z.string().uuid() }).parse(req.query); await accountOf(a, account_id);
    const s = (await pool.query(`select count(*) filter (where status = 'pendente')::int as pending, count(*) filter (where status = 'conciliado')::int as reconciled, count(*) filter (where status = 'ignorado')::int as ignored,
      coalesce(sum(amount) filter (where status = 'pendente'),0) as pending_amount, coalesce(sum(amount),0) as statement_total from bank_statement_lines where account_id = $1`, [account_id])).rows[0];
    const m = (await pool.query(`select count(*)::int n, coalesce(sum(amount),0) as amount from account_movements m where m.account_id = $1 and not m.reversed and not exists (select 1 from bank_statement_lines l where l.movement_id = m.id and l.status = 'conciliado')`, [account_id])).rows[0];
    return { ...s, unreconciled_movements: m.n, unreconciled_movements_amount: m.amount, erp_balance: await accountBalance(pool, a.companyId, account_id) };
  });
  /** Candidatos para uma linha do extrato: movimentos do ERP e títulos em aberto (valor exato, com pontuação por data e nome). */
  app.get('/reconciliation/lines/:id/candidates', async (req) => {
    const a = can(req, 'finance:view'); const id = (req.params as { id: string }).id;
    const l = (await pool.query('select * from bank_statement_lines where id = $1 and company_id = $2', [id, a.companyId])).rows[0]; if (!l) throw new HttpError(404, 'Linha não encontrada.');
    const amt = Number(l.amount); const abs = Math.abs(amt); const ld = ymd(l.line_date); const desc = norm(l.description ?? '');
    const movements = (await pool.query(`select m.*, abs(m.movement_date - $3::date) as days_apart from account_movements m where m.company_id = $1 and m.account_id = $2 and not m.reversed and m.amount = $4 and abs(m.movement_date - $3::date) <= 10
      and not exists (select 1 from bank_statement_lines x where x.movement_id = m.id and x.status = 'conciliado') order by days_apart limit 10`, [a.companyId, l.account_id, ld, amt])).rows;
    const titles = amt > 0
      ? (await pool.query(`select * from (${recSelect} where t.company_id = $1 and t.status in ('aberto','parcial')) t where abs(t.outstanding - $2) < 0.01 or (t.customer_name is not null and $3 like '%' || lower(split_part(t.customer_name, ' ', 1)) || '%' and length(split_part(t.customer_name, ' ', 1)) > 3) order by abs(t.due_date - $4::date) limit 15`, [a.companyId, abs, desc, ld])).rows.map((t) => ({ ...t, kind: 'receivable', exact: Math.abs(Number(t.outstanding) - abs) < 0.01 }))
      : (await pool.query(`select * from (${paySelect} where t.company_id = $1 and t.status in ('aberto','parcial') and t.kind = 'titulo') t where abs(t.outstanding - $2) < 0.01 or (t.supplier_name is not null and $3 like '%' || lower(split_part(t.supplier_name, ' ', 1)) || '%' and length(split_part(t.supplier_name, ' ', 1)) > 3) order by abs(t.due_date - $4::date) limit 15`, [a.companyId, abs, desc, ld])).rows.map((t) => ({ ...t, kind: 'payable', exact: Math.abs(Number(t.outstanding) - abs) < 0.01 }));
    return { line: l, movements, titles };
  });
  const lineOf = async (db: Db, a: Auth, id: string) => { const l = (await db.query('select * from bank_statement_lines where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0]; if (!l) throw new HttpError(404, 'Linha não encontrada.'); if (l.status !== 'pendente') throw new HttpError(409, `Linha ${l.status}.`); return l; };
  app.post('/reconciliation/lines/:id/match-movement', async (req) => {
    const a = can(req, 'finance:edit'); const { movement_id } = z.object({ movement_id: z.string().uuid() }).parse(req.body);
    return tx(async (db) => {
      const l = await lineOf(db, a, (req.params as { id: string }).id);
      const m = (await db.query('select * from account_movements where id = $1 and company_id = $2 and account_id = $3 and not reversed', [movement_id, a.companyId, l.account_id])).rows[0];
      if (!m) throw new HttpError(422, 'Movimento inválido para esta conta.'); if (Number(m.amount) !== Number(l.amount)) throw new HttpError(422, 'Valor do movimento difere do extrato.');
      if ((await db.query(`select 1 from bank_statement_lines where movement_id = $1 and status = 'conciliado'`, [movement_id])).rowCount) throw new HttpError(409, 'Movimento já conciliado.');
      await db.query(`update bank_statement_lines set status = 'conciliado', movement_id = $2, reconciled_by = $3, reconciled_at = now() where id = $1`, [l.id, movement_id, a.userId]);
      await audit(db, a, 'bank_statement', l.id, 'reconcile', null, { movement_id }); return { status: 'conciliado' };
    });
  });
  /** Baixa o título direto a partir do extrato: cria baixa + movimento na conta e concilia a linha. O caixa calculado precisa bater com o extrato. */
  app.post('/reconciliation/lines/:id/settle', async (req) => {
    const a = can(req, 'finance:edit'); const b = z.object({ kind: z.enum(['receivable', 'payable']), doc_id: z.string().uuid(), principal: money.optional(), discount: money.optional(), interest: money.optional(), fine: money.optional(), fee: money.optional() }).parse(req.body);
    return tx(async (db) => {
      const l = await lineOf(db, a, (req.params as { id: string }).id); const amt = Number(l.amount);
      if ((b.kind === 'receivable') !== (amt > 0)) throw new HttpError(422, b.kind === 'receivable' ? 'Linha de saída não pode baixar título a receber.' : 'Linha de entrada não pode baixar título a pagar.');
      const r = await settle(db, a, { kind: b.kind, docId: b.doc_id, date: ymd(l.line_date), accountId: l.account_id, principal: b.principal, discount: b.discount, interest: b.interest, fine: b.fine, fee: b.fee, method: 'extrato', note: `Conciliação: ${l.description ?? ''}`.slice(0, 250) });
      if (Math.abs(r.cash - Math.abs(amt)) > 0.01) throw new HttpError(422, `O valor calculado da baixa (R$ ${r.cash.toFixed(2)}) difere do extrato (R$ ${Math.abs(amt).toFixed(2)}). Ajuste principal, desconto, juros, multa ou taxa.`, 'amount_mismatch', { computed: r.cash, statement: Math.abs(amt) });
      await db.query(`update bank_statement_lines set status = 'conciliado', movement_id = $2, reconciled_by = $3, reconciled_at = now() where id = $1`, [l.id, r.settlement.movement_id, a.userId]);
      await audit(db, a, 'bank_statement', l.id, 'reconcile', null, { settlement_id: r.settlement.id }); return { status: 'conciliado', settlement_id: r.settlement.id, outstanding_after: r.outstanding_after };
    });
  });
  /** Linha sem contrapartida no ERP (tarifa, rendimento, juros...): cria o movimento a partir do extrato e concilia. */
  app.post('/reconciliation/lines/:id/create-movement', async (req) => {
    const a = can(req, 'finance:create'); const b = z.object({ kind: z.enum(['tarifa', 'juros', 'rendimento', 'ajuste', 'aplicacao', 'resgate']), category_id: z.string().uuid().nullish().transform((v) => v ?? null), description: text(200) }).parse(req.body);
    if (b.kind === 'ajuste' && !a.permissions.has('finance:approve')) throw new HttpError(403, 'Ajuste exige aprovação (finance:approve).');
    return tx(async (db) => {
      const l = await lineOf(db, a, (req.params as { id: string }).id); await assertRefs(db, a.companyId, { category_id: b.category_id }, { category_id: 'finance_categories' });
      const amt = Number(l.amount); const cat = b.category_id ?? await categoryId(db, a.companyId, b.kind === 'tarifa' ? 'Tarifas bancárias' : b.kind === 'rendimento' ? 'Rendimentos de aplicação' : b.kind === 'juros' ? (amt < 0 ? 'Juros e multas pagos' : 'Juros e multas recebidos') : 'Outras despesas administrativas');
      const m = (await db.query(`insert into account_movements (company_id, account_id, movement_date, amount, kind, description, category_id, ref_type, ref_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,'statement',$8,$9) returning id`,
        [a.companyId, l.account_id, l.line_date, amt, b.kind, b.description ?? l.description ?? 'Lançamento do extrato', cat, l.id, a.userId])).rows[0];
      await postMovement(db, m.id);
      await db.query(`update bank_statement_lines set status = 'conciliado', movement_id = $2, reconciled_by = $3, reconciled_at = now() where id = $1`, [l.id, m.id, a.userId]);
      await audit(db, a, 'bank_statement', l.id, 'reconcile', null, { created_movement: m.id, kind: b.kind }); return { status: 'conciliado', movement_id: m.id };
    });
  });
  app.post('/reconciliation/lines/:id/ignore', async (req) => {
    const a = can(req, 'finance:edit'); const { note } = z.object({ note: z.string().trim().min(3).max(200) }).parse(req.body);
    return tx(async (db) => { const l = await lineOf(db, a, (req.params as { id: string }).id); await db.query(`update bank_statement_lines set status = 'ignorado', note = $2, reconciled_by = $3, reconciled_at = now() where id = $1`, [l.id, note, a.userId]); await audit(db, a, 'bank_statement', l.id, 'ignore', null, { note }); return { status: 'ignorado' }; });
  });
  app.post('/reconciliation/lines/:id/undo', async (req) => {
    const a = can(req, 'finance:approve'); const id = (req.params as { id: string }).id;
    const r = await pool.query(`update bank_statement_lines set status = 'pendente', movement_id = null, reconciled_by = null, reconciled_at = null, note = null where id = $1 and company_id = $2 and status in ('conciliado','ignorado') returning id`, [id, a.companyId]);
    if (!r.rowCount) throw new HttpError(409, 'Linha não encontrada ou pendente.'); await audit(pool, a, 'bank_statement', id, 'unreconcile'); return { status: 'pendente' };
  });

  // ---------------------------------------------------------------- Caixa físico (opcional)
  app.get('/cash/sessions', async (req) => {
    const a = can(req, 'finance:view');
    const r = await pool.query(`select s.*, ba.name as account_name, u.name as opened_by_name,
      case when s.status = 'aberto' then s.opening_amount + coalesce((select sum(amount) from account_movements m where m.account_id = s.account_id and not m.reversed and m.created_at >= s.opened_at),0) else s.expected_amount end as expected_now
      from cash_sessions s join bank_accounts ba on ba.id = s.account_id join users u on u.id = s.opened_by where s.company_id = $1 order by s.opened_at desc limit 100`, [a.companyId]);
    return { items: r.rows };
  });
  app.post('/cash/open', async (req, reply) => {
    const a = can(req, 'finance:create'); const b = z.object({ account_id: z.string().uuid(), opening_amount: z.coerce.number().min(0).max(1e8).default(0) }).parse(req.body);
    const s = await tx(async (db) => {
      const acc = (await db.query(`select kind from bank_accounts where id = $1 and company_id = $2 and active`, [b.account_id, a.companyId])).rows[0];
      if (!acc || acc.kind !== 'caixa') throw new HttpError(422, 'Selecione uma conta do tipo caixa.');
      const row = (await db.query(`insert into cash_sessions (company_id, account_id, branch_id, opened_by, opening_amount) values ($1,$2,$3,$4,$5) returning *`, [a.companyId, b.account_id, a.branchId, a.userId, b.opening_amount])).rows[0];
      await audit(db, a, 'cash_session', row.id, 'open', null, row); return row;
    }).catch((e) => { if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'Já existe caixa aberto nesta conta.'); throw e; });
    return reply.code(201).send(s);
  });
  app.post('/cash/:id/movement', async (req, reply) => {
    const a = can(req, 'finance:create'); const id = (req.params as { id: string }).id;
    const b = z.object({ type: z.enum(['sangria', 'suprimento']), amount: z.coerce.number().positive().max(1e8), other_account_id: z.string().uuid().nullish().transform((v) => v ?? null), note: z.string().trim().min(3).max(200) }).parse(req.body);
    const out = await tx(async (db) => {
      const s = (await db.query(`select * from cash_sessions where id = $1 and company_id = $2 and status = 'aberto' for update`, [id, a.companyId])).rows[0]; if (!s) throw new HttpError(404, 'Caixa aberto não encontrado.');
      if (b.other_account_id) await assertRefs(db, a.companyId, { o: b.other_account_id } as never, { o: 'bank_accounts' });
      const ref = (await db.query('select gen_random_uuid() id')).rows[0].id;
      const sign = b.type === 'sangria' ? -1 : 1;
      const m = (await db.query(`insert into account_movements (company_id, account_id, movement_date, amount, kind, description, ref_type, ref_id, created_by) values ($1,$2,current_date,$3,$4,$5,'cash_session',$6,$7) returning id`, [a.companyId, s.account_id, sign * b.amount, b.type, b.note, id, a.userId])).rows[0]; await postMovement(db, m.id);
      if (b.other_account_id) await postMovement(db, (await db.query(`insert into account_movements (company_id, account_id, movement_date, amount, kind, description, ref_type, ref_id, created_by) values ($1,$2,current_date,$3,'transferencia',$4,'cash_session',$5,$6) returning id`, [a.companyId, b.other_account_id, -sign * b.amount, `${b.type === 'sangria' ? 'Sangria do caixa' : 'Suprimento ao caixa'}: ${b.note}`, id, a.userId])).rows[0].id);
      await audit(db, a, 'cash_session', id, b.type, null, { amount: b.amount, other: b.other_account_id, ref }); return { movement_id: m.id };
    });
    return reply.code(201).send(out);
  });
  app.post('/cash/:id/close', async (req) => {
    const a = can(req, 'finance:create'); const id = (req.params as { id: string }).id; const b = z.object({ counted_amount: z.coerce.number().min(0).max(1e9), note: text(200) }).parse(req.body);
    return tx(async (db) => {
      const s = (await db.query(`select * from cash_sessions where id = $1 and company_id = $2 and status = 'aberto' for update`, [id, a.companyId])).rows[0]; if (!s) throw new HttpError(404, 'Caixa aberto não encontrado.');
      const mv = Number((await db.query('select coalesce(sum(amount),0) s from account_movements where account_id = $1 and not reversed and created_at >= $2', [s.account_id, s.opened_at])).rows[0].s);
      const expected = r2(Number(s.opening_amount) + mv); const diff = r2(b.counted_amount - expected);
      if (diff !== 0) await postMovement(db, (await db.query(`insert into account_movements (company_id, account_id, movement_date, amount, kind, description, category_id, ref_type, ref_id, created_by) values ($1,$2,current_date,$3,'quebra_caixa',$4,$5,'cash_session',$6,$7) returning id`, [a.companyId, s.account_id, diff, `Diferença de caixa no fechamento${b.note ? ': ' + b.note : ''}`, await categoryId(db, a.companyId, 'Quebra de caixa'), id, a.userId])).rows[0].id);
      await db.query(`update cash_sessions set status = 'fechado', closed_by = $2, closed_at = now(), expected_amount = $3, counted_amount = $4, difference = $5 where id = $1`, [id, a.userId, expected, b.counted_amount, diff]);
      await audit(db, a, 'cash_session', id, 'close', null, { expected, counted: b.counted_amount, difference: diff }); return { expected, counted: b.counted_amount, difference: diff };
    });
  });

  // ---------------------------------------------------------------- Fluxo de caixa
  app.get('/finance/cashflow', async (req) => {
    const a = can(req, 'finance:view'); const q = z.object({ horizon: z.coerce.number().refine((v) => [0, 7, 30, 60, 90, 365].includes(v)).default(30), account_id: z.string().uuid().optional() }).parse(req.query);
    return cashflow(pool, a.companyId, q.horizon as Horizon, q.account_id ? [q.account_id] : undefined);
  });
  app.get('/finance/collection-profile', async (req) => { const a = can(req, 'finance:view'); return collectionProfile(pool, a.companyId); });

  // ---------------------------------------------------------------- Comissões (representantes externos)
  app.get('/commissions/pending', async (req) => {
    const a = can(req, 'finance:view'); const q = req.query as Record<string, string>; const to = q.to || today();
    const r = await pool.query(`select s.seller_id, u.name, count(*)::int as sales, sum(s.total)::numeric(14,2) as revenue, sum(s.commission_amount)::numeric(14,2) as commission, min(s.confirmed_at)::date::text as first_sale, max(s.confirmed_at)::date::text as last_sale
      from sales s join users u on u.id = s.seller_id where s.company_id = $1 and s.status = 'concluida' and s.commission_closing_id is null and s.commission_amount > 0 and s.confirmed_at::date <= $2 group by s.seller_id, u.name order by u.name`, [a.companyId, to]);
    return { up_to: to, items: r.rows };
  });
  app.post('/commissions/close', async (req, reply) => {
    const a = can(req, 'finance:approve'); const b = z.object({ seller_id: z.string().uuid(), up_to: date, due_date: date }).parse(req.body);
    const out = await tx(async (db) => {
      const sales = (await db.query(`select id, commission_amount from sales where company_id = $1 and seller_id = $2 and status = 'concluida' and commission_closing_id is null and commission_amount > 0 and confirmed_at::date <= $3 for update`, [a.companyId, b.seller_id, b.up_to])).rows;
      if (!sales.length) throw new HttpError(422, 'Nenhuma comissão pendente para o período.');
      const total = r2(sales.reduce((s, x) => s + Number(x.commission_amount), 0));
      const seller = (await db.query('select name from users where id = $1 and company_id = $2', [b.seller_id, a.companyId])).rows[0]; if (!seller) throw new HttpError(422, 'Vendedor inválido.');
      const cl = (await db.query(`insert into commission_closings (company_id, seller_id, up_to, total, sales_count, created_by) values ($1,$2,$3,$4,$5,$6) returning *`, [a.companyId, b.seller_id, b.up_to, total, sales.length, a.userId])).rows[0];
      const pay = (await db.query(`insert into payables (company_id, due_date, amount, description, category_id, competence, payee_user_id, doc_number) values ($1,$2,$3,$4,$5,date_trunc('month',$6::date)::date,$7,$8) returning id`,
        [a.companyId, b.due_date, total, `Comissões de ${seller.name} até ${b.up_to}`, await categoryId(db, a.companyId, 'Comissões'), b.up_to, b.seller_id, `COM-${cl.id.slice(0, 8)}`])).rows[0];
      await db.query('update commission_closings set payable_id = $2 where id = $1', [cl.id, pay.id]);
      await db.query('update sales set commission_closing_id = $2 where id = any($1)', [sales.map((s) => s.id), cl.id]);
      await audit(db, a, 'commission_closing', cl.id, 'close', null, { seller: seller.name, total, sales: sales.length, payable_id: pay.id }); return { ...cl, payable_id: pay.id };
    });
    return reply.code(201).send(out);
  });
  app.get('/commissions/closings', async (req) => {
    const a = can(req, 'finance:view');
    const r = await pool.query(`select c.*, u.name as seller_name, p.status as payable_status from commission_closings c join users u on u.id = c.seller_id left join payables p on p.id = c.payable_id where c.company_id = $1 order by c.created_at desc limit 100`, [a.companyId]);
    return { items: r.rows };
  });
}
