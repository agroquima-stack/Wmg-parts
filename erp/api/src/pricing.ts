import type { Db } from './db.js';

export interface PricingParams {
  freight_pct: number; insurance_pct: number; accessory_pct: number;   // sobre o custo do produto
  tax_pct: number;               // alíquota efetiva do Simples Nacional (sobre a venda)
  commission_pct: number; card_fee_pct: number; variable_expenses_pct: number;   // sobre a venda
}
export const DEFAULT_PRICING: PricingParams = { freight_pct: 0, insurance_pct: 0, accessory_pct: 0, tax_pct: 0, commission_pct: 0, card_fee_pct: 0, variable_expenses_pct: 0 };

export async function getPricingParams(db: Db, companyId: string): Promise<PricingParams & { configured: boolean }> {
  const r = await db.query(`select value from company_settings where company_id = $1 and key = 'pricing'`, [companyId]);
  return { ...DEFAULT_PRICING, ...(r.rows[0]?.value ?? {}), configured: !!r.rowCount };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Custo de aquisição = custo + frete + seguro + despesas acessórias (percentuais sobre o custo). */
export function acquisitionCost(cost: number, p: PricingParams, extra: { freight?: number; insurance?: number; accessory?: number } = {}) {
  return cost + (extra.freight ?? cost * p.freight_pct / 100) + (extra.insurance ?? cost * p.insurance_pct / 100) + (extra.accessory ?? cost * p.accessory_pct / 100);
}
const saleCostPct = (p: PricingParams) => p.tax_pct + p.commission_pct + p.card_fee_pct + p.variable_expenses_pct;

/** Preço necessário para atingir a margem líquida `marginPct` (sobre o preço). null se inviável (≥ 100%). */
export function priceForMargin(acq: number, p: PricingParams, marginPct: number): number | null {
  const d = 1 - (saleCostPct(p) + marginPct) / 100;
  return d <= 0 ? null : r2(acq / d);
}

/** "Se eu vender por R$ X, qual será minha margem?" */
export function simulate(cost: number, price: number, p: PricingParams, opts: { margin_pct?: number; min_margin_pct?: number; freight?: number; insurance?: number; accessory?: number } = {}) {
  const acq = acquisitionCost(cost, p, opts);
  const taxes = price * p.tax_pct / 100, commission = price * p.commission_pct / 100, card = price * p.card_fee_pct / 100, variable = price * p.variable_expenses_pct / 100;
  const real = acq + taxes + commission + card + variable;        // custo real = aquisição + custos que variam com a venda
  const profit = price - real;
  return {
    acquisition_cost: r2(acq), real_cost: r2(real), taxes: r2(taxes), commission: r2(commission), card_fee: r2(card), variable_expenses: r2(variable),
    profit: r2(profit), margin_pct: price > 0 ? r2(profit / price * 100) : null, markup_pct: acq > 0 ? r2((price / acq - 1) * 100) : null,
    suggested_price: opts.margin_pct != null ? priceForMargin(acq, p, opts.margin_pct) : null,
    min_price: opts.min_margin_pct != null ? priceForMargin(acq, p, opts.min_margin_pct) : null,
  };
}

export interface ResolvedPrice { price: number; list_price: number; source: string }

/**
 * Preço de venda de um produto para (cliente, quantidade, canal).
 * 1) base = preço de varejo; 2) melhor regra da tabela do cliente (especificidade: cliente > produto > marca > categoria > geral,
 *    depois maior quantidade mínima); 3) promoções vigentes só podem baixar o preço.
 */
export async function resolvePrice(db: Db, companyId: string, productId: string, o: { customerId?: string | null; qty?: number; channel?: string | null; tableName?: string | null }): Promise<ResolvedPrice> {
  const p = (await db.query('select sale_price, brand_id, category_id, subcategory_id from products where id = $1 and company_id = $2', [productId, companyId])).rows[0];
  if (!p) throw new Error('produto inexistente');
  const base = Number(p.sale_price);
  let table = o.tableName ?? 'varejo';
  if (!o.tableName && o.customerId) {
    const c = (await db.query('select price_table from customers where id = $1 and company_id = $2', [o.customerId, companyId])).rows[0];
    if (c) table = c.price_table;
  }
  const qty = o.qty ?? 1;
  const rules = (await db.query(
    `select r.*, t.kind from price_rules r join price_tables t on t.id = r.table_id
      where r.company_id = $1 and r.active and t.active and (t.valid_from is null or t.valid_from <= current_date) and (t.valid_to is null or t.valid_to >= current_date)
        and (t.name = $2 or t.kind = 'promocao') and r.min_qty <= $3
        and (r.customer_id is null or r.customer_id = $4) and (r.channel is null or r.channel = $5)
        and (r.scope = 'all' or (r.scope = 'product' and r.scope_id = $6) or (r.scope = 'brand' and r.scope_id = $7) or (r.scope = 'category' and r.scope_id in ($8, $9)))`,
    [companyId, table, qty, o.customerId ?? null, o.channel ?? null, productId, p.brand_id, p.category_id, p.subcategory_id])).rows;
  const spec = (r: { customer_id: string | null; scope: string }) => (r.customer_id ? 100 : 0) + ({ product: 40, brand: 30, category: 20, all: 10 } as Record<string, number>)[r.scope];
  const apply = (r: { fixed_price: string | null; adjust_pct: string | null }) => (r.fixed_price != null ? Number(r.fixed_price) : r2(base * (1 + Number(r.adjust_pct) / 100)));
  const pick = (rs: typeof rules) => rs.sort((a, b) => spec(b) - spec(a) || Number(b.min_qty) - Number(a.min_qty))[0];
  const own = pick(rules.filter((r) => r.kind !== 'promocao'));
  let price = own ? apply(own) : base; let source = own ? `tabela ${table}` : 'varejo';
  const promo = pick(rules.filter((r) => r.kind === 'promocao'));
  if (promo && apply(promo) < price) { price = apply(promo); source = 'promoção'; }
  return { price, list_price: base, source };
}
