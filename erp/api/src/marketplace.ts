import type { PoolClient } from 'pg';
import { pool, type Db } from './db.js';
import { HttpError, type Auth } from './auth.js';
import { audit } from './audit.js';
import { confirmSale, createSale } from './sales.js';
import { getPricingParams } from './pricing.js';
import { settle, today } from './finance.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (s: string, n: number) => new Date(Date.parse(s) + n * 86400000).toISOString().slice(0, 10);

export interface Mk { id: string; name: string; commission_pct: number; fixed_fee: number; shipping_cost: number; payout_days: number }
export const loadMk = async (db: Db, companyId: string, id: string): Promise<Mk> => {
  const m = (await db.query('select * from marketplaces where id = $1 and company_id = $2', [id, companyId])).rows[0]; if (!m) throw new HttpError(404, 'Marketplace não encontrado.');
  return { ...m, id: m.id, name: m.name, commission_pct: Number(m.commission_pct), fixed_fee: Number(m.fixed_fee), shipping_cost: Number(m.shipping_cost), payout_days: m.payout_days };
};

/** Quanto sobra de uma venda no marketplace: preço − imposto estimado − comissão − taxa fixa − frete − custo. Preço mínimo para a margem alvo. */
export async function economics(db: Db, companyId: string, mk: Mk, productId: string, price: number) {
  const p = (await db.query('select id, sku, description, cost_avg, cost_current, min_margin_pct, target_margin_pct, min_price from products where id = $1 and company_id = $2', [productId, companyId])).rows[0];
  if (!p) throw new HttpError(404, 'Produto não encontrado.');
  const pr = await getPricingParams(db, companyId); const cost = Number(p.cost_avg) > 0 ? Number(p.cost_avg) : Number(p.cost_current);
  const tax = r2(price * pr.tax_pct / 100), commission = r2(price * mk.commission_pct / 100);
  const margin = r2(price - tax - commission - mk.fixed_fee - mk.shipping_cost - cost);
  const target = Number(p.target_margin_pct) || Number(p.min_margin_pct) || 0; const minMargin = Number(p.min_margin_pct);
  const denom = 1 - (pr.tax_pct + mk.commission_pct + target) / 100; const denomMin = 1 - (pr.tax_pct + mk.commission_pct + minMargin) / 100;
  const priceFor = (d: number) => (d > 0 ? Math.ceil(((cost + mk.fixed_fee + mk.shipping_cost) / d) * 100) / 100 : null);
  const mpct = price > 0 ? r2(margin / price * 100) : 0;
  return { product: { id: p.id, sku: p.sku, description: p.description }, price, cost: r2(cost), tax_pct: pr.tax_pct, tax, commission, fixed_fee: mk.fixed_fee, shipping: mk.shipping_cost, margin, margin_pct: mpct,
    min_margin_pct: minMargin, target_margin_pct: target, below_min: mpct < minMargin, losing_money: margin < 0, price_for_min_margin: priceFor(denomMin), price_for_target_margin: priceFor(denom),
    note: 'Cálculo por pedido de 1 unidade (a taxa fixa e o frete são divididos entre os itens do pedido na prática). Imposto = alíquota efetiva configurada em Precificação.' };
}

export interface OrderItemIn { product_id: string; qty: number; unit_price?: number }
export interface OrderIn { marketplace_id: string; branch_id: string; external_order_id: string; items: OrderItemIn[]; shipping_cost?: number; commission?: number; fixed_fee?: number; buyer?: string | null; sold_at?: string }

/** Registra o pedido recebido do marketplace: venda concluída (estoque, custo, margem) + recebível com vencimento no repasse esperado. */
export async function createMarketplaceOrder(db: PoolClient, a: Auth, i: OrderIn) {
  const mk = await loadMk(db, a.companyId, i.marketplace_id);
  if (!(mk as any).active) throw new HttpError(422, 'Marketplace inativo.');
  const ext = i.external_order_id.trim(); if (!ext) throw new HttpError(422, 'Informe o nº do pedido no marketplace.');
  if ((await db.query('select 1 from marketplace_orders where marketplace_id = $1 and external_order_id = $2', [mk.id, ext])).rowCount) throw new HttpError(409, `O pedido ${ext} já foi registrado neste marketplace.`);
  const br = (await db.query('select id from branches where id = $1 and company_id = $2', [i.branch_id, a.companyId])).rows[0]; if (!br) throw new HttpError(422, 'Filial inválida.');
  const lst = new Map((await db.query('select product_id, price from marketplace_listings where marketplace_id = $1 and active', [mk.id])).rows.map((x) => [x.product_id, Number(x.price)]));
  const items = i.items.map((it) => { const price = it.unit_price ?? lst.get(it.product_id); if (price == null || !(price > 0)) throw new HttpError(422, 'Item sem preço: informe o preço do pedido ou cadastre o anúncio.'); return { product_id: it.product_id, qty: it.qty, fixed_unit_price: price }; });
  const sale = await createSale(db, a, { branchId: i.branch_id, type: 'online', channel: 'marketplace', items, notes: `Marketplace ${mk.name} — pedido ${ext}${i.buyer ? ` — comprador ${i.buyer}` : ''}` });
  if (sale.status !== 'aberto') throw new HttpError(409, 'Preço do pedido abaixo da margem mínima de algum item: o registro precisa de um gestor (aprovação de venda).', 'approval_required', { violations: sale.evaluation.violations });
  await confirmSale(db, a, sale.id, [{ method: 'marketplace', amount: Number(sale.total) }], { allowMarketplace: true });
  const gross = Number(sale.total);
  const commission = r2(i.commission ?? gross * mk.commission_pct / 100), fixed = r2(i.fixed_fee ?? mk.fixed_fee), shipping = r2(i.shipping_cost ?? mk.shipping_cost);
  if (commission + fixed + shipping > gross) throw new HttpError(422, 'Taxas e frete maiores que o valor do pedido.');
  const payout = addDays(i.sold_at ?? today(), mk.payout_days);
  await db.query(`update receivables set due_date = $2, description = $3 where sale_id = $1`, [sale.id, payout, `${/marketplace/i.test(mk.name) ? '' : 'Marketplace '}${mk.name} — pedido ${ext}`]);
  const o = (await db.query(`insert into marketplace_orders (company_id, marketplace_id, external_order_id, sale_id, gross, commission, fixed_fee, shipping_cost, expected_net, payout_date, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`, [a.companyId, mk.id, ext, sale.id, gross, commission, fixed, shipping, r2(gross - commission - fixed - shipping), payout, a.userId])).rows[0];
  await audit(db, a, 'marketplace_order', o.id, 'create', null, { marketplace: mk.name, external_order_id: ext, gross, expected_net: o.expected_net, sale: sale.number });
  return { ...o, sale_number: sale.number };
}

/** Repasse recebido: baixa o recebível pelo valor cheio, registrando as taxas reais como despesa (taxa de recebimento). */
export async function receiveMarketplaceOrder(db: PoolClient, a: Auth, id: string, i: { account_id: string; date?: string; commission?: number; fixed_fee?: number; shipping_cost?: number }) {
  const o = (await db.query('select * from marketplace_orders where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0]; if (!o) throw new HttpError(404, 'Pedido não encontrado.');
  if (o.status !== 'a_receber') throw new HttpError(409, `Pedido ${o.status.replace('_', ' ')}.`);
  const commission = r2(i.commission ?? Number(o.commission)), fixed = r2(i.fixed_fee ?? Number(o.fixed_fee)), shipping = r2(i.shipping_cost ?? Number(o.shipping_cost));
  const gross = Number(o.gross); const fee = r2(commission + fixed + shipping); if (fee > gross) throw new HttpError(422, 'Taxas maiores que o valor do pedido.');
  const date = i.date ?? today();
  const rec = (await db.query(`select id, due_date::text as d from receivables where sale_id = $1 and status in ('aberto','parcial') limit 1`, [o.sale_id])).rows[0]; if (!rec) throw new HttpError(409, 'Recebível do pedido não está em aberto.');
  // repasse atrasado não é inadimplência de cliente: o vencimento acompanha a data em que o marketplace pagou
  if (rec.d < date) { await db.query('update receivables set due_date = $2 where id = $1', [rec.id, date]); await audit(db, a, 'marketplace_order', id, 'payout_date_moved', { due: rec.d }, { due: date }); }
  const r = await settle(db, a, { kind: 'receivable', docId: rec.id, date, accountId: i.account_id, method: 'marketplace', fee, interest: 0, fine: 0, note: `Repasse ${o.external_order_id} (comissão ${commission}, taxa fixa ${fixed}, frete ${shipping})` });
  const net = r2(gross - fee);
  await db.query(`update marketplace_orders set status = 'recebido', received_at = now(), received_net = $2, commission = $3, fixed_fee = $4, shipping_cost = $5 where id = $1`, [id, net, commission, fixed, shipping]);
  await audit(db, a, 'marketplace_order', id, 'receive', { status: 'a_receber' }, { net, fee, account: i.account_id, date });
  return { id, status: 'recebido', gross, fee, net, settlement_id: r.settlement.id };
}

export async function marketplaceSummary(db: Db, companyId: string, marketplaceId: string, from: string, to: string) {
  const r = (await db.query(`select count(*) filter (where o.status <> 'cancelado')::int as orders, coalesce(sum(o.gross) filter (where o.status <> 'cancelado'),0) as gross,
      coalesce(sum(o.commission + o.fixed_fee + o.shipping_cost) filter (where o.status <> 'cancelado'),0) as fees, coalesce(sum(s.margin_total) filter (where o.status <> 'cancelado'),0) as sale_margin,
      coalesce(sum(o.expected_net) filter (where o.status = 'a_receber'),0) as pending_net, count(*) filter (where o.status = 'a_receber')::int as pending_orders,
      coalesce(sum(o.received_net) filter (where o.status = 'recebido'),0) as received_net, count(*) filter (where o.status = 'a_receber' and o.payout_date < current_date)::int as late_payouts
    from marketplace_orders o join sales s on s.id = o.sale_id where o.company_id = $1 and o.marketplace_id = $2 and o.created_at::date between $3 and $4`, [companyId, marketplaceId, from, to])).rows[0];
  const gross = Number(r.gross), fees = Number(r.fees), margin = r2(Number(r.sale_margin) - fees);
  return { orders: r.orders, gross: r2(gross), fees: r2(fees), fees_pct: gross > 0 ? r2(fees / gross * 100) : null, margin_after_fees: margin, margin_after_fees_pct: gross > 0 ? r2(margin / gross * 100) : null,
    pending_orders: r.pending_orders, pending_net: r2(Number(r.pending_net)), received_net: r2(Number(r.received_net)), late_payouts: r.late_payouts,
    note: 'Margem após taxas = margem da venda (receita − CMV − imposto estimado) − comissão − taxa fixa − frete.' };
}
export { pool };
