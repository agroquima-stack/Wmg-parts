import type { PoolClient } from 'pg';
import { pool, type Db } from './db.js';
import { HttpError, type Auth } from './auth.js';
import { audit } from './audit.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
export interface FinanceSettings { fine_pct: number; interest_monthly_pct: number; grace_days: number; default_accounts: Record<string, string> }
/** Padrão de mercado para cobrança em atraso: multa de 2% (uma vez) + juros de mora de 1% ao mês, pro rata dia, sem carência. */
export const DEFAULT_FINANCE: FinanceSettings = { fine_pct: 2, interest_monthly_pct: 1, grace_days: 0, default_accounts: {} };

export async function getFinanceSettings(db: Db, companyId: string): Promise<FinanceSettings> {
  const v = (await db.query(`select value from company_settings where company_id = $1 and key = 'finance'`, [companyId])).rows[0]?.value ?? {};
  return { ...DEFAULT_FINANCE, ...v, default_accounts: { ...(v.default_accounts ?? {}) } };
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
/** Data do Postgres (tipo date) → 'AAAA-MM-DD' sem deslocar por fuso. */
export const ymd = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
export const today = () => new Date().toISOString().slice(0, 10);

/**
 * Encargos de atraso. Multa: % sobre o saldo em aberto, cobrada uma única vez (na primeira baixa em atraso).
 * Juros: % ao mês ÷ 30 × dias, sobre o saldo em aberto, contados desde o vencimento ou da última baixa (sem dupla cobrança).
 */
export function calcCharges(o: { outstanding: number; due_date: string; on_date: string; fine_already_charged: boolean; last_settle_date: string | null }, s: FinanceSettings) {
  const late = dayDiff(o.due_date, o.on_date); if (late <= s.grace_days) return { days_late: Math.max(0, late), interest: 0, fine: 0, total: 0 };
  const from = o.last_settle_date && o.last_settle_date > o.due_date ? o.last_settle_date : o.due_date;
  const interest = r2(o.outstanding * (s.interest_monthly_pct / 100 / 30) * Math.max(0, dayDiff(from, o.on_date)));
  const fine = o.fine_already_charged ? 0 : r2(o.outstanding * s.fine_pct / 100);
  return { days_late: late, interest, fine, total: r2(interest + fine) };
}

export async function categoryId(db: Db, companyId: string, name: string): Promise<string | null> {
  return (await db.query('select id from finance_categories where company_id = $1 and name = $2', [companyId, name])).rows[0]?.id ?? null;
}

export async function accountBalance(db: Db, companyId: string, accountId: string, upTo?: string) {
  const r = await db.query(
    `select a.opening_balance + coalesce((select sum(amount) from account_movements m where m.account_id = a.id and not m.reversed ${upTo ? 'and m.movement_date <= $3' : ''}), 0) as balance
       from bank_accounts a where a.id = $1 and a.company_id = $2`, upTo ? [accountId, companyId, upTo] : [accountId, companyId]);
  return r.rows[0] ? Number(r.rows[0].balance) : null;
}

export async function loadTitle(db: Db, kind: 'receivable' | 'payable', id: string, companyId: string, lock = false) {
  const t = kind === 'receivable' ? 'receivables' : 'payables'; const col = kind === 'receivable' ? 'receivable_id' : 'payable_id';
  const r = (await db.query(
    `select t.*, t.due_date::text as due_txt, t.amount - coalesce((select sum(principal) from settlements where ${col} = t.id and reversed_at is null), 0) as outstanding,
            (select coalesce(sum(fine),0) from settlements where ${col} = t.id and reversed_at is null) as fine_paid,
            (select max(settle_date)::text from settlements where ${col} = t.id and reversed_at is null) as last_settle
       from ${t} t where t.id = $1 and t.company_id = $2 ${lock ? 'for update of t' : ''}`, [id, companyId])).rows[0];
  if (!r) throw new HttpError(404, kind === 'receivable' ? 'Título a receber não encontrado.' : 'Título a pagar não encontrado.');
  return { ...r, outstanding: Number(r.outstanding), fine_paid: Number(r.fine_paid), due_date: r.due_txt as string, last_settle: (r.last_settle as string | null) ?? null };
}

export interface SettleInput {
  kind: 'receivable' | 'payable'; docId: string; date?: string; principal?: number; discount?: number; interest?: number; fine?: number; fee?: number;
  accountId?: string | null; method?: string | null; note?: string | null; noMovement?: boolean;
}

/**
 * Baixa total ou parcial. Caixa = principal − desconto + juros + multa (− taxa, nos recebimentos). Encargos omitidos são calculados
 * pelo padrão da empresa; informar valor menor que o calculado em recebimento (perdão de encargos) exige finance:approve.
 */
export async function settle(db: PoolClient, a: Auth, i: SettleInput) {
  const doc = await loadTitle(db, i.kind, i.docId, a.companyId, true);
  if (['cancelado', 'estornado'].includes(doc.status)) throw new HttpError(409, `Título ${doc.status}.`);
  if (doc.status === 'pago' || doc.outstanding <= 0.004) throw new HttpError(409, 'Título já quitado.');
  if (doc.kind === 'credito') throw new HttpError(422, 'Crédito não é baixado: use a compensação com um título.');
  const date = i.date ?? today();
  const principal = r2(i.principal ?? doc.outstanding);
  if (!(principal > 0) || principal > doc.outstanding + 0.005) throw new HttpError(422, `Valor da baixa inválido (saldo em aberto: R$ ${doc.outstanding.toFixed(2)}).`);
  const discount = r2(i.discount ?? 0); if (discount < 0 || discount > principal) throw new HttpError(422, 'Desconto inválido.');
  if (discount > 0 && i.kind === 'receivable' && !a.permissions.has('finance:approve') && discount / principal > 0.05) throw new HttpError(403, 'Desconto de baixa acima de 5% exige aprovação (finance:approve).');
  const settings = await getFinanceSettings(db, a.companyId);
  const ch = calcCharges({ outstanding: doc.outstanding, due_date: doc.due_date, on_date: date, fine_already_charged: doc.fine_paid > 0, last_settle_date: doc.last_settle }, settings);
  // encargos proporcionais quando a baixa é parcial
  const share = principal / doc.outstanding;
  let interest = i.interest ?? r2(ch.interest * share), fine = i.fine ?? (doc.fine_paid > 0 ? 0 : ch.fine);
  if (interest < 0 || fine < 0) throw new HttpError(422, 'Encargos inválidos.');
  if (i.kind === 'receivable' && (interest < r2(ch.interest * share) - 0.01 || fine < ch.fine - 0.01)) {
    if (!a.permissions.has('finance:approve')) throw new HttpError(403, 'Perdoar juros/multa exige aprovação (finance:approve).', 'waiver_requires_approval');
    await audit(db, a, i.kind, i.docId, 'charges_waived', { computed: ch }, { interest, fine });
  }
  if (i.kind === 'payable' && !a.permissions.has('finance:edit')) throw new HttpError(403, 'Sem permissão.');
  const fee = r2(i.fee ?? 0); if (i.kind === 'payable' && fee > 0) throw new HttpError(422, 'Taxa só se aplica a recebimentos.');
  const cash = r2(principal - discount + interest + fine - fee);
  let movementId: string | null = null;
  if (!i.noMovement) {
    if (!i.accountId) throw new HttpError(422, 'Informe a conta bancária/caixa da baixa.');
    const acc = (await db.query('select id, kind from bank_accounts where id = $1 and company_id = $2 and active', [i.accountId, a.companyId])).rows[0];
    if (!acc) throw new HttpError(422, 'Conta inválida ou inativa.');
    if (cash !== 0) {
      const catName = i.kind === 'receivable' ? 'Vendas de mercadorias' : 'Outras despesas administrativas';
      movementId = (await db.query(
        `insert into account_movements (company_id, account_id, movement_date, amount, kind, description, category_id, ref_type, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,'settlement',$8) returning id`,
        [a.companyId, i.accountId, date, i.kind === 'receivable' ? cash : -cash, i.kind === 'receivable' ? 'recebimento' : 'pagamento',
         `${i.kind === 'receivable' ? 'Recebimento' : 'Pagamento'}${doc.description ? ' — ' + doc.description : ''}`, doc.category_id ?? await categoryId(db, a.companyId, catName), a.userId])).rows[0].id;
    }
  }
  const s = (await db.query(
    `insert into settlements (company_id, kind, receivable_id, payable_id, settle_date, principal, discount, interest, fine, fee, method, account_id, movement_id, note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
    [a.companyId, i.kind, i.kind === 'receivable' ? i.docId : null, i.kind === 'payable' ? i.docId : null, date, principal, discount, interest, fine, fee, i.method ?? null, i.accountId ?? null, movementId, i.note ?? null, a.userId])).rows[0];
  if (movementId) await db.query('update account_movements set ref_id = $2 where id = $1', [movementId, s.id]);
  const left = r2(doc.outstanding - principal); const table = i.kind === 'receivable' ? 'receivables' : 'payables';
  await db.query(`update ${table} set status = $2, paid_at = case when $2 = 'pago' then now() else paid_at end, paid_amount = coalesce(paid_amount, 0) + $3 where id = $1`, [i.docId, left <= 0.004 ? 'pago' : 'parcial', cash]);
  await audit(db, a, i.kind, i.docId, 'settle', { outstanding: doc.outstanding }, { principal, discount, interest, fine, fee, cash, account: i.accountId, left });
  return { settlement: s, outstanding_after: left, cash };
}

export async function reverseSettlement(db: PoolClient, a: Auth, settlementId: string) {
  const s = (await db.query('select * from settlements where id = $1 and company_id = $2 for update', [settlementId, a.companyId])).rows[0];
  if (!s) throw new HttpError(404, 'Baixa não encontrada.'); if (s.reversed_at) throw new HttpError(409, 'Baixa já estornada.');
  if (s.movement_id) {
    const m = (await db.query('select * from account_movements where id = $1 for update', [s.movement_id])).rows[0];
    const rec = await db.query(`select 1 from bank_statement_lines where movement_id = $1 and status = 'conciliado'`, [s.movement_id]);
    if (rec.rowCount) throw new HttpError(409, 'A movimentação já foi conciliada com o extrato: desfaça a conciliação antes de estornar.');
    await db.query('update account_movements set reversed = true where id = $1', [s.movement_id]);
    await db.query(`insert into account_movements (company_id, account_id, movement_date, amount, kind, description, category_id, ref_type, ref_id, reversed, created_by) values ($1,$2,current_date,$3,$4,$5,$6,'settlement',$7,true,$8)`,
      [a.companyId, m.account_id, -Number(m.amount), m.kind, `Estorno de baixa`, m.category_id, s.id, a.userId]);
  }
  await db.query('update settlements set reversed_at = now(), reversed_by = $2 where id = $1', [settlementId, a.userId]);
  const kind = s.kind as 'receivable' | 'payable'; const docId = kind === 'receivable' ? s.receivable_id : s.payable_id;
  const doc = await loadTitle(db, kind, docId, a.companyId, true);
  const status = doc.outstanding >= Number(doc.amount) - 0.004 ? 'aberto' : 'parcial';
  await db.query(`update ${kind === 'receivable' ? 'receivables' : 'payables'} set status = $2, paid_at = null, paid_amount = greatest(0, coalesce(paid_amount,0) - $3) where id = $1`, [docId, status, Number(s.principal) - Number(s.discount) + Number(s.interest) + Number(s.fine) - Number(s.fee)]);
  await audit(db, a, kind, docId, 'settlement_reversed', s, null);
  return { status };
}

/** Venda: pagamentos à vista (dinheiro/Pix/débito) já nascem baixados se houver conta padrão configurada para a forma; senão ficam em aberto para baixa/conciliação. */
export async function autoSettleSaleReceivable(db: PoolClient, a: Auth, receivableId: string, method: string): Promise<boolean> {
  const s = await getFinanceSettings(db, a.companyId); const acc = s.default_accounts[method];
  if (!acc) return false;
  const ok = await db.query('select 1 from bank_accounts where id = $1 and company_id = $2 and active', [acc, a.companyId]);
  if (!ok.rowCount) return false;
  await settle(db, a, { kind: 'receivable', docId: receivableId, accountId: acc, method, note: 'Baixa automática na venda' });
  return true;
}

export { pool };

// ---------------------------------------------------------------- Fluxo de caixa
export type Horizon = 0 | 7 | 30 | 60 | 90 | 365;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const OUT = `amount - coalesce((select sum(principal) from settlements s where s.%COL% = t.id and s.reversed_at is null), 0)`;

/** Premissas do projetado, medidas no histórico real: atraso médio e taxa de recebimento. Sem amostra suficiente → sem ajuste e confiança baixa. */
export async function collectionProfile(db: Db, companyId: string) {
  const r = (await db.query(
    `select count(*)::int as n, coalesce(sum(t.amount),0) as due_amount,
            coalesce(sum((select coalesce(sum(principal),0) from settlements s where s.receivable_id = t.id and s.reversed_at is null)),0) as settled,
            coalesce(avg((select avg(s.settle_date - t.due_date) from settlements s where s.receivable_id = t.id and s.reversed_at is null)),0) as avg_delay
       from receivables t where t.company_id = $1 and t.status not in ('cancelado','estornado') and t.due_date between current_date - 210 and current_date - 30`, [companyId])).rows[0];
  if (r.n < 10) return { delay_days: 0, rate: 1, confidence: 'baixa' as const, sample: r.n, note: 'Histórico de recebimentos insuficiente (< 10 títulos): sem ajuste por atraso/inadimplência.' };
  const rate = Math.min(1, Math.max(0.5, Number(r.settled) / Number(r.due_amount)));
  return { delay_days: Math.max(0, Math.round(Number(r.avg_delay))), rate: Math.round(rate * 1000) / 1000, confidence: (r.n >= 50 ? 'alta' : 'média') as 'alta' | 'média', sample: r.n,
    note: `Atraso médio ${Math.max(0, Math.round(Number(r.avg_delay)))} dia(s) e taxa de recebimento de ${(rate * 100).toFixed(1)}% medidos em ${r.n} títulos.` };
}

export async function cashflow(db: Db, companyId: string, horizon: Horizon, accountIds?: string[]) {
  const t0 = today(); const end = addDays(t0, Math.max(horizon, 1)); const monthly = horizon === 365;
  const accs = (await db.query(`select id, kind from bank_accounts where company_id = $1 and active and kind in ('banco','caixa') ${accountIds?.length ? 'and id = any($2)' : ''}`, accountIds?.length ? [companyId, accountIds] : [companyId])).rows;
  let opening = 0; for (const x of accs) opening += (await accountBalance(db, companyId, x.id)) ?? 0;
  const prof = await collectionProfile(db, companyId);
  const rec = (await db.query(`select due_date::text as d, ${OUT.replace('%COL%', 'receivable_id')} as o from receivables t where t.company_id = $1 and t.status in ('aberto','parcial')`, [companyId])).rows;
  const pay = (await db.query(`select due_date::text as d, ${OUT.replace('%COL%', 'payable_id')} as o, kind from payables t where t.company_id = $1 and t.status in ('aberto','parcial')`, [companyId])).rows;
  const bucket = (d: string) => (monthly ? d.slice(0, 7) : d);
  const keys: string[] = []; for (let i = 0; i <= Math.max(horizon, 0) - (horizon === 0 ? 0 : 0); i++) { const k = bucket(addDays(t0, i)); if (!keys.includes(k)) keys.push(k); }
  const mk = () => Object.fromEntries(keys.map((k) => [k, { in: 0, out: 0 }]));
  const planned = mk(), projected = mk();
  const put = (m: Record<string, { in: number; out: number }>, d: string, v: number, dir: 'in' | 'out') => { const day = d < t0 ? t0 : d; if (day > end) return; const k = bucket(day); if (m[k]) m[k][dir] += v; };
  for (const r of rec) { const v = Number(r.o); if (v <= 0) continue; put(planned, r.d, v, 'in'); put(projected, addDays(r.d < t0 ? t0 : r.d, prof.delay_days), v * prof.rate, 'in'); }
  for (const p of pay) { const v = Number(p.o); if (v <= 0) continue; const signed = p.kind === 'credito' ? -v : v; put(planned, p.d, Math.abs(signed), signed < 0 ? 'in' : 'out'); put(projected, p.d, Math.abs(signed), signed < 0 ? 'in' : 'out'); }
  let bp = opening, bj = opening; let min = { date: t0, value: opening }; let negative: string | null = opening < 0 ? t0 : null;
  const series = keys.map((k) => {
    bp += planned[k].in - planned[k].out; bj += projected[k].in - projected[k].out;
    if (bj < min.value) min = { date: k, value: Math.round(bj * 100) / 100 }; if (bj < 0 && !negative) negative = k;
    return { bucket: k, planned_in: r2(planned[k].in), planned_out: r2(planned[k].out), projected_in: r2(projected[k].in), projected_out: r2(projected[k].out), balance_planned: r2(bp), balance_projected: r2(bj) };
  });
  // realizado: mesma janela no passado
  const from = addDays(t0, -Math.max(horizon, 1));
  const real = (await db.query(
    `select ${monthly ? "to_char(movement_date,'YYYY-MM')" : "movement_date::text"} as bucket, coalesce(sum(amount) filter (where amount > 0),0) as inflow, coalesce(sum(-amount) filter (where amount < 0),0) as outflow
       from account_movements where company_id = $1 and not reversed and kind not in ('transferencia','aplicacao','resgate') and movement_date between $2 and $3
        and account_id in (select id from bank_accounts where company_id = $1 and kind in ('banco','caixa')) group by 1 order by 1`, [companyId, from, t0])).rows
    .map((x) => ({ bucket: x.bucket, inflow: r2(Number(x.inflow)), outflow: r2(Number(x.outflow)) }));
  return { horizon, bucket: monthly ? 'mês' : 'dia', opening_balance: r2(opening), series, realized: real, min_projected_balance: min, negative_from: negative,
    projection: { delay_days: prof.delay_days, collection_rate: prof.rate, confidence: prof.confidence, note: prof.note + ' O projetado é uma estimativa, não uma garantia.' } };
}
