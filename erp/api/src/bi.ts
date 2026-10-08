import { pool, type Db } from './db.js';
import { HttpError } from './auth.js';
import { cashflow, collectionProfile } from './finance.js';
import { dasEstimate } from './routes/fiscal.js';
import { idleAnalysis } from './routes/stock.js';
import { suggestions } from './purchasing.js';
import { dre } from './accounting.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const div = (a: number, b: number) => (b > 0 ? a / b : null);
const pctChange = (cur: number, prev: number) => (prev > 0 ? r1(((cur - prev) / prev) * 100) : null);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s) + n * 86400000));
const monthOf = (s: string) => s.slice(0, 7) + '-01';

export type GoalKind = 'faturamento' | 'margem_bruta_pct' | 'ticket_medio' | 'giro_estoque' | 'cobertura_dias_max' | 'inadimplencia_max_pct';
/** Meta vigente: a do mês específico, senão a padrão (month nulo). Retorna null se não houver meta definida. */
export async function goalFor(db: Db, companyId: string, kind: GoalKind, scopeType: 'company' | 'seller' | 'category', scopeId: string | null, month: string): Promise<number | null> {
  const r = await db.query(`select target from goals where company_id = $1 and kind = $2 and scope_type = $3 and scope_id is not distinct from $4::uuid and (month = $5 or month is null) order by month nulls last limit 1`, [companyId, kind, scopeType, scopeId, month]);
  return r.rows[0] ? Number(r.rows[0].target) : null;
}
async function goalMap(db: Db, companyId: string, kind: GoalKind, scopeType: 'seller' | 'category', month: string) {
  const r = await db.query(`select distinct on (scope_id) scope_id, target from goals where company_id = $1 and kind = $2 and scope_type = $3 and (month = $4 or month is null) order by scope_id, month nulls last`, [companyId, kind, scopeType, month]);
  return new Map<string, number>(r.rows.map((x) => [x.scope_id, Number(x.target)]));
}

export interface Period { from: string; to: string; compare: 'previous' | 'year' | 'none' }
export function comparisonRange(p: Period): { from: string; to: string } | null {
  if (p.compare === 'none') return null;
  const n = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86400000) + 1;
  if (p.compare === 'previous') return { from: addDays(p.from, -n), to: addDays(p.from, -1) };
  const y = (s: string) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() - 1); return iso(d); };
  return { from: y(p.from), to: y(p.to) };
}
const bucketOf = (from: string, to: string): 'day' | 'week' | 'month' => { const n = (Date.parse(to) - Date.parse(from)) / 86400000 + 1; return n <= 62 ? 'day' : n <= 200 ? 'week' : 'month'; };
function buckets(from: string, to: string, g: 'day' | 'week' | 'month'): string[] {
  const out: string[] = []; let d = new Date(from + 'T00:00:00Z');
  if (g === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); if (g === 'month') d.setUTCDate(1);
  while (iso(d) <= to) { out.push(iso(d)); if (g === 'day') d.setUTCDate(d.getUTCDate() + 1); else if (g === 'week') d.setUTCDate(d.getUTCDate() + 7); else d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}

interface SaleFilter { branch_id?: string; channel?: string }
function salesWhere(companyId: string, from: string, to: string, f: SaleFilter, alias = 's') {
  const p: unknown[] = [companyId, from, to]; let w = `${alias}.company_id = $1 and ${alias}.status = 'concluida' and ${alias}.confirmed_at::date between $2 and $3`;
  if (f.branch_id) { p.push(f.branch_id); w += ` and ${alias}.branch_id = $${p.length}`; } if (f.channel) { p.push(f.channel); w += ` and ${alias}.channel = $${p.length}`; }
  return { w, p };
}
async function kpis(db: Db, companyId: string, from: string, to: string, f: SaleFilter) {
  const { w, p } = salesWhere(companyId, from, to, f);
  const r = (await db.query(`select count(*)::int as orders, count(distinct s.customer_id)::int as customers, coalesce(sum(s.total),0) as revenue, coalesce(sum(s.subtotal),0) as list_total, coalesce(sum(s.cost_total),0) as cost,
    coalesce(sum(s.tax_amount),0) as tax, coalesce(sum(s.margin_total),0) as net_margin, coalesce(sum(s.commission_amount),0) as commission from sales s where ${w}`, p)).rows[0];
  const revenue = Number(r.revenue), cost = Number(r.cost), gross = revenue - cost;
  return { orders: r.orders, customers: r.customers, revenue: r2(revenue), cost: r2(cost), tax: r2(Number(r.tax)), commission: r2(Number(r.commission)), gross_margin: r2(gross), gross_margin_pct: revenue > 0 ? r1(gross / revenue * 100) : null,
    net_margin: r2(Number(r.net_margin)), net_margin_pct: revenue > 0 ? r1(Number(r.net_margin) / revenue * 100) : null, ticket: r.orders ? r2(revenue / r.orders) : 0, discount_pct: Number(r.list_total) > 0 ? r1((Number(r.list_total) - revenue) / Number(r.list_total) * 100) : null };
}

/** BI comercial: KPIs com comparação, série temporal, metas e rankings (vendedor, cliente, produto, categoria, marca, canal, filial). */
export async function commercial(db: Db, companyId: string, per: Period, f: SaleFilter & { decline_pct?: number; decline_min_base?: number }) {
  const cmp = comparisonRange(per); const cur = await kpis(db, companyId, per.from, per.to, f); const prev = cmp ? await kpis(db, companyId, cmp.from, cmp.to, f) : null;
  const deltas = prev ? { revenue: pctChange(cur.revenue, prev.revenue), orders: pctChange(cur.orders, prev.orders), ticket: pctChange(cur.ticket, prev.ticket), gross_margin: pctChange(cur.gross_margin, prev.gross_margin),
    gross_margin_pct_pp: cur.gross_margin_pct != null && prev.gross_margin_pct != null ? r1(cur.gross_margin_pct - prev.gross_margin_pct) : null } : null;
  // série temporal (receita e margem) alinhada com o período de comparação
  const g = bucketOf(per.from, per.to); const trunc = g === 'day' ? 's.confirmed_at::date' : g === 'week' ? `date_trunc('week', s.confirmed_at)::date` : `date_trunc('month', s.confirmed_at)::date`;
  const series = async (from: string, to: string) => { const { w, p } = salesWhere(companyId, from, to, f); const rows = (await db.query(`select ${trunc}::text as b, sum(s.total) as revenue, sum(s.total - s.cost_total) as margin, count(*)::int as orders from sales s where ${w} group by 1`, p)).rows; return new Map(rows.map((x) => [x.b as string, x])); };
  const curS = await series(per.from, per.to); const prevS = cmp ? await series(cmp.from, cmp.to) : null; const bc = buckets(per.from, per.to, g); const bp = cmp ? buckets(cmp.from, cmp.to, g) : [];
  const timeline = bc.map((b, i) => ({ bucket: b, revenue: r2(Number(curS.get(b)?.revenue ?? 0)), margin: r2(Number(curS.get(b)?.margin ?? 0)), orders: curS.get(b)?.orders ?? 0, prev_bucket: bp[i] ?? null, prev_revenue: prevS ? r2(Number(prevS.get(bp[i])?.revenue ?? 0)) : null }));
  // metas do mês de referência (mês do fim do período)
  const month = monthOf(per.to); const gRev = await goalFor(db, companyId, 'faturamento', 'company', null, month), gMar = await goalFor(db, companyId, 'margem_bruta_pct', 'company', null, month), gTik = await goalFor(db, companyId, 'ticket_medio', 'company', null, month);
  const mtd = await kpis(db, companyId, month, per.to, f); const dim = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate(); const elapsed = Number(per.to.slice(8, 10));
  const goals = { month, revenue: gRev == null ? null : { target: gRev, achieved: mtd.revenue, pct: r1(mtd.revenue / (gRev || 1) * 100), expected_pct: r1(elapsed / dim * 100), projected: r2(mtd.revenue / elapsed * dim) },
    margin_pct: gMar == null ? null : { target: gMar, achieved: mtd.gross_margin_pct, ok: mtd.gross_margin_pct != null && mtd.gross_margin_pct >= gMar }, ticket: gTik == null ? null : { target: gTik, achieved: mtd.ticket, ok: mtd.ticket >= gTik } };
  const dims = async (sql: string, extra: unknown[] = [], range = { from: per.from, to: per.to }) => { const { w, p } = salesWhere(companyId, range.from, range.to, f); return (await db.query(sql.replace('__W__', w), [...p, ...extra])).rows; };
  const item = (group: string, join: string, name: string, limit = 15) => `select ${group} as id, ${name} as name, sum(i.total) as revenue, sum(i.total - i.qty * i.unit_cost) as margin, sum(i.qty) as qty, count(distinct s.id)::int as orders from sale_items i join sales s on s.id = i.sale_id ${join} where __W__ group by 1, 2 order by revenue desc limit ${limit}`;
  const sellerRows = await dims(`select s.seller_id as id, u.name, sum(s.total) as revenue, sum(s.total - s.cost_total) as margin, count(*)::int as orders from sales s join users u on u.id = s.seller_id where __W__ group by 1, 2 order by revenue desc`);
  const sellerGoals = await goalMap(db, companyId, 'faturamento', 'seller', month); const sellerMtd = new Map((await (async () => { const { w, p } = salesWhere(companyId, month, per.to, f); return (await db.query(`select s.seller_id, sum(s.total) as revenue from sales s where ${w} group by 1`, p)).rows; })()).map((x) => [x.seller_id, Number(x.revenue)]));
  const sellers = sellerRows.map((x) => ({ id: x.id, name: x.name, revenue: r2(Number(x.revenue)), margin: r2(Number(x.margin)), margin_pct: div(Number(x.margin), Number(x.revenue)) != null ? r1(Number(x.margin) / Number(x.revenue) * 100) : null, orders: x.orders, ticket: r2(Number(x.revenue) / x.orders),
    goal: sellerGoals.get(x.id) ?? null, goal_pct: sellerGoals.get(x.id) ? r1((sellerMtd.get(x.id) ?? 0) / sellerGoals.get(x.id)! * 100) : null }));
  const cust = await dims(`select s.customer_id as id, coalesce(c.legal_name, 'Consumidor final') as name, sum(s.total) as revenue, sum(s.total - s.cost_total) as margin, count(*)::int as orders, max(s.confirmed_at)::date::text as last_purchase from sales s left join customers c on c.id = s.customer_id where __W__ group by 1, 2 order by revenue desc limit 25`);
  const prevCust = cmp ? new Map((await dims(`select s.customer_id as id, sum(s.total) as revenue from sales s where __W__ and s.customer_id is not null group by 1`, [], cmp)).map((x) => [x.id, Number(x.revenue)])) : new Map<string, number>();
  const customers = cust.map((x) => ({ id: x.id, name: x.name, revenue: r2(Number(x.revenue)), margin: r2(Number(x.margin)), margin_pct: Number(x.revenue) > 0 ? r1(Number(x.margin) / Number(x.revenue) * 100) : null, orders: x.orders, last_purchase: x.last_purchase, prev_revenue: cmp ? r2(prevCust.get(x.id) ?? 0) : null, variation_pct: cmp ? pctChange(Number(x.revenue), prevCust.get(x.id) ?? 0) : null }));
  // clientes que reduziram as compras (base mínima evita ruído)
  const dropPct = f.decline_pct ?? 30, minBase = f.decline_min_base ?? 500; const curAll = new Map((await dims(`select s.customer_id as id, sum(s.total) as revenue from sales s where __W__ and s.customer_id is not null group by 1`)).map((x) => [x.id, Number(x.revenue)]));
  const names = new Map((await db.query('select id, legal_name from customers where company_id = $1', [companyId])).rows.map((x) => [x.id, x.legal_name]));
  const declining = cmp ? [...prevCust.entries()].filter(([id, v]) => v >= minBase && ((curAll.get(id) ?? 0) - v) / v * 100 <= -dropPct).map(([id, v]) => ({ id, name: names.get(id), prev_revenue: r2(v), revenue: r2(curAll.get(id) ?? 0), variation_pct: r1(((curAll.get(id) ?? 0) - v) / v * 100), lost: r2(v - (curAll.get(id) ?? 0)) })).sort((a, b) => b.lost - a.lost).slice(0, 15) : [];
  const mapItems = (rows: any[]) => rows.map((x) => ({ id: x.id, name: x.name, revenue: r2(Number(x.revenue)), margin: r2(Number(x.margin)), margin_pct: Number(x.revenue) > 0 ? r1(Number(x.margin) / Number(x.revenue) * 100) : null, qty: Number(x.qty), orders: x.orders }));
  const products = mapItems(await dims(item('p.id', 'join products p on p.id = i.product_id', `p.sku || ' — ' || p.description`, 20)));
  const total = Math.max(cur.revenue, 1);
  const channels = (await dims(`select s.channel as id, s.channel as name, sum(s.total) as revenue, sum(s.total - s.cost_total) as margin, count(*)::int as orders from sales s where __W__ group by 1 order by revenue desc`)).map((x) => ({ ...x, revenue: r2(Number(x.revenue)), margin: r2(Number(x.margin)), margin_pct: Number(x.revenue) > 0 ? r1(Number(x.margin) / Number(x.revenue) * 100) : null, share_pct: r1(Number(x.revenue) / total * 100) }));
  const cats = mapItems(await dims(item('coalesce(c.id::text, \'-\')', 'join products p on p.id = i.product_id left join categories c on c.id = p.category_id', `coalesce(c.name, 'Sem categoria')`, 15)));
  const brands = mapItems(await dims(item('coalesce(b.id::text, \'-\')', 'join products p on p.id = i.product_id left join brands b on b.id = p.brand_id', `coalesce(b.name, 'Sem marca')`, 15)));
  const branches = (await dims(`select s.branch_id as id, b.name, sum(s.total) as revenue, sum(s.total - s.cost_total) as margin, count(*)::int as orders from sales s join branches b on b.id = s.branch_id where __W__ group by 1, 2 order by revenue desc`)).map((x) => ({ ...x, revenue: r2(Number(x.revenue)), margin: r2(Number(x.margin)), margin_pct: Number(x.revenue) > 0 ? r1(Number(x.margin) / Number(x.revenue) * 100) : null }));
  // onde estamos perdendo margem: itens vendidos abaixo da margem mínima e maiores descontos
  const leak = (await dims(`select p.id, p.sku || ' — ' || p.description as name, p.min_margin_pct, sum(i.total) as revenue, sum(i.qty) as qty, sum(i.total - i.qty * i.unit_cost) / nullif(sum(i.total),0) * 100 as margin_pct, sum((i.list_price - i.unit_price) * i.qty) as discount_value
    from sale_items i join sales s on s.id = i.sale_id join products p on p.id = i.product_id where __W__ group by p.id having sum(i.total - i.qty * i.unit_cost) / nullif(sum(i.total),0) * 100 < p.min_margin_pct order by revenue desc limit 15`)).map((x) => ({ id: x.id, name: x.name, min_margin_pct: Number(x.min_margin_pct), margin_pct: r1(Number(x.margin_pct)), revenue: r2(Number(x.revenue)), discount_value: r2(Number(x.discount_value)) }));
  const topDiscount = (await dims(`select p.id, p.sku || ' — ' || p.description as name, sum((i.list_price - i.unit_price) * i.qty) as discount_value, sum(i.list_price * i.qty) as list_total from sale_items i join sales s on s.id = i.sale_id join products p on p.id = i.product_id where __W__ group by p.id having sum((i.list_price - i.unit_price) * i.qty) > 0 order by discount_value desc limit 10`)).map((x) => ({ id: x.id, name: x.name, discount_value: r2(Number(x.discount_value)), discount_pct: r1(Number(x.discount_value) / Number(x.list_total) * 100) }));
  return { period: per, comparison: cmp, kpis: cur, previous: prev, deltas, bucket: g, timeline, goals, sellers, customers, declining_customers: { threshold_pct: dropPct, min_base: minBase, items: declining }, products, categories: cats, brands, channels, branches,
    margin_leaks: leak, top_discounts: topDiscount, definitions: 'Margem bruta = (receita − CMV) ÷ receita, antes de impostos. Margem líquida de impostos = receita − DAS estimado − CMV.' };
}

/** BI de estoque: valor, giro, cobertura, ABC, ruptura, excesso e parado. Giro e cobertura usam o CMV dos últimos 90 dias sobre o estoque atual. */
export async function stockBi(db: Db, companyId: string, f: { branch_id?: string }) {
  const bp: unknown[] = f.branch_id ? [companyId, f.branch_id] : [companyId]; const bf = f.branch_id ? 'and b.branch_id = $2' : ''; const sf = f.branch_id ? 'and s.branch_id = $2' : '';
  const rows = (await db.query(`
    with st as (select b.product_id, sum(b.qty) filter (where b.status in ('disponivel','reservado','avariado','quarentena')) as owned, sum(b.qty) filter (where b.status = 'disponivel') as disp from stock_balances b where b.company_id = $1 ${bf} group by 1),
    sold as (select i.product_id, sum(i.qty) as q90, sum(i.total) as rev90, sum(i.qty * i.unit_cost) as cmv90 from sale_items i join sales s on s.id = i.sale_id where s.company_id = $1 and s.status = 'concluida' and s.confirmed_at >= now() - interval '90 days' ${sf} group by 1)
    select p.id, p.sku, p.description, p.cost_avg, p.sale_price, p.max_stock, p.min_stock, c.id as category_id, coalesce(c.name, 'Sem categoria') as category, coalesce(st.owned,0) as owned, coalesce(st.disp,0) as disp, coalesce(sold.q90,0) as q90, coalesce(sold.rev90,0) as rev90, coalesce(sold.cmv90,0) as cmv90
    from products p left join categories c on c.id = p.category_id left join st on st.product_id = p.id left join sold on sold.product_id = p.id where p.company_id = $1 and p.active`, bp)).rows;
  const val = (x: any) => Number(x.owned) * Number(x.cost_avg);
  const totalValue = rows.reduce((s, x) => s + val(x), 0), cmv90 = rows.reduce((s, x) => s + Number(x.cmv90), 0); const daily = cmv90 / 90;
  const turnover = totalValue > 0 ? r2(cmv90 * (365 / 90) / totalValue) : null; const coverage = daily > 0 ? r1(totalValue / daily) : null;
  const month = new Date().toISOString().slice(0, 7) + '-01'; const gTurn = await goalFor(db, companyId, 'giro_estoque', 'company', null, month), gCov = await goalFor(db, companyId, 'cobertura_dias_max', 'company', null, month);
  const catGTurn = await goalMap(db, companyId, 'giro_estoque', 'category', month), catGCov = await goalMap(db, companyId, 'cobertura_dias_max', 'category', month);
  const byCat = new Map<string, any>(); for (const x of rows) { const o = byCat.get(x.category) ?? { id: x.category_id, name: x.category, value: 0, cmv90: 0, excess: 0, skus: 0 }; o.value += val(x); o.cmv90 += Number(x.cmv90); o.skus += Number(x.owned) > 0 ? 1 : 0; if (Number(x.max_stock) > 0 && Number(x.disp) > Number(x.max_stock)) o.excess += (Number(x.disp) - Number(x.max_stock)) * Number(x.cost_avg); byCat.set(x.category, o); }
  const categories = [...byCat.values()].map((o) => { const turn = o.value > 0 ? r2(o.cmv90 * (365 / 90) / o.value) : null; const cov = o.cmv90 > 0 ? r1(o.value / (o.cmv90 / 90)) : null; const gt = catGTurn.get(o.id) ?? gTurn, gc = catGCov.get(o.id) ?? gCov;
    return { name: o.name, value: r2(o.value), share_pct: totalValue ? r1(o.value / totalValue * 100) : 0, turnover: turn, coverage_days: cov, excess_value: r2(o.excess), skus: o.skus, goal_turnover: gt, goal_coverage_max: gc, turnover_ok: gt == null || turn == null ? null : turn >= gt, coverage_ok: gc == null || cov == null ? null : cov <= gc }; }).sort((a, b) => b.value - a.value);
  // ABC por faturamento dos últimos 90 dias
  const ranked = rows.filter((x) => Number(x.rev90) > 0).sort((a, b) => Number(b.rev90) - Number(a.rev90)); const totRev = ranked.reduce((s, x) => s + Number(x.rev90), 0); const cls = new Map<string, 'A' | 'B' | 'C'>(); let cum = 0;
  for (const x of ranked) { cls.set(x.id, cum / totRev * 100 < 80 ? 'A' : cum / totRev * 100 < 95 ? 'B' : 'C'); cum += Number(x.rev90); }
  const abc = (['A', 'B', 'C', 'S'] as const).map((k) => { const xs = rows.filter((x) => (k === 'S' ? !cls.has(x.id) : cls.get(x.id) === k)); return { class: k === 'S' ? 'Sem venda (90 d)' : k, products: xs.length, stock_value: r2(xs.reduce((s, x) => s + val(x), 0)), revenue_90d: r2(xs.reduce((s, x) => s + Number(x.rev90), 0)), stock_share_pct: totalValue ? r1(xs.reduce((s, x) => s + val(x), 0) / totalValue * 100) : 0 }; });
  const stockouts = rows.filter((x) => Number(x.disp) === 0 && Number(x.q90) > 0).map((x) => ({ id: x.id, name: `${x.sku} — ${x.description}`, avg_daily: r2(Number(x.q90) / 90), est_daily_revenue_lost: r2(Number(x.q90) / 90 * Number(x.sale_price)), abc: cls.get(x.id) ?? 'C' })).sort((a, b) => b.est_daily_revenue_lost - a.est_daily_revenue_lost);
  const excess = rows.filter((x) => Number(x.owned) > 0 && (Number(x.q90) === 0 || Number(x.owned) / (Number(x.q90) / 90) > 180)).map((x) => ({ id: x.id, name: `${x.sku} — ${x.description}`, value: r2(val(x)), qty: Number(x.owned), coverage_days: Number(x.q90) > 0 ? r1(Number(x.owned) / (Number(x.q90) / 90)) : null })).sort((a, b) => b.value - a.value);
  const idle = await idleAnalysis(companyId, f.branch_id ?? null);
  return { stock_value: r2(totalValue), units: r2(rows.reduce((s, x) => s + Number(x.owned), 0)), skus_in_stock: rows.filter((x) => Number(x.owned) > 0).length, cmv_90d: r2(cmv90), turnover_annual: turnover, coverage_days: coverage,
    goals: { turnover: gTurn, coverage_max: gCov, turnover_ok: gTurn == null || turnover == null ? null : turnover >= gTurn, coverage_ok: gCov == null || coverage == null ? null : coverage <= gCov },
    categories, abc, stockouts: { count: stockouts.length, est_daily_revenue_lost: r2(stockouts.reduce((s, x) => s + x.est_daily_revenue_lost, 0)), items: stockouts.slice(0, 20) },
    excess: { count: excess.length, value: r2(excess.reduce((s, x) => s + x.value, 0)), items: excess.slice(0, 20) }, idle,
    definitions: 'Giro anual = CMV dos últimos 90 dias × (365/90) ÷ valor atual do estoque. Cobertura = valor do estoque ÷ CMV médio diário. Excesso = sem venda em 90 dias ou cobertura > 180 dias. Ruptura estimada = venda média diária × preço dos itens com venda e sem saldo.' };
}

/** BI de compras: volume por fornecedor, prazo e pontualidade, variação de preços e economia potencial. */
export async function purchasingBi(db: Db, companyId: string, per: Period) {
  const cmp = comparisonRange(per);
  const vol = async (from: string, to: string) => (await db.query(`select coalesce(sum(total_nf),0) as total, count(*)::int as nfs from receivings where company_id = $1 and status = 'concluido' and finished_at::date between $2 and $3`, [companyId, from, to])).rows[0];
  const cur = await vol(per.from, per.to); const prev = cmp ? await vol(cmp.from, cmp.to) : null;
  const sup = (await db.query(`select s.id, s.legal_name as name, count(r.id)::int as nfs, coalesce(sum(r.total_nf),0) as total, s.payment_terms_days, s.lead_time_days as lead_declared,
      avg(extract(epoch from (r.finished_at - po.approved_at)) / 86400) filter (where po.approved_at is not null) as lead_real,
      count(*) filter (where po.expected_date is not null and r.finished_at::date <= po.expected_date)::int as on_time, count(*) filter (where po.expected_date is not null)::int as with_date
    from suppliers s join receivings r on r.supplier_id = s.id and r.status = 'concluido' and r.finished_at::date between $2 and $3 left join purchase_orders po on po.id = r.po_id where s.company_id = $1 group by s.id order by total desc`, [companyId, per.from, per.to])).rows;
  const totalVol = Number(cur.total) || 1;
  const suppliers = sup.map((x) => ({ id: x.id, name: x.name, nfs: x.nfs, total: r2(Number(x.total)), share_pct: r1(Number(x.total) / totalVol * 100), payment_terms_days: x.payment_terms_days, lead_declared_days: x.lead_declared, lead_real_days: x.lead_real != null ? r1(Number(x.lead_real)) : null, on_time_pct: x.with_date ? r1(x.on_time / x.with_date * 100) : null }));
  // variação de preços: último preço no período × último preço anterior ao período, por produto/fornecedor
  const pv = (await db.query(`with cur as (select distinct on (supplier_id, product_id) supplier_id, product_id, price from supplier_prices where company_id = $1 and created_at::date between $2 and $3 order by supplier_id, product_id, created_at desc, id desc),
      base as (select distinct on (supplier_id, product_id) supplier_id, product_id, price from supplier_prices where company_id = $1 and created_at::date < $2 order by supplier_id, product_id, created_at desc, id desc)
    select s.id as supplier_id, s.legal_name as supplier, p.id as product_id, p.sku || ' — ' || p.description as product, base.price as before, cur.price as after, (cur.price - base.price) / nullif(base.price,0) * 100 as pct,
      coalesce((select sum(i.qty_received) from receiving_items i join receivings r on r.id = i.receiving_id where i.product_id = p.id and r.supplier_id = s.id and r.status = 'concluido' and r.finished_at::date between $2 and $3),0) as qty
    from cur join base on base.supplier_id = cur.supplier_id and base.product_id = cur.product_id join suppliers s on s.id = cur.supplier_id join products p on p.id = cur.product_id`, [companyId, per.from, per.to])).rows;
  const moves = pv.map((x) => ({ supplier_id: x.supplier_id, supplier: x.supplier, product_id: x.product_id, product: x.product, before: r2(Number(x.before)), after: r2(Number(x.after)), pct: r1(Number(x.pct)), impact: r2((Number(x.after) - Number(x.before)) * Number(x.qty)) }));
  const bySup = new Map<string, { supplier: string; n: number; sum: number }>(); for (const m of moves) { const o = bySup.get(m.supplier_id) ?? { supplier: m.supplier, n: 0, sum: 0 }; o.n++; o.sum += m.pct; bySup.set(m.supplier_id, o); }
  const priceIndex = [...bySup.entries()].map(([id, o]) => ({ supplier_id: id, supplier: o.supplier, products: o.n, avg_variation_pct: r1(o.sum / o.n) })).sort((a, b) => b.avg_variation_pct - a.avg_variation_pct);
  // preço médio pago × melhor preço vigente (economia potencial)
  const sav = (await db.query(`with paid as (select i.product_id, sum(i.qty_received * i.unit_price_nf) / nullif(sum(i.qty_received),0) as avg_paid, sum(i.qty_received) as qty from receiving_items i join receivings r on r.id = i.receiving_id where r.company_id = $1 and r.status = 'concluido' and r.finished_at::date between $2 and $3 and i.product_id is not null group by 1),
      best as (select product_id, min(price) as best from (select distinct on (supplier_id, product_id) supplier_id, product_id, price from supplier_prices where company_id = $1 order by supplier_id, product_id, created_at desc, id desc) x group by 1)
    select p.id, p.sku || ' — ' || p.description as name, paid.avg_paid, best.best, paid.qty, (paid.avg_paid - best.best) * paid.qty as saving from paid join best using (product_id) join products p on p.id = paid.product_id where paid.avg_paid > best.best * 1.005 order by saving desc limit 15`, [companyId, per.from, per.to])).rows.map((x) => ({ id: x.id, name: x.name, avg_paid: r2(Number(x.avg_paid)), best_price: r2(Number(x.best)), qty: Number(x.qty), potential_saving: r2(Number(x.saving)) }));
  const open = (await db.query(`select count(*)::int as n, coalesce(sum(total),0) as value, count(*) filter (where expected_date < current_date)::int as late from purchase_orders where company_id = $1 and status in ('aprovado','enviado','parcial')`, [companyId])).rows[0];
  const sug = await suggestions(companyId, null, null);
  return { period: per, comparison: cmp, total: r2(Number(cur.total)), nfs: cur.nfs, avg_nf: cur.nfs ? r2(Number(cur.total) / cur.nfs) : 0, previous_total: prev ? r2(Number(prev.total)) : null, variation_pct: prev ? pctChange(Number(cur.total), Number(prev.total)) : null,
    suppliers, price_moves: { increases: moves.filter((m) => m.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 15), decreases: moves.filter((m) => m.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, 10), by_supplier: priceIndex },
    savings: { total: r2(sav.reduce((s, x) => s + x.potential_saving, 0)), items: sav }, open_orders: { count: open.n, value: r2(Number(open.value)), late: open.late }, to_buy: { items: sug.length, estimated: r2(sug.reduce((s, x) => s + (x.est_cost ?? 0), 0)) },
    definitions: 'Prazo real = aprovação do pedido → conclusão do recebimento. Pontualidade = recebimentos concluídos até a data prevista do pedido. Variação de preço compara o último preço do período com o último anterior ao período.' };
}

/** Evolução mensal do preço de compra de um produto por fornecedor (12 meses). */
export async function costEvolution(db: Db, companyId: string, productId: string) {
  const p = (await db.query('select id, sku, description, cost_avg, cost_last from products where id = $1 and company_id = $2', [productId, companyId])).rows[0]; if (!p) throw new HttpError(404, 'Produto não encontrado.');
  const rows = (await db.query(`select to_char(date_trunc('month', sp.created_at), 'YYYY-MM') as month, s.legal_name as supplier, avg(sp.price) as price from supplier_prices sp join suppliers s on s.id = sp.supplier_id
    where sp.company_id = $1 and sp.product_id = $2 and sp.created_at >= date_trunc('month', now()) - interval '11 months' group by 1, 2 order by 1`, [companyId, productId])).rows;
  const months = [...new Set(rows.map((r) => r.month))]; const sups = [...new Set(rows.map((r) => r.supplier))];
  return { product: p, months, series: sups.map((s) => ({ supplier: s, values: months.map((m) => { const x = rows.find((r) => r.month === m && r.supplier === s); return x ? r2(Number(x.price)) : null; }) })) };
}

/** BI financeiro: caixa, inadimplência, DSO/DPO, contas, fluxo projetado e resultado dos últimos meses. */
export async function financeBi(db: Db, companyId: string) {
  const OUT_R = `(t.amount - coalesce((select sum(principal) from settlements s where s.receivable_id = t.id and s.reversed_at is null),0))`; const OUT_P = `(t.amount - coalesce((select sum(principal) from settlements s where s.payable_id = t.id and s.reversed_at is null),0))`;
  const k = (await db.query(`select
    coalesce((select sum(ba.opening_balance + coalesce((select sum(amount) from account_movements m where m.account_id = ba.id and not m.reversed),0)) from bank_accounts ba where ba.company_id = $1 and ba.active and ba.kind in ('banco','caixa')),0) as cash,
    coalesce((select sum(${OUT_R}) from receivables t where t.company_id = $1 and t.status in ('aberto','parcial')),0) as ar_open,
    coalesce((select sum(${OUT_R}) from receivables t where t.company_id = $1 and t.status in ('aberto','parcial') and t.due_date < current_date),0) as ar_overdue,
    coalesce((select sum(${OUT_P}) from payables t where t.company_id = $1 and t.kind = 'titulo' and t.status in ('aberto','parcial')),0) as ap_open,
    coalesce((select sum(${OUT_P}) from payables t where t.company_id = $1 and t.kind = 'titulo' and t.status in ('aberto','parcial') and t.due_date < current_date),0) as ap_overdue,
    coalesce((select sum(total) from sales where company_id = $1 and status = 'concluida' and confirmed_at >= now() - interval '90 days'),0) as rev90,
    coalesce((select sum(total_nf) from receivings where company_id = $1 and status = 'concluido' and finished_at >= now() - interval '90 days'),0) as buy90`, [companyId])).rows[0];
  const arOpen = Number(k.ar_open), arOver = Number(k.ar_overdue); const delinq = arOpen > 0 ? r1(arOver / arOpen * 100) : 0;
  const aging = (await db.query(`select case when t.due_date >= current_date then 'a vencer' when current_date - t.due_date <= 30 then '1-30' when current_date - t.due_date <= 60 then '31-60' when current_date - t.due_date <= 90 then '61-90' else '+90' end as bucket, coalesce(sum(${OUT_R}),0) as amount, count(*)::int as titles from receivables t where t.company_id = $1 and t.status in ('aberto','parcial') group by 1`, [companyId])).rows;
  const overdueCustomers = (await db.query(`select c.id, c.legal_name as name, sum(${OUT_R}) as amount, max(current_date - t.due_date) as days from receivables t join customers c on c.id = t.customer_id where t.company_id = $1 and t.status in ('aberto','parcial') and t.due_date < current_date group by c.id order by amount desc limit 10`, [companyId])).rows.map((x) => ({ id: x.id, name: x.name, amount: r2(Number(x.amount)), days: Number(x.days) }));
  const apWeeks = (await db.query(`select (t.due_date - current_date) / 7 as w, coalesce(sum(${OUT_P}),0) as amount from payables t where t.company_id = $1 and t.kind = 'titulo' and t.status in ('aberto','parcial') and t.due_date >= current_date and t.due_date < current_date + 56 group by 1 order by 1`, [companyId])).rows.map((x) => ({ week: Number(x.w), amount: r2(Number(x.amount)) }));
  const cf = await Promise.all([30, 60, 90].map((h) => cashflow(db, companyId, h as 30 | 60 | 90))); const prof = await collectionProfile(db, companyId);
  const from6 = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 5); return iso(d); })(); const monthly = await dre(db, companyId, { from: from6, to: iso(new Date()), group_by: 'month' });
  const sm = (key: string) => monthly.summary[key] as Record<string, number>; const trend = monthly.columns.map((c) => ({ month: c.key, receita_liquida: sm('receita_liquida')[c.key] ?? 0, lucro_bruto: sm('lucro_bruto')[c.key] ?? 0, lucro_liquido: sm('lucro_liquido')[c.key] ?? 0, margem_bruta_pct: sm('receita_liquida')[c.key] ? r1((sm('lucro_bruto')[c.key] / sm('receita_liquida')[c.key]) * 100) : null }));
  const month = monthOf(iso(new Date())); const gDel = await goalFor(db, companyId, 'inadimplencia_max_pct', 'company', null, month);
  return { cash: r2(Number(k.cash)), receivables: { open: r2(arOpen), overdue: r2(arOver), delinquency_pct: delinq, goal_max_pct: gDel, delinquency_ok: gDel == null ? null : delinq <= gDel, dso_days: Number(k.rev90) > 0 ? r1(arOpen / (Number(k.rev90) / 90)) : null, aging: ['a vencer', '1-30', '31-60', '61-90', '+90'].map((b) => ({ bucket: b, amount: r2(Number(aging.find((x) => x.bucket === b)?.amount ?? 0)), titles: aging.find((x) => x.bucket === b)?.titles ?? 0 })), top_overdue: overdueCustomers },
    payables: { open: r2(Number(k.ap_open)), overdue: r2(Number(k.ap_overdue)), dpo_days: Number(k.buy90) > 0 ? r1(Number(k.ap_open) / (Number(k.buy90) / 90)) : null, next_weeks: apWeeks },
    cashflow: cf.map((c) => ({ horizon: c.horizon, ending_projected: c.series.length ? c.series[c.series.length - 1].balance_projected : c.opening_balance, min_projected: c.min_projected_balance, negative_from: c.negative_from })), projection: prof, monthly_result: trend,
    definitions: 'DSO = contas a receber em aberto ÷ faturamento médio diário (90 d). DPO = contas a pagar em aberto ÷ compras médias diárias (90 d). Inadimplência = vencido ÷ em aberto.' };
}

/** Painel executivo: responde, em um lugar, às perguntas do dono. Cada resposta traz o número e de onde ele vem. */
export async function executive(db: Db, companyId: string) {
  const today = iso(new Date()); const from = addDays(today, -29); const per: Period = { from, to: today, compare: 'previous' };      // últimos 30 dias × 30 dias anteriores
  const com = await commercial(db, companyId, per, {}); const st = await stockBi(db, companyId, {}); const fin = await financeBi(db, companyId); const sug = await suggestions(companyId, null, null);
  const pur = await purchasingBi(db, companyId, { from: addDays(today, -90), to: today, compare: 'none' }); const das = await dasEstimate(db, companyId, monthOf(today));
  const topSeller = [...com.sellers].sort((a, b) => b.revenue - a.revenue)[0] ?? null, topSellerMargin = [...com.sellers].sort((a, b) => b.margin - a.margin)[0] ?? null;
  const topProduct = [...com.products].sort((a, b) => b.margin - a.margin)[0] ?? null, topCustomer = [...com.customers].sort((a, b) => b.margin - a.margin)[0] ?? null;
  const k = com.kpis; const idleOld = st.idle.filter((b) => ['181-360', '+360'].includes(b.bucket)).reduce((s, b) => s + Number(b.cost_value), 0); const cf30 = fin.cashflow.find((c) => c.horizon === 30), cf90 = fin.cashflow.find((c) => c.horizon === 90);
  const mostExpensive = pur.price_moves.increases[0] ?? null;
  const answers = [
    { q: 'Quanto vendemos?', a: `R$ ${k.revenue.toLocaleString('pt-BR')} nos últimos 30 dias (${k.orders} vendas, ticket R$ ${k.ticket.toLocaleString('pt-BR')})`, source: 'vendas concluídas dos últimos 30 dias', link: '/bi/comercial' },
    { q: 'Quanto lucramos?', a: `Margem bruta R$ ${k.gross_margin.toLocaleString('pt-BR')} (${k.gross_margin_pct ?? '—'}%); após impostos R$ ${k.net_margin.toLocaleString('pt-BR')}`, source: 'receita − CMV (− DAS estimado)', link: '/contabil/dre' },
    { q: 'Onde estamos perdendo margem?', a: com.margin_leaks.length ? `${com.margin_leaks.length} produto(s) vendidos abaixo da margem mínima; maior: ${com.margin_leaks[0].name}` : 'Nenhum produto abaixo da margem mínima no período', source: 'itens vendidos × margem mínima do cadastro', link: '/bi/comercial' },
    { q: 'Quanto temos em estoque?', a: `R$ ${st.stock_value.toLocaleString('pt-BR')} ao custo médio (${st.skus_in_stock} itens)`, source: 'saldos × custo médio', link: '/bi/estoque' },
    { q: 'Quanto dinheiro está parado?', a: `R$ ${idleOld.toLocaleString('pt-BR')} há mais de 180 dias; excesso/sem giro: R$ ${st.excess.value.toLocaleString('pt-BR')}`, source: 'análise de produtos parados', link: '/estoque/analises' },
    { q: 'O que precisamos comprar?', a: `${sug.length} item(ns) abaixo do ponto de pedido, estimado R$ ${r2(sug.reduce((s, x) => s + (x.est_cost ?? 0), 0)).toLocaleString('pt-BR')}`, source: 'sugestão de compra (estimativa com nível de confiança)', link: '/compras/sugestao' },
    { q: 'Qual fornecedor está mais barato?', a: pur.savings.items[0] ? `Maior economia potencial: ${pur.savings.items[0].name} (R$ ${pur.savings.items[0].potential_saving.toLocaleString('pt-BR')} comprando do mais barato)` : 'Sem diferença relevante entre preço pago e melhor preço', source: 'preço médio pago × melhor último preço', link: '/compras/precos' },
    { q: 'Qual fornecedor aumentou mais os preços?', a: mostExpensive ? `${mostExpensive.supplier}: ${mostExpensive.product} +${mostExpensive.pct}%` : 'Sem aumentos no período', source: 'histórico de preços do fornecedor (90 dias)', link: '/bi/compras' },
    { q: 'Quais clientes estão comprando menos?', a: com.declining_customers.items.length ? `${com.declining_customers.items.length} cliente(s); maior queda: ${com.declining_customers.items[0].name} (${com.declining_customers.items[0].variation_pct}%)` : 'Nenhuma queda relevante frente ao período anterior', source: `queda ≥ ${com.declining_customers.threshold_pct}% × período anterior (base mín. R$ ${com.declining_customers.min_base})`, link: '/bi/comercial' },
    { q: 'Quanto teremos em caixa em 30/60/90 dias?', a: `30 d: R$ ${(cf30?.ending_projected ?? 0).toLocaleString('pt-BR')} · 90 d: R$ ${(cf90?.ending_projected ?? 0).toLocaleString('pt-BR')} (confiança ${fin.projection.confidence})`, source: 'fluxo de caixa projetado (estimativa)', link: '/financeiro/fluxo' },
    { q: 'Quanto pagaremos de impostos?', a: `DAS estimado do mês corrente: R$ ${das.estimated.toLocaleString('pt-BR')} (${das.effective_rate ?? '—'}%) — vence ${das.due_date.split('-').reverse().join('/')}`, source: 'estimativa; valor oficial vem do PGDAS-D', link: '/fiscal/impostos' },
    { q: 'Qual vendedor vende mais / gera mais lucro?', a: topSeller ? `Vendas: ${topSeller.name} (R$ ${topSeller.revenue.toLocaleString('pt-BR')}) · Lucro: ${topSellerMargin?.name} (R$ ${topSellerMargin?.margin.toLocaleString('pt-BR')})` : 'Sem vendas no período', source: 'vendas concluídas por vendedor', link: '/bi/comercial' },
    { q: 'Qual produto / cliente é mais rentável?', a: `${topProduct ? `Produto: ${topProduct.name} (R$ ${topProduct.margin.toLocaleString('pt-BR')})` : '—'} · ${topCustomer ? `Cliente: ${topCustomer.name} (R$ ${topCustomer.margin.toLocaleString('pt-BR')})` : '—'}`, source: 'margem bruta absoluta no período', link: '/bi/comercial' },
    { q: 'Qual é nosso custo real e o preço que devemos praticar?', a: 'Custo de aquisição + custos sobre a venda e margem desejada, produto a produto', source: 'motor de precificação', link: '/precificacao' },
  ];
  return { generated_at: new Date().toISOString(), period: per, answers, highlights: { revenue: k.revenue, revenue_delta_pct: com.deltas?.revenue ?? null, gross_margin_pct: k.gross_margin_pct, goals: com.goals, stock_value: st.stock_value, turnover: st.turnover_annual, delinquency_pct: fin.receivables.delinquency_pct, cash: fin.cash } };
}
