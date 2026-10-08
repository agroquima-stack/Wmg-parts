import type { PoolClient } from 'pg';
import { pool, type Db } from './db.js';
import { HttpError, type Auth } from './auth.js';
import { audit } from './audit.js';
import { getPricingParams, resolvePrice } from './pricing.js';
import { applyMovement } from './stock.js';
import { autoSettleSaleReceivable, categoryId } from './finance.js';
import { postSale, postSaleCancel } from './accounting.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
export const SALE_TYPES = ['balcao', 'atacado', 'b2b', 'recorrente', 'externo', 'online'] as const;
export const METHODS = ['dinheiro', 'pix', 'cartao_debito', 'cartao_credito', 'boleto', 'crediario', 'marketplace'] as const;
const CASH = ['dinheiro', 'pix', 'cartao_debito'];

export interface ItemIn { product_id: string; qty: number; discount_pct?: number; fixed_unit_price?: number }
export interface Line {
  product_id: string; sku: string; description: string; qty: number; price_source: string; list_price: number; discount_pct: number; unit_price: number; total: number;
  unit_cost: number; margin_before_pct: number; margin_after_pct: number; min_margin_pct: number; discount_value: number;
}
export interface Violation { type: 'desconto' | 'margem_minima'; product_id: string; sku: string; message: string }

export async function nextNumber(db: Db, companyId: string, kind: string): Promise<number> {
  const r = await db.query(
    `insert into doc_counters (company_id, kind, last) values ($1,$2,1)
     on conflict (company_id, kind) do update set last = doc_counters.last + 1 returning last`, [companyId, kind]);
  return r.rows[0].last;
}

/** Pseudo-autenticação para ações sem sessão (aprovação pública de orçamento): age como o vendedor do documento. */
export async function authForUser(db: Db, userId: string, branchId: string): Promise<Auth> {
  const u = (await db.query('select u.id, u.name, u.company_id, r.name as role_name, r.id as role_id from users u join roles r on r.id = u.role_id where u.id = $1', [userId])).rows[0];
  const perms = (await db.query('select permission from role_permissions where role_id = $1', [u.role_id])).rows.map((x) => x.permission);
  return { userId: u.id, userName: u.name, companyId: u.company_id, branchId, roleName: u.role_name, permissions: new Set(perms), sessionId: '', ip: '', mustChangePassword: false };
}

/**
 * Avalia itens: preço de tabela, desconto, margem antes/depois, impacto financeiro e violações de alçada.
 * Regra de alçada: desconto acima de users.max_discount_pct, ou preço abaixo da margem/preço mínimo do produto,
 * exige aprovação de quem tem sales:approve (gestor). Quem já tem sales:approve não é barrado, mas fica registrado.
 */
export async function evaluate(db: Db, a: Auth, o: { customerId?: string | null; channel: string; items: ItemIn[] }) {
  if (!o.items.length) throw new HttpError(422, 'Informe ao menos um item.');
  if (new Set(o.items.map((i) => i.product_id)).size !== o.items.length) throw new HttpError(422, 'Produto repetido nos itens.');
  let customer: { id: string; status: string; credit_limit: string; legal_name: string } | null = null;
  if (o.customerId) {
    customer = (await db.query('select id, status, credit_limit, legal_name from customers where id = $1 and company_id = $2', [o.customerId, a.companyId])).rows[0] ?? null;
    if (!customer) throw new HttpError(422, 'Cliente inválido.');
    if (customer.status !== 'ativo') throw new HttpError(422, `Cliente ${customer.status}: venda não permitida.`);
  }
  const limit = Number((await db.query('select max_discount_pct from users where id = $1', [a.userId])).rows[0].max_discount_pct);
  const canApprove = a.permissions.has('sales:approve');
  const violations: Violation[] = []; const lines: Line[] = [];
  for (const it of o.items) {
    if (!(it.qty > 0)) throw new HttpError(422, 'Quantidade inválida.');
    const d0 = it.discount_pct ?? 0;
    if (d0 < 0 || d0 >= 100) throw new HttpError(422, 'Desconto inválido.');
    const p = (await db.query('select id, sku, description, active, cost_avg, cost_current, min_price, min_margin_pct from products where id = $1 and company_id = $2', [it.product_id, a.companyId])).rows[0];
    if (!p || !p.active) throw new HttpError(422, 'Produto inexistente ou inativo.');
    const rp = await resolvePrice(db, a.companyId, p.id, { customerId: o.customerId, qty: it.qty, channel: o.channel });
    if (rp.price <= 0) throw new HttpError(422, `Produto ${p.sku} sem preço de venda.`);
    // fixed_unit_price honra o preço combinado (ex.: orçamento aprovado); o desconto efetivo é medido contra a tabela atual
    const unit = it.fixed_unit_price != null ? r2(it.fixed_unit_price) : r2(rp.price * (1 - d0 / 100));
    const dEff = Math.max(0, r2((rp.price - unit) / rp.price * 100));
    const cost = Number(p.cost_avg) > 0 ? Number(p.cost_avg) : Number(p.cost_current);
    const marginBefore = (rp.price - cost) / rp.price * 100, marginAfter = (unit - cost) / unit * 100;
    if (dEff > limit) violations.push({ type: 'desconto', product_id: p.id, sku: p.sku, message: `${p.sku}: desconto ${dEff.toFixed(1)}% acima do limite de ${limit}% do usuário.` });
    if (marginAfter < Number(p.min_margin_pct) || (Number(p.min_price) > 0 && unit < Number(p.min_price)))
      violations.push({ type: 'margem_minima', product_id: p.id, sku: p.sku, message: `${p.sku}: margem ${marginAfter.toFixed(1)}% abaixo da mínima (${Number(p.min_margin_pct)}%).` });
    lines.push({ product_id: p.id, sku: p.sku, description: p.description, qty: it.qty, price_source: rp.source, list_price: rp.price, discount_pct: dEff, unit_price: unit,
      total: r2(unit * it.qty), unit_cost: cost, margin_before_pct: r2(marginBefore), margin_after_pct: r2(marginAfter), min_margin_pct: Number(p.min_margin_pct),
      discount_value: r2((rp.price - unit) * it.qty) });
  }
  const sum = (f: (l: Line) => number) => r2(lines.reduce((s, l) => s + f(l), 0));
  const subtotal = sum((l) => l.list_price * l.qty), total = sum((l) => l.total), cost_total = sum((l) => l.unit_cost * l.qty);
  const pr = await getPricingParams(db, a.companyId);
  const tax = r2(total * pr.tax_pct / 100);
  const warnings: string[] = [];
  if (customer) {
    const used = Number((await db.query(`select coalesce(sum(amount),0) s from receivables where company_id = $1 and customer_id = $2 and status = 'aberto'`, [a.companyId, customer.id])).rows[0].s);
    if (Number(customer.credit_limit) - used < total) warnings.push(`Limite de crédito disponível (R$ ${(Number(customer.credit_limit) - used).toFixed(2)}) menor que o total: só é possível vender a prazo com aprovação do gestor.`);
  }
  return {
    lines, violations, can_approve: canApprove, needs_approval: violations.length > 0 && !canApprove, warnings, discount_limit_pct: limit,
    totals: { subtotal, discount_total: r2(subtotal - total), total, cost_total, tax_pct: pr.tax_pct, tax_amount: tax, margin_total: r2(total - tax - cost_total),
      margin_pct: total > 0 ? r2((total - tax - cost_total) / total * 100) : 0 },
  };
}

export interface CreateSaleInput {
  branchId: string; customerId?: string | null; type: string; channel?: string; items: ItemIn[]; notes?: string | null;
  quoteId?: string | null; recurringId?: string | null; sellerId?: string;
}

/** Cria a venda (pedido): congela preços/custos, reserva estoque e, se houver violação sem aprovador, abre solicitação de aprovação. */
export async function createSale(db: PoolClient, a: Auth, i: CreateSaleInput) {
  const channel = i.channel ?? (i.type === 'online' ? 'online' : i.type === 'b2b' ? 'b2b' : i.type === 'externo' ? 'externo' : i.type === 'atacado' ? 'atacado' : 'balcao');
  const ev = await evaluate(db, a, { customerId: i.customerId, channel, items: i.items });
  const sellerId = i.sellerId ?? a.userId;
  const seller = (await db.query('select commission_pct from users where id = $1 and company_id = $2', [sellerId, a.companyId])).rows[0];
  if (!seller) throw new HttpError(422, 'Vendedor inválido.');
  const number = await nextNumber(db, a.companyId, 'sale');
  const status = ev.needs_approval ? 'aguardando_aprovacao' : 'aberto';
  const t = ev.totals;
  const sale = (await db.query(
    `insert into sales (company_id, branch_id, number, type, channel, customer_id, seller_id, status, quote_id, recurring_id, subtotal, discount_total, total, cost_total,
       tax_pct, tax_amount, margin_total, commission_pct, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning *`,
    [a.companyId, i.branchId, number, i.type, channel, i.customerId ?? null, sellerId, status, i.quoteId ?? null, i.recurringId ?? null, t.subtotal, t.discount_total, t.total,
     t.cost_total, t.tax_pct, t.tax_amount, t.margin_total, seller.commission_pct, i.notes ?? null, a.userId])).rows[0];
  for (const l of ev.lines) {
    await db.query(
      `insert into sale_items (sale_id, company_id, product_id, qty, list_price, discount_pct, unit_price, total, unit_cost) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [sale.id, a.companyId, l.product_id, l.qty, l.list_price, l.discount_pct, l.unit_price, l.total, l.unit_cost]);
    try {
      await applyMovement(db, a, { branchId: i.branchId, productId: l.product_id, type: 'reserva', qty: l.qty, from: 'disponivel', to: 'reservado', documentType: 'venda', documentRef: String(number) });
    } catch (e) {
      if (e instanceof HttpError && e.code === 'insufficient_stock') throw new HttpError(409, `Estoque insuficiente para ${l.sku} — ${l.description}.`, 'insufficient_stock', { product_id: l.product_id, branch_id: i.branchId });
      throw e;
    }
  }
  if (ev.needs_approval) {
    await db.query('insert into sale_approvals (company_id, sale_id, violations, requested_by) values ($1,$2,$3,$4)', [a.companyId, sale.id, JSON.stringify(ev.violations), a.userId]);
    await audit(db, a, 'sale', sale.id, 'approval_requested', null, { number, violations: ev.violations });
  } else if (ev.violations.length) {
    await audit(db, a, 'sale', sale.id, 'self_approved', null, { number, violations: ev.violations });
  }
  await audit(db, a, 'sale', sale.id, 'create', null, { number, type: i.type, status, total: t.total, items: ev.lines.length });
  return { ...sale, evaluation: ev };
}

export interface PaymentIn { method: (typeof METHODS)[number]; amount: number; installments?: number }

/** Conclui a venda: valida pagamentos/crédito, baixa estoque reservado, gera contas a receber e comissão. */
export async function confirmSale(db: PoolClient, a: Auth, saleId: string, payments: PaymentIn[], opts: { allowMarketplace?: boolean } = {}) {
  if (!opts.allowMarketplace && payments.some((p) => p.method === 'marketplace')) throw new HttpError(422, 'A forma "marketplace" só é usada por pedidos importados do marketplace.');
  const sale = (await db.query('select * from sales where id = $1 and company_id = $2 for update', [saleId, a.companyId])).rows[0];
  if (!sale) throw new HttpError(404, 'Venda não encontrada.');
  if (sale.status === 'aguardando_aprovacao') throw new HttpError(409, 'Venda aguardando aprovação do gestor.', 'approval_pending');
  if (sale.status !== 'aberto') throw new HttpError(409, `Venda ${sale.status}.`);
  const total = Number(sale.total);
  if (!payments.length) throw new HttpError(422, 'Informe a forma de pagamento.');
  const paid = r2(payments.reduce((s, p) => s + p.amount, 0));
  if (Math.abs(paid - total) > 0.009) throw new HttpError(422, `Pagamentos (R$ ${paid.toFixed(2)}) diferem do total (R$ ${total.toFixed(2)}).`);
  const term = sale.customer_id ? (await db.query('select payment_term_days, credit_limit from customers where id = $1', [sale.customer_id])).rows[0] : null;
  const onCredit = payments.filter((p) => ['boleto', 'crediario'].includes(p.method)).reduce((s, p) => s + p.amount, 0);
  if (onCredit > 0) {
    if (!sale.customer_id) throw new HttpError(422, 'Venda a prazo exige cliente identificado.');
    const used = Number((await db.query(`select coalesce(sum(amount),0) s from receivables where company_id = $1 and customer_id = $2 and status = 'aberto'`, [a.companyId, sale.customer_id])).rows[0].s);
    if (used + onCredit > Number(term!.credit_limit) && !a.permissions.has('sales:approve'))
      throw new HttpError(409, 'Limite de crédito excedido: a venda a prazo precisa ser concluída por um gestor.', 'credit_limit');
    if (used + onCredit > Number(term!.credit_limit)) await audit(db, a, 'sale', saleId, 'credit_limit_override', null, { used, onCredit, limit: term!.credit_limit });
  }
  const catVendas = await categoryId(db, a.companyId, 'Vendas de mercadorias');
  for (const p of payments) {
    await db.query('insert into sale_payments (sale_id, company_id, method, amount, installments) values ($1,$2,$3,$4,$5)', [saleId, a.companyId, p.method, p.amount, p.installments ?? 1]);
    const n = p.installments ?? 1; const base = Math.floor(p.amount / n * 100) / 100;
    for (let k = 1; k <= n; k++) {
      const amount = k === n ? r2(p.amount - base * (n - 1)) : base;
      const cash = CASH.includes(p.method);
      const days = cash ? 0 : (p.method === 'cartao_credito' ? 30 * k : (n === 1 && term?.payment_term_days ? term.payment_term_days : 30 * k));
      const rec = (await db.query(
        `insert into receivables (company_id, sale_id, customer_id, installment_no, installments, due_date, amount, method, status, category_id, competence, description)
         values ($1,$2,$3,$4,$5, current_date + $6::int, $7, $8, 'aberto', $9, date_trunc('month', current_date)::date, $10) returning id`,
        [a.companyId, saleId, sale.customer_id, k, n, days, amount, p.method, catVendas, `Venda nº ${sale.number}`])).rows[0];
      // à vista: baixa automática só se houver conta padrão para a forma de pagamento (senão fica em aberto p/ baixa ou conciliação)
      if (cash) await autoSettleSaleReceivable(db, a, rec.id, p.method);
    }
  }
  const items = (await db.query('select * from sale_items where sale_id = $1', [saleId])).rows;
  for (const it of items)
    await applyMovement(db, a, { branchId: sale.branch_id, productId: it.product_id, type: 'saida', qty: Number(it.qty), from: 'reservado', to: null,
      unitCost: Number(it.unit_cost), documentType: 'venda', documentRef: String(sale.number), reason: 'Venda' });
  const commission = r2(total * Number(sale.commission_pct) / 100);
  await db.query(`update sales set status = 'concluida', confirmed_at = now(), commission_amount = $2 where id = $1`, [saleId, commission]);
  await postSale(db, saleId);
  await audit(db, a, 'sale', saleId, 'confirm', { status: 'aberto' }, { status: 'concluida', total, commission, payments });
  return { id: saleId, number: sale.number, status: 'concluida', total, commission_amount: commission };
}

/** Cancela: antes de concluir só libera a reserva; concluída exige gestor, devolve ao estoque e estorna recebíveis. */
export async function cancelSale(db: PoolClient, a: Auth, saleId: string, reason: string) {
  const sale = (await db.query('select * from sales where id = $1 and company_id = $2 for update', [saleId, a.companyId])).rows[0];
  if (!sale) throw new HttpError(404, 'Venda não encontrada.');
  if (sale.status === 'cancelada') throw new HttpError(409, 'Venda já cancelada.');
  if (sale.status === 'concluida' && !a.permissions.has('sales:approve')) throw new HttpError(403, 'Cancelar venda concluída exige aprovação do gestor.');
  if (sale.status !== 'concluida' && sale.created_by !== a.userId && !a.permissions.has('sales:approve') && !a.permissions.has('sales:delete'))
    throw new HttpError(403, 'Apenas o autor ou um gestor cancela esta venda.');
  const nf = await db.query(`select number, model from fiscal_documents where sale_id = $1 and kind = 'venda' and status = 'autorizada'`, [saleId]);
  if (nf.rowCount) throw new HttpError(409, `Esta venda tem NF-e/NFC-e autorizada (nº ${nf.rows[0].number}): cancele a nota fiscal (ou emita devolução) antes de cancelar a venda.`, 'fiscal_document_active');
  const items = (await db.query('select * from sale_items where sale_id = $1', [saleId])).rows;
  const doc = { documentType: 'venda', documentRef: String(sale.number), reason: `Cancelamento: ${reason}` };
  for (const it of items) {
    const qty = Number(it.qty);
    if (sale.status === 'concluida') await applyMovement(db, a, { ...doc, branchId: sale.branch_id, productId: it.product_id, type: 'devolucao_venda', qty, from: null, to: 'disponivel' });
    else await applyMovement(db, a, { ...doc, branchId: sale.branch_id, productId: it.product_id, type: 'liberacao', qty, from: 'reservado', to: 'disponivel' });
  }
  const { refund } = sale.status === 'concluida' ? await postSaleCancel(db, saleId) : { refund: 0 };
  if (refund > 0) {
    const cust = sale.customer_id ? (await db.query('select legal_name from customers where id = $1', [sale.customer_id])).rows[0] : null;
    await db.query(`insert into payables (company_id, due_date, amount, description, category_id, competence, doc_number) values ($1, current_date, $2, $3, $4, date_trunc('month', current_date)::date, $5)`,
      [a.companyId, refund, `Restituição ao cliente${cust ? ' ' + cust.legal_name : ''} — venda nº ${sale.number}`, await categoryId(db, a.companyId, 'Restituições a clientes'), `REST-${sale.number}`]);
  }
  await db.query(`update receivables set status = case when status = 'pago' then 'estornado' else 'cancelado' end where sale_id = $1`, [saleId]);
  await db.query(`update sale_approvals set status = 'recusado', decided_by = $2, decided_at = now(), note = 'Venda cancelada' where sale_id = $1 and status = 'pendente'`, [saleId, a.userId]);
  await db.query(`update sales set status = 'cancelada', cancelled_at = now(), cancel_reason = $2 where id = $1`, [saleId, reason]);
  await audit(db, a, 'sale', saleId, 'cancel', { status: sale.status }, { status: 'cancelada', reason });
  return { id: saleId, status: 'cancelada' };
}

/** Equivalentes com disponibilidade na filial: sugestão automática quando o item procurado falta. */
export async function equivalentsWithStock(companyId: string, productId: string, branchId: string | null) {
  return (await pool.query(
    `select p.id, p.sku, p.description, p.manufacturer_code, b.name as brand_name, p.sale_price, p.cost_avg, pe.is_original,
            coalesce((select sum(qty) from stock_balances sb where sb.product_id = p.id and sb.status = 'disponivel' ${branchId ? 'and sb.branch_id = $3' : ''}), 0) as disponivel,
            case when p.sale_price > 0 then round((p.sale_price - p.cost_avg) / p.sale_price * 100, 2) end as margin_pct
       from product_equivalences me join product_equivalences pe on pe.group_id = me.group_id join products p on p.id = pe.product_id left join brands b on b.id = p.brand_id
      where me.product_id = $1 and p.company_id = $2 and p.id <> $1 and p.active order by disponivel desc, p.sale_price`,
    branchId ? [productId, companyId, branchId] : [productId, companyId])).rows;
}
