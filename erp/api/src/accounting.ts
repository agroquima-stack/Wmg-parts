import type { PoolClient } from 'pg';
import { pool, type Db } from './db.js';
import { HttpError } from './auth.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
export interface Dims { branch_id?: string | null; channel?: string | null; customer_id?: string | null; product_id?: string | null; brand_id?: string | null; category_id?: string | null; seller_id?: string | null;
  finance_category_id?: string | null; cost_center_id?: string | null; supplier_id?: string | null; bank_account_id?: string | null }
export interface PostLine { key?: string; accountId?: string; debit?: number; credit?: number; dims?: Dims; description?: string }
const DIM_COLS = ['branch_id', 'channel', 'customer_id', 'product_id', 'brand_id', 'category_id', 'seller_id', 'finance_category_id', 'cost_center_id', 'supplier_id', 'bank_account_id'] as const;

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const today = () => new Date().toISOString().slice(0, 10);
export const bankKey = (kind: string) => (kind === 'caixa' ? 'caixa' : kind === 'aplicacao' ? 'aplicacoes' : 'bancos');

async function accountMap(db: Db, companyId: string): Promise<Map<string, string>> {
  const r = await db.query('select id, system_key from ledger_accounts where company_id = $1 and system_key is not null', [companyId]);
  return new Map(r.rows.map((x) => [x.system_key, x.id]));
}

/**
 * Grava um lançamento balanceado (idempotente por ref_type + ref_id). O banco também recusa lançamentos desbalanceados.
 * Linhas zeradas são descartadas; retorna null se não sobrar nenhuma.
 */
export async function post(db: Db, companyId: string, e: { date: string; competence?: string; description: string; refType: string; refId?: string | number | null; kind?: 'sistema' | 'manual' | 'abertura'; userId?: string | null; reversalOf?: string | null; lines: PostLine[] }): Promise<string | null> {
  if (e.refId) {
    const ex = await db.query('select id from journal_entries where company_id = $1 and ref_type = $2 and ref_id = $3', [companyId, e.refType, String(e.refId)]);
    if (ex.rowCount) return null;
  }
  const keys = await accountMap(db, companyId);
  const lines = e.lines.map((l) => ({ ...l, debit: r2(l.debit ?? 0), credit: r2(l.credit ?? 0) })).filter((l) => l.debit > 0 || l.credit > 0);
  if (!lines.length) return null;
  const d = r2(lines.reduce((s, l) => s + l.debit, 0)), c = r2(lines.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(d - c) > 0.001) throw new Error(`Lançamento desbalanceado (${e.refType}): débitos ${d} ≠ créditos ${c}`);
  const entry = (await db.query(
    `insert into journal_entries (company_id, entry_date, competence, description, kind, ref_type, ref_id, reversal_of, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [companyId, e.date, monthStart(e.competence ?? e.date), e.description, e.kind ?? 'sistema', e.refType, e.refId != null ? String(e.refId) : null, e.reversalOf ?? null, e.userId ?? null])).rows[0].id as string;
  for (const l of lines) {
    const accountId = l.accountId ?? keys.get(l.key ?? '');
    if (!accountId) throw new Error(`Conta contábil não encontrada: ${l.key ?? l.accountId}`);
    const dims = l.dims ?? {};
    await db.query(`insert into journal_lines (entry_id, company_id, account_id, debit, credit, ${DIM_COLS.join(', ')}, description) values ($1,$2,$3,$4,$5,${DIM_COLS.map((_, i) => `$${i + 6}`).join(', ')},$${DIM_COLS.length + 6})`,
      [entry, companyId, accountId, l.debit, l.credit, ...DIM_COLS.map((k) => dims[k] ?? null), l.description ?? null]);
  }
  return entry;
}

const allocate = (total: number, weights: number[]): number[] => {
  const sum = weights.reduce((s, w) => s + w, 0); if (sum <= 0) return weights.map(() => 0);
  let rest = r2(total); return weights.map((w, i) => { const v = i === weights.length - 1 ? rest : r2(total * w / sum); rest = r2(rest - v); return v; });
};

// ---------------------------------------------------------------- abertura e vendas
export async function postBankOpening(db: Db, accountId: string) {
  const a = (await db.query(`select id, company_id, name, kind, opening_balance, opening_date::text as d from bank_accounts where id = $1`, [accountId])).rows[0];
  const v = Number(a?.opening_balance ?? 0); if (!a || v === 0) return;
  const dims = { bank_account_id: a.id };
  await post(db, a.company_id, { date: a.d, description: `Saldo inicial — ${a.name}`, refType: 'bank_opening', refId: a.id, kind: 'abertura',
    lines: v > 0 ? [{ key: bankKey(a.kind), debit: v, dims }, { key: 'capital', credit: v }] : [{ key: 'capital', debit: -v }, { key: bankKey(a.kind), credit: -v, dims }] });
}

async function saleItems(db: Db, saleId: string) {
  return (await db.query(`select i.total, i.qty, i.unit_cost, i.product_id, p.brand_id, p.category_id from sale_items i join products p on p.id = i.product_id where i.sale_id = $1 order by i.id`, [saleId])).rows;
}

/** Venda concluída: receita, contas a receber, CMV/estoque, provisão do DAS e comissão — por item, com dimensões. Competência = data da venda. */
export async function postSale(db: Db, saleId: string) {
  const s = (await db.query(`select s.*, s.confirmed_at::date::text as d from sales s where s.id = $1`, [saleId])).rows[0]; if (!s?.d) return;
  const items = await saleItems(db, saleId); const w = items.map((i) => Number(i.total));
  const tax = allocate(Number(s.tax_amount), w), comm = allocate(Number(s.commission_amount), w);
  const lines: PostLine[] = [];
  items.forEach((i, k) => {
    const dims: Dims = { branch_id: s.branch_id, channel: s.channel, customer_id: s.customer_id, product_id: i.product_id, brand_id: i.brand_id, category_id: i.category_id, seller_id: s.seller_id };
    const total = r2(Number(i.total)), cost = r2(Number(i.qty) * Number(i.unit_cost));
    lines.push({ key: 'contas_receber', debit: total, dims }, { key: 'receita_vendas', credit: total, dims }, { key: 'cmv', debit: cost, dims }, { key: 'estoques', credit: cost, dims },
      { key: 'impostos_vendas', debit: tax[k], dims }, { key: 'obrigacoes_trib', credit: tax[k], dims }, { key: 'desp_comissoes', debit: comm[k], dims }, { key: 'comissoes_pagar', credit: comm[k], dims });
  });
  await post(db, s.company_id, { date: s.d, description: `Venda nº ${s.number}`, refType: 'sale', refId: saleId, userId: s.created_by, lines });
}

/** Cancelamento de venda concluída: devolução (dedução da receita), retorno ao estoque, estorno de imposto e comissão; valores já recebidos viram "a restituir". */
export async function postSaleCancel(db: Db, saleId: string): Promise<{ refund: number }> {
  const s = (await db.query(`select s.*, coalesce(s.cancelled_at, now())::date::text as d from sales s where s.id = $1`, [saleId])).rows[0];
  const had = await db.query(`select 1 from journal_entries where company_id = $1 and ref_type = 'sale' and ref_id = $2`, [s.company_id, saleId]);
  if (!had.rowCount || !s.confirmed_at) return { refund: 0 };
  const items = await saleItems(db, saleId); const w = items.map((i) => Number(i.total));
  const tax = allocate(Number(s.tax_amount), w), comm = allocate(Number(s.commission_amount), w);
  const paid = (await db.query(`select coalesce(sum(st.principal),0) p, coalesce(sum(st.discount),0) d from settlements st join receivables r on r.id = st.receivable_id where r.sale_id = $1 and st.reversed_at is null`, [saleId])).rows[0];
  const total = r2(items.reduce((x, i) => x + Number(i.total), 0)); const paidP = Math.min(total, r2(Number(paid.p))), disc = r2(Number(paid.d)); const refund = r2(Math.max(0, paidP - disc));
  const lines: PostLine[] = [];
  items.forEach((i, k) => {
    const dims: Dims = { branch_id: s.branch_id, channel: s.channel, customer_id: s.customer_id, product_id: i.product_id, brand_id: i.brand_id, category_id: i.category_id, seller_id: s.seller_id };
    const cost = r2(Number(i.qty) * Number(i.unit_cost));
    lines.push({ key: 'devolucoes', debit: r2(Number(i.total)), dims }, { key: 'estoques', debit: cost, dims }, { key: 'cmv', credit: cost, dims },
      { key: 'obrigacoes_trib', debit: tax[k], dims }, { key: 'impostos_vendas', credit: tax[k], dims }, { key: 'comissoes_pagar', debit: comm[k], dims }, { key: 'desp_comissoes', credit: comm[k], dims });
  });
  const cd: Dims = { branch_id: s.branch_id, channel: s.channel, customer_id: s.customer_id };
  lines.push({ key: 'contas_receber', credit: r2(total - paidP), dims: cd }, { key: 'clientes_restituir', credit: refund, dims: cd }, { key: 'descontos_concedidos', credit: disc, dims: cd });
  await post(db, s.company_id, { date: s.d, description: `Cancelamento da venda nº ${s.number}`, refType: 'sale_cancel', refId: saleId, userId: s.created_by, lines });
  return { refund };
}

export async function postReceivableCreated(db: Db, receivableId: string) {
  const r = (await db.query(`select r.*, r.created_at::date::text as d, r.competence::text as comp from receivables r where r.id = $1`, [receivableId])).rows[0]; if (!r || r.sale_id) return;
  const acc = await categoryAccount(db, r.company_id, r.category_id, 'outras_receitas');
  await post(db, r.company_id, { date: r.d, competence: r.comp ?? r.d, description: r.description ?? 'Título a receber', refType: 'receivable', refId: receivableId,
    lines: [{ key: 'contas_receber', debit: Number(r.amount), dims: { customer_id: r.customer_id } }, { accountId: acc, credit: Number(r.amount), dims: { customer_id: r.customer_id, finance_category_id: r.category_id } }] });
}

// ---------------------------------------------------------------- baixas
async function categoryAccount(db: Db, companyId: string, categoryId: string | null, fallbackKey: string): Promise<string> {
  if (categoryId) { const c = (await db.query('select ledger_account_id from finance_categories where id = $1', [categoryId])).rows[0]; if (c?.ledger_account_id) return c.ledger_account_id; }
  return (await accountMap(db, companyId)).get(fallbackKey)!;
}
export const KIND_FALLBACK: Record<string, string> = { despesa: 'desp_adm_outras', financeira: 'desp_juros', imposto: 'desp_adm_outras', investimento: 'imobilizado', outras: 'outras_despesas', receita: 'outras_receitas', estoque: 'estoques' };

/** Em qual conta de passivo um título a pagar fica registrado (null = ainda não reconhecido: reconhece-se na criação). */
export async function payableLiability(db: Db, p: any): Promise<{ accountKey?: string; accountId?: string; recognized: boolean }> {
  if (p.receiving_id || p.kind === 'credito') return { accountKey: 'fornecedores', recognized: true };
  const cm = await db.query('select 1 from commission_closings where payable_id = $1', [p.id]); if (cm.rowCount) return { accountKey: 'comissoes_pagar', recognized: true };
  if (p.category_id) {
    const c = (await db.query(`select c.kind, a.id, a.type from finance_categories c left join ledger_accounts a on a.id = c.ledger_account_id where c.id = $1`, [p.category_id])).rows[0];
    if (c?.type === 'passivo') return { accountId: c.id, recognized: true };
  }
  return { accountKey: 'outras_pagar', recognized: false };
}

export async function postSettlement(db: Db, settlementId: string) {
  const s = (await db.query(`select s.*, s.settle_date::text as d from settlements s where s.id = $1`, [settlementId])).rows[0];
  if (!s || s.method === 'compensacao' || !s.account_id) return;
  const acc = (await db.query('select kind from bank_accounts where id = $1', [s.account_id])).rows[0]; const bank = bankKey(acc.kind);
  const principal = Number(s.principal), discount = Number(s.discount), interest = Number(s.interest), fine = Number(s.fine), fee = Number(s.fee);
  const cash = r2(principal - discount + interest + fine - (s.kind === 'receivable' ? fee : 0)); const bd: Dims = { bank_account_id: s.account_id };
  if (s.kind === 'receivable') {
    const r = (await db.query(`select r.customer_id, r.sale_id, sa.branch_id, sa.channel from receivables r left join sales sa on sa.id = r.sale_id where r.id = $1`, [s.receivable_id])).rows[0];
    const cd: Dims = { customer_id: r.customer_id, branch_id: r.branch_id, channel: r.channel };
    await post(db, s.company_id, { date: s.d, description: 'Recebimento de título', refType: 'settlement', refId: settlementId, userId: s.created_by, lines: [
      { key: bank, debit: cash, dims: { ...bd, ...cd } }, { key: 'desp_taxas_cartao', debit: fee, dims: cd }, { key: 'descontos_concedidos', debit: discount, dims: cd },
      { key: 'contas_receber', credit: principal, dims: cd }, { key: 'rec_juros', credit: interest + fine, dims: cd }] });
  } else {
    const p = (await db.query('select * from payables where id = $1', [s.payable_id])).rows[0]; const liab = await payableLiability(db, p);
    const sd: Dims = { supplier_id: p.supplier_id, cost_center_id: p.cost_center_id, finance_category_id: p.category_id };
    await post(db, s.company_id, { date: s.d, description: `Pagamento — ${p.description ?? 'título'}`, refType: 'settlement', refId: settlementId, userId: s.created_by, lines: [
      { key: liab.accountKey, accountId: liab.accountId, debit: principal, dims: sd }, { key: 'desp_juros', debit: interest + fine, dims: sd },
      { key: bank, credit: cash, dims: { ...bd, ...sd } }, { key: 'rec_descontos_obtidos', credit: discount, dims: sd }] });
  }
}

/** Estorno de baixa: lançamento inverso do original (o razão não é editado). */
export async function postSettlementReversal(db: Db, settlementId: string) {
  const s = (await db.query('select company_id from settlements where id = $1', [settlementId])).rows[0];
  const orig = (await db.query(`select id from journal_entries where company_id = $1 and ref_type = 'settlement' and ref_id = $2`, [s.company_id, settlementId])).rows[0]; if (!orig) return;
  await reverseEntry(db, s.company_id, orig.id, { refType: 'settlement_reversal', refId: settlementId, description: 'Estorno de baixa' });
}

export async function reverseEntry(db: Db, companyId: string, entryId: string, o: { refType: string; refId?: string | number | null; description: string; userId?: string | null; kind?: 'sistema' | 'manual' }) {
  const e = (await db.query('select * from journal_entries where id = $1 and company_id = $2', [entryId, companyId])).rows[0]; if (!e) throw new HttpError(404, 'Lançamento não encontrado.');
  const lines = (await db.query('select * from journal_lines where entry_id = $1', [entryId])).rows;
  return post(db, companyId, { date: today(), description: o.description, refType: o.refType, refId: o.refId ?? null, kind: o.kind ?? 'sistema', userId: o.userId, reversalOf: entryId,
    lines: lines.map((l) => ({ accountId: l.account_id, debit: Number(l.credit), credit: Number(l.debit), dims: Object.fromEntries(DIM_COLS.map((k) => [k, l[k]])) as Dims })) });
}

// ---------------------------------------------------------------- compras, devoluções, despesas
export async function postReceiving(db: Db, receivingId: string) {
  const r = (await db.query(`select r.*, r.finished_at::date::text as d from receivings r where r.id = $1`, [receivingId])).rows[0]; if (!r?.d) return;
  const items = (await db.query('select qty_nf, qty_received, unit_cost_final from receiving_items where receiving_id = $1', [receivingId])).rows;
  const diff = r2(items.reduce((s, i) => s + (Number(i.qty_nf) - Number(i.qty_received ?? 0)) * Number(i.unit_cost_final ?? 0), 0)); const total = Number(r.total_nf); const d: Dims = { supplier_id: r.supplier_id, branch_id: r.branch_id };
  await post(db, r.company_id, { date: r.d, description: `Entrada de NF ${r.nf_number}`, refType: 'receiving', refId: receivingId, userId: r.finished_by, lines: [
    { key: 'estoques', debit: r2(total - diff), dims: d }, { key: 'creditos_fornecedores', debit: diff > 0 ? diff : 0, credit: diff < 0 ? -diff : 0, dims: d }, { key: 'fornecedores', credit: total, dims: d }] });
}
export async function postSupplierReturn(db: Db, returnId: string) {
  const r = (await db.query(`select r.*, r.created_at::date::text as d from supplier_returns r where r.id = $1`, [returnId])).rows[0]; if (!r) return;
  const d: Dims = { supplier_id: r.supplier_id, branch_id: r.branch_id };
  await post(db, r.company_id, { date: r.d, description: `Devolução ao fornecedor nº ${r.number}`, refType: 'supplier_return', refId: returnId, userId: r.created_by, lines: [{ key: 'fornecedores', debit: Number(r.total), dims: d }, { key: 'estoques', credit: Number(r.total), dims: d }] });
}

/** Despesa lançada no contas a pagar: reconhecida por competência (despesa/imobilizado × outras contas a pagar). Títulos de NF, comissão e DAS já foram reconhecidos em outro ponto. */
export async function postPayableCreated(db: Db, payableId: string) {
  const p = (await db.query(`select p.*, p.created_at::date::text as d, p.competence::text as comp from payables p where p.id = $1`, [payableId])).rows[0]; if (!p) return;
  const liab = await payableLiability(db, p); if (liab.recognized) return;
  const kind = p.category_id ? (await db.query('select kind from finance_categories where id = $1', [p.category_id])).rows[0]?.kind : 'despesa';
  const acc = await categoryAccount(db, p.company_id, p.category_id, KIND_FALLBACK[kind ?? 'despesa'] ?? 'desp_adm_outras'); const d: Dims = { supplier_id: p.supplier_id, cost_center_id: p.cost_center_id, finance_category_id: p.category_id };
  await post(db, p.company_id, { date: p.d, competence: p.comp ?? p.d, description: p.description ?? 'Despesa', refType: 'payable', refId: payableId, lines: [{ accountId: acc, debit: Number(p.amount), dims: d }, { key: 'outras_pagar', credit: Number(p.amount), dims: d }] });
}

/** DAS: ajusta a provisão feita nas vendas do mês para o valor da guia (ou da estimativa) quando o título é gerado. */
export async function postTaxTrueUp(db: Db, obligationId: string) {
  const o = (await db.query(`select o.*, o.competence::text as comp, p.amount as payable_amount from tax_obligations o join payables p on p.id = o.payable_id where o.id = $1`, [obligationId])).rows[0]; if (!o) return;
  const prov = Number((await db.query(`select coalesce(sum(l.credit - l.debit),0) s from journal_lines l join journal_entries e on e.id = l.entry_id join ledger_accounts a on a.id = l.account_id
    where l.company_id = $1 and a.system_key = 'obrigacoes_trib' and e.competence = $2 and e.ref_type in ('sale','sale_cancel')`, [o.company_id, o.comp])).rows[0].s);
  const diff = r2(Number(o.payable_amount) - prov); if (Math.abs(diff) < 0.005) return;
  await post(db, o.company_id, { date: today(), competence: o.comp, description: `Ajuste da provisão do DAS ${o.comp.slice(0, 7)} ao valor da guia`, refType: 'tax_trueup', refId: obligationId,
    lines: diff > 0 ? [{ key: 'impostos_vendas', debit: diff }, { key: 'obrigacoes_trib', credit: diff }] : [{ key: 'obrigacoes_trib', debit: -diff }, { key: 'impostos_vendas', credit: -diff }] });
}

// ---------------------------------------------------------------- movimentos de conta e ajustes de estoque
export async function postMovement(db: Db, movementId: string) {
  const m = (await db.query(`select m.*, m.movement_date::text as d, a.kind as account_kind from account_movements m join bank_accounts a on a.id = m.account_id where m.id = $1`, [movementId])).rows[0];
  if (!m || m.reversed || m.ref_type === 'settlement' || ['recebimento', 'pagamento'].includes(m.kind)) return;
  const amt = Number(m.amount); const abs = Math.abs(amt); const bank = bankKey(m.account_kind); const bd: Dims = { bank_account_id: m.account_id };
  const cat = async (fallback: string) => (m.category_id ? categoryAccount(db, m.company_id, m.category_id, fallback) : (await accountMap(db, m.company_id)).get(fallback)!);
  let counter: { accountId?: string; key?: string };
  switch (m.kind) {
    case 'tarifa': counter = { accountId: await cat('desp_tarifas') }; break;
    case 'juros': counter = { accountId: await cat(amt < 0 ? 'desp_juros' : 'rec_juros') }; break;
    case 'rendimento': counter = { accountId: await cat(amt > 0 ? 'rec_rendimentos' : 'outras_despesas') }; break;
    case 'quebra_caixa': counter = { accountId: await cat(amt < 0 ? 'desp_quebra_caixa' : 'outras_receitas') }; break;
    case 'ajuste': counter = { accountId: await cat(amt > 0 ? 'outras_receitas' : 'outras_despesas') }; break;
    default: counter = { key: 'transferencias' };         // transferência, aplicação, resgate, sangria, suprimento
  }
  const cdim: Dims = { finance_category_id: m.category_id };
  await post(db, m.company_id, { date: m.d, description: m.description ?? m.kind, refType: 'movement', refId: movementId, userId: m.created_by,
    lines: amt > 0 ? [{ key: bank, debit: abs, dims: bd }, { ...counter, credit: abs, dims: cdim }] : [{ ...counter, debit: abs, dims: cdim }, { key: bank, credit: abs, dims: bd }] });
}

/** Ajustes manuais de estoque: perda/ganho de inventário, saída manual e entrada manual (saldo de abertura) — pelo custo da movimentação ou custo médio. */
export async function postStockAdjustment(db: Db, stockMovementId: number | string) {
  const m = (await db.query(`select m.*, m.created_at::date::text as d, p.cost_avg, p.cost_current, p.brand_id, p.category_id from stock_movements m join products p on p.id = m.product_id where m.id = $1`, [stockMovementId])).rows[0]; if (!m) return;
  const gain = m.to_status === 'disponivel' && !m.from_status, loss = m.from_status === 'disponivel' && !m.to_status;
  let kind: 'ganho' | 'perda' | 'abertura' | null = null;
  if (['ajuste', 'inventario'].includes(m.type)) kind = gain ? 'ganho' : loss ? 'perda' : null;
  else if (m.type === 'saida' && m.document_type !== 'venda' && loss) kind = 'perda';
  else if (m.type === 'entrada' && m.document_type !== 'NF' && gain) kind = 'abertura';
  if (!kind) return;
  const unit = m.unit_cost != null ? Number(m.unit_cost) : (Number(m.cost_avg) > 0 ? Number(m.cost_avg) : Number(m.cost_current)); const value = r2(Number(m.qty) * unit); if (value <= 0) return;
  const d: Dims = { branch_id: m.branch_id, product_id: m.product_id, brand_id: m.brand_id, category_id: m.category_id };
  const lines: PostLine[] = kind === 'perda' ? [{ key: 'perdas_estoque', debit: value, dims: d }, { key: 'estoques', credit: value, dims: d }]
    : kind === 'ganho' ? [{ key: 'estoques', debit: value, dims: d }, { key: 'perdas_estoque', credit: value, dims: d }] : [{ key: 'estoques', debit: value, dims: d }, { key: 'ajustes_abertura', credit: value, dims: d }];
  await post(db, m.company_id, { date: m.d, description: `Estoque — ${kind === 'abertura' ? 'entrada manual (saldo de abertura)' : kind === 'perda' ? 'perda/baixa manual' : 'sobra/ajuste'}${m.reason ? ': ' + m.reason : ''}`, refType: 'stock_adjustment', refId: stockMovementId, userId: m.user_id, lines });
}

// ---------------------------------------------------------------- devoluções e garantias
/** Conta criada sob demanda (empresas anteriores à Fase 11 não a têm no plano padrão). */
async function ensureWarrantyAccount(db: Db, companyId: string) {
  if ((await db.query(`select 1 from ledger_accounts where company_id = $1 and system_key = 'desp_garantias'`, [companyId])).rowCount) return;
  const code = (await db.query(`select 1 from ledger_accounts where company_id = $1 and code = '4.1.3.01'`, [companyId])).rowCount ? '4.1.3.99' : '4.1.3.01';
  await db.query(`insert into ledger_accounts (company_id, code, name, type, dre_group, system_key, is_system) values ($1,$2,'Custo de garantias (trocas e perdas)','custo','cmv','desp_garantias',true) on conflict do nothing`, [companyId, code]);
}

/** Devolução de venda: dedução da receita, retorno ao estoque pelo custo da venda, estorno proporcional de imposto/comissão; abate títulos em aberto e o restante vira "a restituir". */
export async function postSaleReturn(db: Db, returnId: string) {
  const r = (await db.query(`select r.*, r.created_at::date::text as d from sale_returns r where r.id = $1`, [returnId])).rows[0]; if (!r) return;
  const s = (await db.query('select * from sales where id = $1', [r.sale_id])).rows[0];
  const items = (await db.query(`select i.*, p.brand_id, p.category_id from sale_return_items i join products p on p.id = i.product_id where i.return_id = $1 order by i.id`, [returnId])).rows;
  const w = items.map((i) => Number(i.total)); const tax = allocate(Number(r.tax_total), w), comm = allocate(Number(r.commission_reversal), w); const lines: PostLine[] = [];
  items.forEach((i, k) => {
    const dims: Dims = { branch_id: r.branch_id, channel: s.channel, customer_id: s.customer_id, product_id: i.product_id, brand_id: i.brand_id, category_id: i.category_id, seller_id: s.seller_id };
    const cost = r2(Number(i.qty) * Number(i.unit_cost));
    lines.push({ key: 'devolucoes', debit: r2(Number(i.total)), dims }, { key: 'estoques', debit: cost, dims }, { key: 'cmv', credit: cost, dims },
      { key: 'obrigacoes_trib', debit: tax[k], dims }, { key: 'impostos_vendas', credit: tax[k], dims }, { key: 'comissoes_pagar', debit: comm[k], dims }, { key: 'desp_comissoes', credit: comm[k], dims });
  });
  const cd: Dims = { branch_id: r.branch_id, channel: s.channel, customer_id: s.customer_id };
  lines.push({ key: 'contas_receber', credit: Number(r.abated), dims: cd }, { key: 'clientes_restituir', credit: Number(r.refunded), dims: cd });
  await post(db, r.company_id, { date: r.d, description: `Devolução de venda nº ${r.number} (venda ${s.number})`, refType: 'sale_return', refId: returnId, userId: r.created_by, lines });
}

/** Troca em garantia: a unidade defeituosa entra (avariada) e a nova sai; o resultado fica em "custo de garantias" até o fornecedor responder. */
export async function postWarrantyExchange(db: Db, claimId: string, defectiveValue: number, replacementValue: number) {
  const c = (await db.query(`select *, now()::date::text as d from warranty_claims where id = $1`, [claimId])).rows[0]; if (!c) return;
  await ensureWarrantyAccount(db, c.company_id); const dims: Dims = { branch_id: c.branch_id, product_id: c.product_id, customer_id: c.customer_id };
  await post(db, c.company_id, { date: c.d, description: `Troca em garantia nº ${c.number}`, refType: 'warranty_exchange', refId: claimId, userId: c.resolved_by,
    lines: [{ key: 'estoques', debit: defectiveValue, dims }, { key: 'desp_garantias', credit: defectiveValue, dims }, { key: 'desp_garantias', debit: replacementValue, dims }, { key: 'estoques', credit: replacementValue, dims }] });
}
/** Resposta do fornecedor sobre a unidade defeituosa: crédito (abate o que devemos) ou recusa (a perda é reconhecida). */
export async function postWarrantySupplier(db: Db, claimId: string, outcome: 'credito' | 'recusado', cost: number, credit: number) {
  const c = (await db.query(`select *, now()::date::text as d from warranty_claims where id = $1`, [claimId])).rows[0]; if (!c) return;
  await ensureWarrantyAccount(db, c.company_id); const dims: Dims = { branch_id: c.branch_id, product_id: c.product_id, supplier_id: c.supplier_id };
  const diff = r2(credit - cost);
  await post(db, c.company_id, { date: c.d, description: `Garantia nº ${c.number}: ${outcome === 'credito' ? 'crédito do fornecedor' : 'fornecedor recusou'}`, refType: 'warranty_supplier', refId: claimId, userId: c.resolved_by,
    lines: outcome === 'credito' ? [{ key: 'fornecedores', debit: credit, dims }, { key: 'estoques', credit: cost, dims }, { key: 'desp_garantias', debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, dims }]
      : [{ key: 'desp_garantias', debit: cost, dims }, { key: 'estoques', credit: cost, dims }] });
}

/**
 * Reconstrói/complementa o razão a partir das operações já existentes (idempotente: só lança o que ainda não tem lançamento).
 * Serve para a implantação sobre dados anteriores e como rede de segurança.
 */
export async function syncLedger(db: Db, companyId: string) {
  const ids = async (sql: string) => (await db.query(sql, [companyId])).rows.map((r) => r.id as string);
  const counts: Record<string, number> = {}; const before = Number((await db.query('select count(*) n from journal_entries where company_id = $1', [companyId])).rows[0].n);
  for (const id of await ids('select id from bank_accounts where company_id = $1')) await postBankOpening(db, id);
  for (const id of await ids(`select id from sales where company_id = $1 and confirmed_at is not null order by confirmed_at`)) await postSale(db, id);
  for (const id of await ids(`select id from receivables where company_id = $1 and sale_id is null and status <> 'cancelado'`)) await postReceivableCreated(db, id);
  for (const id of await ids(`select id from receivings where company_id = $1 and status = 'concluido' order by finished_at`)) await postReceiving(db, id);
  for (const id of await ids('select id from supplier_returns where company_id = $1 order by created_at')) await postSupplierReturn(db, id);
  for (const id of await ids(`select id from payables where company_id = $1 and status <> 'cancelado' order by created_at`)) await postPayableCreated(db, id);
  for (const id of await ids('select id from settlements where company_id = $1 order by created_at')) await postSettlement(db, id);
  for (const id of await ids('select id from account_movements where company_id = $1 order by created_at')) await postMovement(db, id);
  for (const id of await ids(`select id::text as id from stock_movements where company_id = $1 and type in ('ajuste','inventario','saida','entrada') order by id`)) await postStockAdjustment(db, id);
  for (const id of await ids(`select id from sales where company_id = $1 and status = 'cancelada' and confirmed_at is not null`)) await postSaleCancel(db, id);
  for (const id of await ids('select id from sale_returns where company_id = $1 order by created_at')) await postSaleReturn(db, id);
  for (const id of await ids('select id from settlements where company_id = $1 and reversed_at is not null')) await postSettlementReversal(db, id);
  for (const id of await ids('select id from tax_obligations where company_id = $1 and payable_id is not null')) await postTaxTrueUp(db, id);
  counts.created = Number((await db.query('select count(*) n from journal_entries where company_id = $1', [companyId])).rows[0].n) - before;
  return counts;
}

// ---------------------------------------------------------------- relatórios
export interface DreFilters { from: string; to: string; branch_id?: string; channel?: string; customer_id?: string; category_id?: string; brand_id?: string; group_by?: string }
const SECTIONS: { key: string; label: string; groups: string[]; sign: 1 | -1 }[] = [
  { key: 'receita_bruta', label: 'RECEITA BRUTA', groups: ['receita_bruta'], sign: 1 },
  { key: 'deducoes', label: '(-) Devoluções, cancelamentos e descontos concedidos', groups: ['deducoes'], sign: -1 },
  { key: 'impostos', label: '(-) IMPOSTOS SOBRE VENDAS (Simples Nacional)', groups: ['impostos'], sign: -1 },
];

/** DRE gerencial por competência. Despesas sem dimensão (aluguel, folha...) aparecem em "Não alocado" quando há agrupamento/filtro por dimensão. */
export async function dre(db: Db, companyId: string, f: DreFilters) {
  const gb = f.group_by && f.group_by !== 'none' ? f.group_by : 'none';
  const expr: Record<string, string> = { none: `'total'`, branch: 'l.branch_id::text', channel: 'l.channel', category: 'l.category_id::text', brand: 'l.brand_id::text', customer: 'l.customer_id::text', month: `to_char(e.competence, 'YYYY-MM')` };
  if (!expr[gb]) throw new HttpError(422, 'Agrupamento inválido.');
  const p: unknown[] = [companyId, f.from, f.to]; let w = `l.company_id = $1 and e.competence between $2 and $3 and a.type in ('receita','deducao','custo','despesa','outros')`;
  for (const [k, col] of [['branch_id', 'l.branch_id'], ['channel', 'l.channel'], ['customer_id', 'l.customer_id'], ['category_id', 'l.category_id'], ['brand_id', 'l.brand_id']] as const) { const v = (f as any)[k]; if (v) { p.push(v); w += ` and ${col}::text = $${p.length}`; } }
  const rows = (await db.query(`select a.id as account_id, a.code, a.name, a.dre_group, a.type, ${expr[gb]} as grp, sum(l.credit - l.debit) as net from journal_lines l join journal_entries e on e.id = l.entry_id join ledger_accounts a on a.id = l.account_id where ${w} group by a.id, a.code, a.name, a.dre_group, a.type, 6 order by a.code`, p)).rows;
  const keys = [...new Set(rows.map((r) => r.grp ?? '∅'))].sort(); const names = new Map<string, string>([['total', 'Total'], ['∅', 'Não alocado']]);
  const resolve = async (table: string, col: string) => { const ids = keys.filter((k) => k !== '∅'); if (!ids.length) return; (await db.query(`select id::text, ${col} as n from ${table} where id::text = any($1)`, [ids])).rows.forEach((r) => names.set(r.id, r.n)); };
  if (gb === 'branch') await resolve('branches', 'name'); if (gb === 'category') await resolve('categories', 'name'); if (gb === 'brand') await resolve('brands', 'name'); if (gb === 'customer') await resolve('customers', 'legal_name');
  const cols = (keys.length ? keys : ['total']).map((k) => ({ key: k, label: names.get(k) ?? k })); const zero = () => Object.fromEntries(cols.map((c) => [c.key, 0]));
  const out: any[] = []; const sub: Record<string, Record<string, number>> = {};
  const section = (label: string, groups: string[], sign: 1 | -1, key: string, extra?: (r: any) => boolean) => {
    const accs = new Map<string, any>(); const total = zero();
    for (const r of rows.filter((x) => groups.includes(x.dre_group) && (!extra || extra(x)))) { const k = r.grp ?? '∅'; const v = r2(Number(r.net)); total[k] = r2((total[k] ?? 0) + v); const a = accs.get(r.account_id) ?? { code: r.code, label: r.name, values: zero() }; a.values[k] = r2(a.values[k] + v); accs.set(r.account_id, a); }
    sub[key] = total; out.push({ kind: 'section', key, label, values: total, level: 0 }); for (const a of accs.values()) out.push({ kind: 'account', level: 1, ...a });
  };
  const subtotal = (key: string, label: string, parts: { k: string; s: 1 | -1 }[], strong = true) => { const t = zero(); for (const c of cols) t[c.key] = r2(parts.reduce((s, pt) => s + pt.s * (sub[pt.k]?.[c.key] ?? 0), 0)); sub[key] = t; out.push({ kind: 'subtotal', key, label, values: t, level: 0, strong }); };
  const secNeg = (label: string, groups: string[], key: string) => section(label, groups, -1, key);
  section('RECEITA BRUTA', ['receita_bruta'], 1, 'receita_bruta'); section('(-) Devoluções, cancelamentos e descontos concedidos', ['deducoes'], -1, 'deducoes'); section('(-) Impostos sobre vendas (Simples Nacional)', ['impostos'], -1, 'impostos');
  subtotal('receita_liquida', '= RECEITA LÍQUIDA', [{ k: 'receita_bruta', s: 1 }, { k: 'deducoes', s: 1 }, { k: 'impostos', s: 1 }]);
  secNeg('(-) CUSTO DAS MERCADORIAS VENDIDAS (CMV)', ['cmv'], 'cmv'); subtotal('lucro_bruto', '= LUCRO BRUTO', [{ k: 'receita_liquida', s: 1 }, { k: 'cmv', s: 1 }]);
  secNeg('(-) Despesas comerciais', ['desp_comercial'], 'desp_comercial'); secNeg('(-) Despesas administrativas', ['desp_administrativa'], 'desp_administrativa'); secNeg('(-) Despesas financeiras', ['desp_financeira'], 'desp_financeira'); section('(+) Receitas financeiras', ['rec_financeira'], 1, 'rec_financeira');
  subtotal('resultado_operacional', '= RESULTADO OPERACIONAL', [{ k: 'lucro_bruto', s: 1 }, { k: 'desp_comercial', s: 1 }, { k: 'desp_administrativa', s: 1 }, { k: 'desp_financeira', s: 1 }, { k: 'rec_financeira', s: 1 }]);
  section('(+/-) Outros resultados', ['outros'], 1, 'outros');
  subtotal('lucro_liquido', '= LUCRO LÍQUIDO', [{ k: 'resultado_operacional', s: 1 }, { k: 'outros', s: 1 }]);
  void SECTIONS;
  const base = Object.fromEntries(cols.map((c) => [c.key, sub.receita_liquida[c.key]]));
  const lines = out.map((l) => ({ ...l, pct: Object.fromEntries(cols.map((c) => [c.key, base[c.key] ? Math.round((l.values[c.key] / base[c.key]) * 1000) / 10 : null])) }));
  return { from: f.from, to: f.to, group_by: gb, regime: 'competência', columns: cols, lines, summary: Object.fromEntries(['receita_bruta', 'receita_liquida', 'lucro_bruto', 'resultado_operacional', 'lucro_liquido'].map((k) => [k, sub[k]])) };
}

export async function balanceSheet(db: Db, companyId: string, asOf: string) {
  const rows = (await db.query(`select a.id, a.code, a.name, a.type, a.system_key from ledger_accounts a where a.company_id = $1 and a.type in ('ativo','passivo','pl') order by a.code`, [companyId])).rows;
  const bal = (await db.query(`select a.id, coalesce(sum(l.debit),0) d, coalesce(sum(l.credit),0) c from ledger_accounts a left join (journal_lines l join journal_entries e on e.id = l.entry_id and e.entry_date <= $2) on l.account_id = a.id where a.company_id = $1 group by a.id`, [companyId, asOf])).rows;
  const bm = new Map(bal.map((b) => [b.id, b])); const val = (a: any) => { const b = bm.get(a.id) ?? { d: 0, c: 0 }; return r2(a.type === 'ativo' ? Number(b.d) - Number(b.c) : Number(b.c) - Number(b.d)); };
  const accs = rows.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, key: a.system_key, value: val(a) })).filter((a) => a.value !== 0 || ['caixa', 'bancos', 'contas_receber', 'estoques', 'fornecedores', 'capital'].includes(a.key ?? ''));
  const result = r2(Number((await db.query(`select coalesce(sum(l.credit - l.debit),0) s from journal_lines l join journal_entries e on e.id = l.entry_id join ledger_accounts a on a.id = l.account_id where l.company_id = $1 and e.entry_date <= $2 and a.type in ('receita','deducao','custo','despesa','outros')`, [companyId, asOf])).rows[0].s));
  const pick = (type: string, prefix: string) => accs.filter((a) => a.type === type && a.code.startsWith(prefix)); const sum = (xs: { value: number }[]) => r2(xs.reduce((s, x) => s + x.value, 0));
  const ac = pick('ativo', '1.1'), anc = pick('ativo', '1.2'), pc = pick('passivo', '2.1'), pnc = pick('passivo', '2.2'), pl = pick('pl', '2.3');
  const assets = r2(sum(ac) + sum(anc)), liab = r2(sum(pc) + sum(pnc)), equity = r2(sum(pl) + result);
  const other = accs.filter((a) => !ac.includes(a) && !anc.includes(a) && !pc.includes(a) && !pnc.includes(a) && !pl.includes(a));
  return { as_of: asOf, assets: { current: ac, non_current: anc, total: assets }, liabilities: { current: pc, non_current: pnc, total: liab }, equity: { accounts: pl, period_result: result, total: equity },
    total_liabilities_equity: r2(liab + equity), balanced: Math.abs(assets - liab - equity) < 0.005, difference: r2(assets - liab - equity), unclassified: other };
}

export async function trialBalance(db: Db, companyId: string, from: string, to: string) {
  const r = (await db.query(`select a.id, a.code, a.name, a.type,
      coalesce(sum(l.debit) filter (where e.entry_date < $2),0) as open_d, coalesce(sum(l.credit) filter (where e.entry_date < $2),0) as open_c,
      coalesce(sum(l.debit) filter (where e.entry_date between $2 and $3),0) as per_d, coalesce(sum(l.credit) filter (where e.entry_date between $2 and $3),0) as per_c
    from ledger_accounts a left join journal_lines l on l.account_id = a.id left join journal_entries e on e.id = l.entry_id where a.company_id = $1 group by a.id order by a.code`, [companyId, from, to])).rows;
  const items = r.map((x) => { const od = Number(x.open_d), oc = Number(x.open_c), pd = Number(x.per_d), pc = Number(x.per_c); const close = r2(od - oc + pd - pc);
    return { id: x.id, code: x.code, name: x.name, type: x.type, opening: r2(od - oc), debit: r2(pd), credit: r2(pc), closing: close }; }).filter((x) => x.opening !== 0 || x.debit !== 0 || x.credit !== 0);
  return { from, to, items, total_debit: r2(items.reduce((s, x) => s + x.debit, 0)), total_credit: r2(items.reduce((s, x) => s + x.credit, 0)), note: 'Saldos: positivo = devedor, negativo = credor.' };
}

/** Verificações de consistência: razão × subsídios (bancos, clientes, fornecedores, estoque) e identidade do balanço. */
export async function consistencyChecks(db: Db, companyId: string) {
  const checks: { key: string; label: string; ledger: number; operational: number | null; diff: number | null; ok: boolean; note?: string }[] = [];
  const add = (key: string, label: string, ledger: number, operational: number | null, note?: string, tol = 0.01) => checks.push({ key, label, ledger: r2(ledger), operational: operational == null ? null : r2(operational), diff: operational == null ? null : r2(ledger - operational), ok: operational == null ? true : Math.abs(ledger - operational) <= tol, note });
  const tb = (await db.query(`select coalesce(sum(debit),0) d, coalesce(sum(credit),0) c from journal_lines where company_id = $1`, [companyId])).rows[0];
  add('trial_balance', 'Débitos = créditos no razão', Number(tb.d), Number(tb.c));
  const acctBal = async (key: string, side: 'debit' | 'credit') => { const r = (await db.query(`select coalesce(sum(l.debit),0) d, coalesce(sum(l.credit),0) c from journal_lines l join ledger_accounts a on a.id = l.account_id where l.company_id = $1 and a.system_key = $2`, [companyId, key])).rows[0]; return side === 'debit' ? Number(r.d) - Number(r.c) : Number(r.c) - Number(r.d); };
  const banks = (await db.query(`select b.id, b.name, b.opening_balance + coalesce((select sum(amount) from account_movements m where m.account_id = b.id and not m.reversed),0) as op,
    coalesce((select sum(l.debit - l.credit) from journal_lines l where l.bank_account_id = b.id),0) as lg from bank_accounts b where b.company_id = $1 order by b.name`, [companyId])).rows;
  for (const b of banks) add(`bank:${b.id}`, `Conta ${b.name}: saldo do razão × saldo operacional`, Number(b.lg), Number(b.op));
  const ar = Number((await db.query(`select coalesce(sum(t.amount - coalesce((select sum(principal) from settlements s where s.receivable_id = t.id and s.reversed_at is null),0)),0) v from receivables t where t.company_id = $1 and t.status in ('aberto','parcial')`, [companyId])).rows[0].v);
  add('receivables', 'Contas a receber: razão × títulos em aberto', await acctBal('contas_receber', 'debit'), ar);
  const ap = Number((await db.query(`select coalesce(sum(case when t.kind = 'credito' then -1 else 1 end * (t.amount - coalesce((select sum(principal) from settlements s where s.payable_id = t.id and s.reversed_at is null),0))),0) v from payables t where t.company_id = $1 and t.status in ('aberto','parcial') and (t.receiving_id is not null or t.kind = 'credito')`, [companyId])).rows[0].v);
  add('suppliers', 'Fornecedores: razão × títulos de NF e créditos em aberto', await acctBal('fornecedores', 'credit'), ap);
  const stock = Number((await db.query(`select coalesce(sum(b.qty * p.cost_avg),0) v from stock_balances b join products p on p.id = b.product_id where b.company_id = $1 and b.status in ('disponivel','reservado','avariado','quarentena')`, [companyId])).rows[0].v);
  const stLedger = await acctBal('estoques', 'debit');
  checks.push({ key: 'stock', label: 'Estoque: razão × saldo físico valorizado ao custo médio', ledger: r2(stLedger), operational: r2(stock), diff: r2(stLedger - stock), ok: Math.abs(stLedger - stock) <= Math.max(1, stock * 0.02),
    note: 'O razão registra o custo de cada entrada/saída; o saldo físico usa o custo médio atual. Diferenças pequenas são esperadas; grandes indicam ajuste de estoque sem lançamento.' });
  const bs = await balanceSheet(db, companyId, today()); add('balance_identity', 'Ativo = Passivo + Patrimônio líquido', bs.assets.total, bs.total_liabilities_equity);
  const orphan = Number((await db.query(`select count(*) n from sales s where s.company_id = $1 and s.confirmed_at is not null and not exists (select 1 from journal_entries e where e.company_id = $1 and e.ref_type = 'sale' and e.ref_id = s.id::text)`, [companyId])).rows[0].n);
  add('sales_posted', 'Vendas concluídas sem lançamento contábil', orphan, 0, orphan ? 'Use "Sincronizar razão" para lançar as pendentes.' : undefined, 0);
  return { ok: checks.every((c) => c.ok), checks };
}
export { pool };
