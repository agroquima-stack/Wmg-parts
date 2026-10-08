import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Db } from './db.js';
import { HttpError, type Auth } from './auth.js';
import { audit } from './audit.js';
import { balanceSheet, consistencyChecks, dre } from './accounting.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
export const monthEnd = (p: string) => iso(new Date(Date.UTC(+p.slice(0, 4), +p.slice(5, 7), 0)));
const prevMonth = (p: string) => iso(new Date(Date.UTC(+p.slice(0, 4), +p.slice(5, 7) - 2, 1)));
const currentMonth = () => monthStart(iso(new Date()));
const fmt = (p: string) => `${p.slice(5, 7)}/${p.slice(0, 4)}`;

export interface Check { key: string; label: string; level: 'bloqueio' | 'alerta'; ok: boolean; detail: string }

export async function closingChecks(db: Db, companyId: string, period: string) {
  const checks: Check[] = []; const end = monthEnd(period); const add = (key: string, label: string, level: Check['level'], ok: boolean, detail: string) => checks.push({ key, label, level, ok, detail });
  const cur = (await db.query('select status from accounting_periods where company_id = $1 and period = $2', [companyId, period])).rows[0];
  add('nao_fechado', 'Período ainda não fechado', 'bloqueio', cur?.status !== 'fechado', cur?.status === 'fechado' ? `${fmt(period)} já está fechado.` : 'Aberto.');
  add('periodo_encerrado', 'O mês já terminou', 'bloqueio', period < currentMonth(), period < currentMonth() ? `${fmt(period)} terminou em ${end.split('-').reverse().join('/')}.` : 'Só se fecha um mês depois que ele termina.');
  const first = (await db.query(`select min(competence)::text as m from journal_entries where company_id = $1`, [companyId])).rows[0].m as string | null;
  const earlier = first && first < period ? (await db.query(`select to_char(g, 'MM/YYYY') as m from generate_series($2::date, ($3::date - interval '1 month')::date, interval '1 month') g
      where not exists (select 1 from accounting_periods p where p.company_id = $1 and p.period = g::date and p.status = 'fechado') order by g`, [companyId, first, period])).rows.map((x) => x.m as string) : [];
  add('sequencia', 'Meses anteriores já fechados', 'bloqueio', earlier.length === 0, earlier.length ? `Feche antes: ${earlier.join(', ')}.` : 'Sequência em ordem.');
  const cc = await consistencyChecks(db, companyId);
  for (const c of cc.checks) add(`cons:${c.key}`, c.label, c.key === 'stock' ? 'alerta' : 'bloqueio', c.ok, c.ok ? 'Confere (posição atual).' : `Razão ${c.ledger} × ${c.operational} (diferença ${c.diff}). ${c.note ?? ''}`.trim());
  const n = async (sql: string, p: unknown[] = []) => Number((await db.query(sql, [companyId, period, end, ...p])).rows[0].n);
  const open = await n(`select count(*) n from sales where company_id = $1 and status in ('aberto','aguardando_aprovacao') and created_at::date between $2 and $3`); add('vendas_abertas', 'Pedidos em aberto no mês', 'alerta', open === 0, open ? `${open} pedido(s) criados no mês seguem abertos ou aguardando aprovação.` : 'Nenhum.');
  const rec = await n(`select count(*) n from bank_statement_lines where company_id = $1 and status = 'pendente' and line_date between $2 and $3`); add('conciliacao', 'Extrato bancário conciliado', 'alerta', rec === 0, rec ? `${rec} linha(s) de extrato do mês sem conciliar.` : 'Tudo conciliado.');
  const nf = await n(`select count(*) n from sales s where s.company_id = $1 and s.status = 'concluida' and s.confirmed_at::date between $2 and $3 and not exists (select 1 from fiscal_documents f where f.sale_id = s.id and f.kind = 'venda' and f.status = 'autorizada')`);
  add('notas_fiscais', 'Vendas do mês com nota fiscal', 'alerta', nf === 0, nf ? `${nf} venda(s) concluída(s) sem nota autorizada.` : 'Todas com nota.');
  const sales = await n(`select count(*) n from sales where company_id = $1 and status = 'concluida' and confirmed_at::date between $2 and $3`);
  const das = await n(`select count(*) n from tax_obligations where company_id = $1 and competence = $2 and $3::date is not null`);
  add('das', 'DAS do mês apurado', 'alerta', sales === 0 || das > 0, sales > 0 && das === 0 ? 'Há vendas no mês e nenhuma guia/estimativa de DAS gerada (a provisão feita nas vendas não será ajustada).' : 'Em ordem.');
  const inv = await n(`select count(*) n from inventories where company_id = $1 and status = 'aberto' and $2::date is not null and $3::date is not null`); add('inventarios', 'Inventários concluídos', 'alerta', inv === 0, inv ? `${inv} inventário(s) aberto(s): ajustes ainda não lançados.` : 'Nenhum aberto.');
  const w = await n(`select count(*) n from warranty_claims where company_id = $1 and (status in ('aberta','em_analise') or defective_pending > 0) and created_at::date <= $3 and $2::date is not null`); add('garantias', 'Garantias resolvidas', 'alerta', w === 0, w ? `${w} garantia(s) em análise ou com unidade defeituosa aguardando o fornecedor.` : 'Nenhuma pendente.');
  return { period, blocking_ok: checks.filter((c) => c.level === 'bloqueio').every((c) => c.ok), warnings: checks.filter((c) => c.level === 'alerta' && !c.ok).length, checks };
}

/** Fotografia do período (para auditoria) e impressão digital dos lançamentos que o compõem. */
export async function fingerprint(db: Db, companyId: string, period: string) {
  const end = monthEnd(period);
  const rows = (await db.query(`select e.id as eid, l.account_id, l.debit, l.credit from journal_lines l join journal_entries e on e.id = l.entry_id
    where e.company_id = $1 and (e.entry_date between $2 and $3 or e.competence = $2) order by e.id, l.id`, [companyId, period, end])).rows;
  const h = createHash('sha256'); let debits = 0; const entries = new Set<string>();
  for (const r of rows) { h.update(`${r.eid}|${r.account_id}|${Number(r.debit).toFixed(2)}|${Number(r.credit).toFixed(2)}\n`); debits += Number(r.debit); entries.add(r.eid); }
  return { entries: entries.size, debits: r2(debits), checksum: h.digest('hex') };
}

export async function closePeriod(db: PoolClient, a: Auth, period: string, note: string | null) {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`period:${a.companyId}`]);
  const ck = await closingChecks(db, a.companyId, period);
  if (!ck.blocking_ok) throw new HttpError(409, `Não é possível fechar ${fmt(period)}: ${ck.checks.filter((c) => c.level === 'bloqueio' && !c.ok).map((c) => c.label).join('; ')}.`, 'closing_blocked', { checks: ck.checks });
  const end = monthEnd(period); const d = await dre(db, a.companyId, { from: period, to: end }); const bs = await balanceSheet(db, a.companyId, end); const fp = await fingerprint(db, a.companyId, period);
  const snapshot = { dre: { receita_bruta: d.summary.receita_bruta.total, receita_liquida: d.summary.receita_liquida.total, lucro_bruto: d.summary.lucro_bruto.total, resultado_operacional: d.summary.resultado_operacional.total, lucro_liquido: d.summary.lucro_liquido.total },
    balance: { ativo: bs.assets.total, passivo: bs.liabilities.total, patrimonio_liquido: bs.equity.total, equilibrado: bs.balanced }, warnings: ck.checks.filter((c) => c.level === 'alerta' && !c.ok).map((c) => ({ key: c.key, detail: c.detail })) };
  await db.query(`insert into accounting_periods (company_id, period, status, closed_by, closed_at, snapshot, entries_count, total_debits, checksum, note, reopened_by, reopened_at, reopen_reason)
    values ($1,$2,'fechado',$3,now(),$4,$5,$6,$7,$8,null,null,null) on conflict (company_id, period) do update set status = 'fechado', closed_by = excluded.closed_by, closed_at = now(), snapshot = excluded.snapshot,
      entries_count = excluded.entries_count, total_debits = excluded.total_debits, checksum = excluded.checksum, note = excluded.note`, [a.companyId, period, a.userId, JSON.stringify(snapshot), fp.entries, fp.debits, fp.checksum, note]);
  await audit(db, a, 'accounting_period', period, 'close', null, { ...snapshot, entries: fp.entries, note });
  return { period, status: 'fechado', snapshot, entries_count: fp.entries, total_debits: fp.debits, checksum: fp.checksum, warnings: snapshot.warnings };
}

export async function reopenPeriod(db: PoolClient, a: Auth, period: string, reason: string) {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`period:${a.companyId}`]);
  const p = (await db.query('select * from accounting_periods where company_id = $1 and period = $2', [a.companyId, period])).rows[0]; if (!p || p.status !== 'fechado') throw new HttpError(409, `${fmt(period)} não está fechado.`);
  const later = (await db.query(`select to_char(period,'MM/YYYY') as m from accounting_periods where company_id = $1 and period > $2 and status = 'fechado' order by period`, [a.companyId, period])).rows.map((x) => x.m);
  if (later.length) throw new HttpError(409, `Reabra primeiro os períodos mais recentes: ${later.join(', ')}.`, 'reopen_order');
  await db.query(`update accounting_periods set status = 'aberto', reopened_by = $3, reopened_at = now(), reopen_reason = $4 where company_id = $1 and period = $2`, [a.companyId, period, a.userId, reason]);
  await audit(db, a, 'accounting_period', period, 'reopen', { status: 'fechado', checksum: p.checksum }, { status: 'aberto', reason });
  return { period, status: 'aberto' };
}
export { prevMonth };
