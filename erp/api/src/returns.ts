import type { PoolClient } from 'pg';
import type { Db } from './db.js';
import { HttpError, type Auth } from './auth.js';
import { audit } from './audit.js';
import { applyMovement } from './stock.js';
import { nextNumber } from './sales.js';
import { categoryId } from './finance.js';
import { postSaleReturn, postWarrantyExchange, postWarrantySupplier } from './accounting.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const todayStr = () => new Date().toISOString().slice(0, 10);
export const DEFAULT_WARRANTY_DAYS = 90;   // CDC art. 26: 90 dias para bens duráveis (padrão; ajustável por produto)

export async function warrantyDefault(db: Db, companyId: string) {
  const v = (await db.query(`select value from company_settings where company_id = $1 and key = 'returns'`, [companyId])).rows[0]?.value;
  const d = Number(v?.default_warranty_days); return Number.isInteger(d) && d >= 0 ? d : DEFAULT_WARRANTY_DAYS;
}

export interface ReturnItemIn { sale_item_id: string; qty: number; condition: 'revenda' | 'avariado' }

/** Quanto de cada item da venda ainda pode ser devolvido. */
export async function returnable(db: Db, companyId: string, saleId: string) {
  return (await db.query(`select i.id as sale_item_id, i.product_id, p.sku, p.description, i.qty, i.unit_price, i.unit_cost, i.total,
      coalesce((select sum(ri.qty) from sale_return_items ri where ri.sale_item_id = i.id),0) as returned
    from sale_items i join products p on p.id = i.product_id where i.sale_id = $1 and i.company_id = $2 order by p.sku`, [saleId, companyId])).rows
    .map((x) => ({ ...x, qty: Number(x.qty), returned: Number(x.returned), remaining: r2(Number(x.qty) - Number(x.returned)), unit_price: Number(x.unit_price), unit_cost: Number(x.unit_cost) }));
}

/**
 * Devolução de venda concluída (total ou parcial). Estoque volta (revenda ou avariado) pelo custo da venda; títulos em aberto da venda são abatidos
 * (do último para o primeiro) e o restante já recebido vira restituição em contas a pagar. Contabilidade e comissão acompanham.
 */
export async function createSaleReturn(db: PoolClient, a: Auth, i: { sale_id: string; items: ReturnItemIn[]; reason: string; notes?: string | null; warranty_claim_id?: string | null; branch_id?: string }) {
  const sale = (await db.query('select * from sales where id = $1 and company_id = $2 for update', [i.sale_id, a.companyId])).rows[0];
  if (!sale) throw new HttpError(404, 'Venda não encontrada.');
  if (sale.status !== 'concluida') throw new HttpError(409, 'Só vendas concluídas aceitam devolução (antes disso, cancele a venda).');
  if (!i.items.length) throw new HttpError(422, 'Informe ao menos um item.');
  if (new Set(i.items.map((x) => x.sale_item_id)).size !== i.items.length) throw new HttpError(422, 'Item repetido.');
  const avail = new Map((await returnable(db, a.companyId, i.sale_id)).map((x) => [x.sale_item_id, x]));
  let total = 0, cost = 0; const rows = i.items.map((it) => {
    const x = avail.get(it.sale_item_id); if (!x) throw new HttpError(422, 'Item não pertence a esta venda.');
    if (!(it.qty > 0)) throw new HttpError(422, 'Quantidade inválida.');
    if (it.qty > x.remaining + 1e-9) throw new HttpError(422, `${x.sku}: só ${x.remaining} un. ainda podem ser devolvidas (vendidas ${x.qty}, já devolvidas ${x.returned}).`);
    const t = r2(x.unit_price * it.qty); total = r2(total + t); cost = r2(cost + x.unit_cost * it.qty); return { ...x, ...it, total: t };
  });
  const ratio = Number(sale.total) > 0 ? total / Number(sale.total) : 0;
  const tax = r2(Number(sale.tax_amount) * ratio);
  const commission = sale.commission_closing_id ? 0 : r2(Number(sale.commission_amount) * ratio);   // comissão já fechada/paga não é mexida automaticamente
  const branchId = i.branch_id ?? sale.branch_id; const number = await nextNumber(db, a.companyId, 'sale_return');
  const ret = (await db.query(`insert into sale_returns (company_id, branch_id, number, sale_id, customer_id, reason, notes, total, cost_total, tax_total, commission_reversal, warranty_claim_id, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`, [a.companyId, branchId, number, sale.id, sale.customer_id, i.reason, i.notes ?? null, total, cost, tax, commission, i.warranty_claim_id ?? null, a.userId])).rows[0];
  for (const it of rows) {
    await db.query(`insert into sale_return_items (return_id, company_id, sale_item_id, product_id, qty, unit_price, unit_cost, total, condition) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ret.id, a.companyId, it.sale_item_id, it.product_id, it.qty, it.unit_price, it.unit_cost, it.total, it.condition]);
    await applyMovement(db, a, { branchId, productId: it.product_id, type: 'devolucao_venda', qty: it.qty, from: null, to: it.condition === 'revenda' ? 'disponivel' : 'avariado', unitCost: it.unit_cost, updateCost: false,
      documentType: 'devolucao', documentRef: String(number), reason: `Devolução da venda nº ${sale.number}: ${i.reason}` });
  }
  // abatimento dos títulos em aberto (último → primeiro)
  let left = total;
  const recs = (await db.query(`select r.id, r.amount, coalesce((select sum(principal) from settlements s where s.receivable_id = r.id and s.reversed_at is null),0) as paid from receivables r
    where r.sale_id = $1 and r.status in ('aberto','parcial') order by r.installment_no desc for update`, [sale.id])).rows;
  for (const r of recs) {
    if (left <= 0.004) break; const out = r2(Number(r.amount) - Number(r.paid)); const x = Math.min(out, left); if (x <= 0) continue;
    const na = r2(Number(r.amount) - x);
    if (na <= 0.004) await db.query(`update receivables set status = 'cancelado' where id = $1`, [r.id]);
    else await db.query(`update receivables set amount = $2::numeric, status = case when $2::numeric - $3::numeric <= 0.004 then 'pago' else status end where id = $1`, [r.id, na, Number(r.paid)]);
    left = r2(left - x);
  }
  const abated = r2(total - left), refund = r2(left); let payableId: string | null = null;
  if (refund > 0) {
    const cust = sale.customer_id ? (await db.query('select legal_name from customers where id = $1', [sale.customer_id])).rows[0] : null;
    payableId = (await db.query(`insert into payables (company_id, due_date, amount, description, category_id, competence, doc_number) values ($1, current_date, $2, $3, $4, date_trunc('month', current_date)::date, $5) returning id`,
      [a.companyId, refund, `Restituição ao cliente${cust ? ' ' + cust.legal_name : ''} — devolução nº ${number}`, await categoryId(db, a.companyId, 'Restituições a clientes'), `DEVV-${number}`])).rows[0].id;
  }
  if (commission > 0) await db.query('update sales set commission_amount = commission_amount - $2 where id = $1', [sale.id, commission]);
  const fiscal = !!(await db.query(`select 1 from fiscal_documents where sale_id = $1 and kind = 'venda' and status = 'autorizada'`, [sale.id])).rowCount;
  await db.query('update sale_returns set abated = $2, refunded = $3, refund_payable_id = $4, requires_fiscal_return = $5 where id = $1', [ret.id, abated, refund, payableId, fiscal]);
  await postSaleReturn(db, ret.id);
  await audit(db, a, 'sale_return', ret.id, 'create', null, { number, sale: sale.number, total, abated, refund, items: rows.length, fiscal_pending: fiscal });
  return { ...ret, abated, refunded: refund, refund_payable_id: payableId, requires_fiscal_return: fiscal, sale_number: sale.number };
}

// ---------------------------------------------------------------- garantias
const costOf = (p: { cost_avg: unknown; cost_current: unknown }) => (Number(p.cost_avg) > 0 ? Number(p.cost_avg) : Number(p.cost_current));

export async function openClaim(db: PoolClient, a: Auth, i: { sale_item_id?: string | null; product_id?: string | null; customer_id?: string | null; qty: number; defect: string; branch_id?: string }) {
  let saleId: string | null = null, productId = i.product_id ?? null, customerId = i.customer_id ?? null, purchased: string | null = null;
  if (i.sale_item_id) {
    const x = (await db.query(`select i.id, i.product_id, i.qty, s.id as sale_id, s.customer_id, s.status, s.confirmed_at::date::text as d from sale_items i join sales s on s.id = i.sale_id where i.id = $1 and i.company_id = $2`, [i.sale_item_id, a.companyId])).rows[0];
    if (!x) throw new HttpError(404, 'Item de venda não encontrado.'); if (x.status !== 'concluida') throw new HttpError(409, 'Só itens de vendas concluídas têm garantia.');
    if (i.qty > Number(x.qty)) throw new HttpError(422, `Quantidade maior que a vendida (${Number(x.qty)}).`);
    saleId = x.sale_id; productId = x.product_id; customerId = x.customer_id; purchased = x.d;
  }
  if (!productId) throw new HttpError(422, 'Informe o item da venda ou o produto.');
  const p = (await db.query('select warranty_days from products where id = $1 and company_id = $2', [productId, a.companyId])).rows[0]; if (!p) throw new HttpError(422, 'Produto inválido.');
  const days = p.warranty_days ?? await warrantyDefault(db, a.companyId);
  const inWarranty = purchased ? Date.parse(todayStr()) <= Date.parse(purchased) + days * 86400000 : null;
  const number = await nextNumber(db, a.companyId, 'warranty');
  const c = (await db.query(`insert into warranty_claims (company_id, branch_id, number, sale_id, sale_item_id, customer_id, product_id, qty, defect, purchased_at, warranty_days, in_warranty, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`, [a.companyId, i.branch_id ?? a.branchId, number, saleId, i.sale_item_id ?? null, customerId, productId, i.qty, i.defect, purchased, days, inWarranty, a.userId])).rows[0];
  await audit(db, a, 'warranty_claim', c.id, 'create', null, { number, in_warranty: inWarranty, days });
  return c;
}

export async function resolveClaim(db: PoolClient, a: Auth, id: string, i: { resolution: 'troca' | 'reembolso' | 'reparo' | 'recusa'; note: string; goodwill?: boolean }) {
  const c = (await db.query('select * from warranty_claims where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0]; if (!c) throw new HttpError(404, 'Solicitação de garantia não encontrada.');
  if (!['aberta', 'em_analise'].includes(c.status)) throw new HttpError(409, `Solicitação já ${c.status}.`);
  if (i.resolution !== 'recusa' && c.in_warranty === false && !i.goodwill) throw new HttpError(422, `Fora do prazo de garantia (${c.warranty_days} dias, compra em ${String(c.purchased_at).slice(0, 10)}): marque "concessão comercial" para atender mesmo assim.`, 'out_of_warranty');
  const p = (await db.query('select id, cost_avg, cost_current from products where id = $1', [c.product_id])).rows[0]; const qty = Number(c.qty);
  let status = 'resolvida', returnId: string | null = null, pending = 0, defCost: number | null = null;
  if (i.resolution === 'recusa') status = 'recusada';
  else if (i.resolution === 'troca') {
    const itemCost = c.sale_item_id ? Number((await db.query('select unit_cost from sale_items where id = $1', [c.sale_item_id])).rows[0].unit_cost) : costOf(p); defCost = itemCost;
    const repCost = costOf(p); const ref = String(c.number);
    await applyMovement(db, a, { branchId: c.branch_id, productId: c.product_id, type: 'garantia_entrada', qty, from: null, to: 'avariado', unitCost: itemCost, documentType: 'garantia', documentRef: ref, reason: `Unidade defeituosa — garantia nº ${c.number}` });
    await applyMovement(db, a, { branchId: c.branch_id, productId: c.product_id, type: 'garantia_saida', qty, from: 'disponivel', to: null, unitCost: repCost, documentType: 'garantia', documentRef: ref, reason: `Unidade de reposição — garantia nº ${c.number}` });
    await db.query('update warranty_claims set resolved_by = $2 where id = $1', [id, a.userId]);
    await postWarrantyExchange(db, id, r2(itemCost * qty), r2(repCost * qty)); pending = qty;
  } else if (i.resolution === 'reembolso') {
    if (!c.sale_item_id) throw new HttpError(422, 'Reembolso exige que a garantia esteja ligada a uma venda.');
    const ret = await createSaleReturn(db, a, { sale_id: c.sale_id, items: [{ sale_item_id: c.sale_item_id, qty, condition: 'avariado' }], reason: `Garantia nº ${c.number}`, warranty_claim_id: id, branch_id: c.branch_id });
    returnId = ret.id; pending = qty; defCost = Number((await db.query('select unit_cost from sale_items where id = $1', [c.sale_item_id])).rows[0].unit_cost);
  }
  const r = await db.query(`update warranty_claims set status = $2, resolution = $3, goodwill = $4, decision_note = $5, resolved_by = $6, resolved_at = now(), return_id = $7, defective_pending = $8, defective_unit_cost = $9 where id = $1 returning *`,
    [id, status, i.resolution, !!i.goodwill, i.note, a.userId, returnId, pending, defCost]);
  await audit(db, a, 'warranty_claim', id, 'resolve', { status: c.status }, { status, resolution: i.resolution, goodwill: !!i.goodwill, note: i.note });
  return r.rows[0];
}

/** Resposta do fornecedor sobre a unidade defeituosa que está em estoque avariado. */
export async function supplierOutcome(db: PoolClient, a: Auth, id: string, i: { outcome: 'credito' | 'recusado'; supplier_id?: string | null; amount?: number }) {
  const c = (await db.query('select * from warranty_claims where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0]; if (!c) throw new HttpError(404, 'Solicitação de garantia não encontrada.');
  const pend = Number(c.defective_pending); if (pend <= 0 || c.supplier_status !== 'nenhum') throw new HttpError(409, 'Não há unidade defeituosa aguardando o fornecedor.');
  const cost = Number(c.defective_unit_cost ?? 0); const value = r2(cost * pend); let credit = 0, supplier: string | null = null;
  if (i.outcome === 'credito') {
    if (!i.supplier_id) throw new HttpError(422, 'Informe o fornecedor que concedeu o crédito.'); if (!(Number(i.amount) > 0)) throw new HttpError(422, 'Informe o valor do crédito.');
    const s = (await db.query('select id from suppliers where id = $1 and company_id = $2', [i.supplier_id, a.companyId])).rows[0]; if (!s) throw new HttpError(422, 'Fornecedor inválido.');
    supplier = s.id; credit = r2(Number(i.amount));
    await db.query(`insert into payables (company_id, supplier_id, kind, due_date, amount, description, competence) values ($1,$2,'credito', current_date, $3, $4, date_trunc('month', current_date)::date)`, [a.companyId, supplier, credit, `Crédito de garantia nº ${c.number}`]);
  }
  await applyMovement(db, a, { branchId: c.branch_id, productId: c.product_id, type: 'garantia_fornecedor', qty: pend, from: 'avariado', to: null, unitCost: cost, documentType: 'garantia', documentRef: String(c.number), reason: `Garantia nº ${c.number}: ${i.outcome === 'credito' ? 'devolvida ao fornecedor com crédito' : 'recusada pelo fornecedor (baixa da perda)'}` });
  await db.query('update warranty_claims set resolved_by = coalesce(resolved_by, $2) where id = $1', [id, a.userId]);
  await postWarrantySupplier(db, id, i.outcome, value, credit);
  const r = await db.query(`update warranty_claims set supplier_status = $2, supplier_id = $3, supplier_amount = $4, supplier_at = now(), defective_pending = 0 where id = $1 returning *`, [id, i.outcome, supplier, i.outcome === 'credito' ? credit : 0]);
  await audit(db, a, 'warranty_claim', id, 'supplier_outcome', null, { outcome: i.outcome, credit, loss_or_gain: r2(credit - value) });
  return r.rows[0];
}
