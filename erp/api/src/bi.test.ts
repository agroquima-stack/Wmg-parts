import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { buildApp } = await import('./app.js');
const { pool, tx } = await import('./db.js');
const { createCompany } = await import('./scripts/company.js');
const { hashPassword } = await import('./lib/security.js');

let app: Awaited<ReturnType<typeof buildApp>>; let adm = '', fin = '', vend = '', cid = '';
let p1 = '', p2 = '', cat1 = '', c1 = '', c2 = '', sup1 = '', sup2 = '', sellerV = '', sellerA = '';
const call = (method: string, url: string, body?: unknown, token = adm) =>
  app.inject({ method: method as 'GET', url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Senha12345x' } })).json().token;
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const sell = async (customer: string | null, type: string, product: string, qty: number, daysAgo: number, token = adm) => {
  const pre = (await call('POST', '/sales/preview', { customer_id: customer, channel: type, items: [{ product_id: product, qty }] }, token)).json();
  const r = await call('POST', '/sales', { type, customer_id: customer, items: [{ product_id: product, qty }], confirm: true, payments: [{ method: 'pix', amount: pre.totals.total }] }, token); assert.equal(r.statusCode, 201, r.body);
  if (daysAgo) await pool.query(`update sales set confirmed_at = now() - ($2 || ' days')::interval where id = $1`, [r.json().id, String(daysAgo)]);
  return r.json();
};
const com = async (q = '') => (await call('GET', `/bi/commercial?from=${day(-29)}&to=${day(0)}&compare=previous${q}`)).json();

before(async () => {
  app = await buildApp(); const st = Date.now(); const pw = await hashPassword('Senha12345x');
  const r = await tx((db) => createCompany(db, { legalName: 'BI Teste', adminName: 'Adm', adminEmail: `adm${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false })); cid = r.companyId;
  for (const [role, k] of [['financeiro', 'f'], ['vendedor', 'v']] as const) await pool.query(`insert into users (company_id, role_id, name, email, password_hash, is_seller, commission_pct) values ($1,$2,$3,$4,$5,$6,0)`, [r.companyId, r.roleIds[role], role, `${k}${st}@t.local`, pw, role === 'vendedor']);
  adm = await login(`adm${st}@t.local`); fin = await login(`f${st}@t.local`); vend = await login(`v${st}@t.local`);
  sellerV = (await pool.query(`select id from users where company_id = $1 and role_id = $2`, [cid, r.roleIds.vendedor])).rows[0].id; sellerA = (await pool.query(`select id from users where email = $1`, [`adm${st}@t.local`])).rows[0].id;
  cat1 = (await call('POST', '/categories', { name: 'Freios' })).json().id;
  const mk = async (sku: string, extra: object = {}) => (await call('POST', '/products', { sku, description: `Produto ${sku}`, cost_current: 40, sale_price: 100, min_margin_pct: 10, ncm: '87141000', origin: 0, category_id: cat1, max_stock: 30, ...extra })).json().id;
  p1 = await mk('B1'); p2 = await mk('B2', { max_stock: 0 });
  await call('POST', '/stock/movements', { op: 'entrada', product_id: p1, qty: 200, unit_cost: 40 }); await call('POST', '/stock/movements', { op: 'entrada', product_id: p2, qty: 10, unit_cost: 40 });
  c1 = (await call('POST', '/customers', { type: 'PJ', document: '11.222.333/0001-81', legal_name: 'Cliente Um' })).json().id; c2 = (await call('POST', '/customers', { type: 'PJ', document: '04.252.011/0001-10', legal_name: 'Cliente Dois' })).json().id;
  sup1 = (await call('POST', '/suppliers', { legal_name: 'Fornecedor A', payment_terms_days: 30 })).json().id; sup2 = (await call('POST', '/suppliers', { legal_name: 'Fornecedor B' })).json().id;
  // período anterior (45–31 dias atrás): cliente 1 comprou R$ 1.000; período atual: cliente 1 R$ 200, cliente 2 R$ 800 (vendedor), balcão R$ 500 (admin)
  await sell(c1, 'b2b', p1, 10, 40); await sell(c1, 'b2b', p1, 2, 5); await sell(c2, 'externo', p1, 8, 3, vend); await sell(null, 'balcao', p1, 5, 1);
});
after(async () => { await app.close(); await pool.end(); });

test('BI comercial: KPIs, margem, ticket e comparação com o período anterior', async () => {
  const d = await com(); const k = d.kpis;
  assert.equal(k.revenue, 1500); assert.equal(k.orders, 3); assert.equal(k.ticket, 500); assert.equal(k.gross_margin, 900); assert.equal(k.gross_margin_pct, 60); assert.equal(k.customers, 2);
  assert.equal(d.previous.revenue, 1000); assert.equal(d.deltas.revenue, 50); assert.equal(d.comparison.to, day(-30));
  assert.equal(d.timeline.length, 30); assert.equal(d.timeline.reduce((s: number, x: { revenue: number }) => s + x.revenue, 0), 1500); assert.equal(d.timeline.reduce((s: number, x: { prev_revenue: number }) => s + x.prev_revenue, 0), 1000);
  const none = (await call('GET', `/bi/commercial?from=${day(-29)}&to=${day(0)}&compare=none`)).json(); assert.equal(none.previous, null); assert.equal(none.deltas, null);
  assert.equal((await call('GET', `/bi/commercial?from=${day(0)}&to=${day(-5)}`)).statusCode, 422);
});

test('rankings: vendedores, clientes, produtos, categorias e canais; clientes que reduziram as compras', async () => {
  const d = await com();
  assert.equal(d.sellers.find((s: { name: string }) => s.name === 'vendedor').revenue, 800); assert.equal(d.sellers[0].name, 'vendedor');
  assert.equal(d.channels.find((c: { id: string }) => c.id === 'externo').share_pct, 53.3); assert.equal(d.categories[0].name, 'Freios'); assert.equal(d.products[0].revenue, 1500);
  const c1r = d.customers.find((c: { name: string }) => c.name === 'Cliente Um'); assert.equal(c1r.prev_revenue, 1000); assert.equal(c1r.variation_pct, -80);
  const dec = d.declining_customers.items; assert.equal(dec.length, 1); assert.equal(dec[0].name, 'Cliente Um'); assert.equal(dec[0].lost, 800); assert.equal(d.declining_customers.threshold_pct, 30);
  assert.equal((await com('&decline_pct=90')).declining_customers.items.length, 0);                                    // limiar configurável
  assert.equal((await com('&decline_min_base=5000')).declining_customers.items.length, 0);                            // base mínima configurável
  const only = await com('&channel=externo'); assert.equal(only.kpis.revenue, 800); assert.equal(only.kpis.orders, 1);
});

test('vendas abaixo da margem mínima aparecem como vazamento de margem', async () => {
  assert.equal((await com()).margin_leaks.length, 0);
  await call('PATCH', '/products/' + p1, { min_margin_pct: 70 }); const d = await com(); assert.equal(d.margin_leaks[0].margin_pct, 60); assert.equal(d.margin_leaks[0].min_margin_pct, 70);
  await call('PATCH', '/products/' + p1, { min_margin_pct: 10 });
});

test('metas: estrutura pronta, por escopo e por mês, com validação e permissões', async () => {
  assert.equal((await com()).goals.revenue, null);                                                                      // sem meta definida, nada é inventado
  const info = (await call('GET', '/bi/goals', undefined, fin)).json(); assert.ok(info.kinds.faturamento && info.kinds.giro_estoque && info.items.length === 0);
  assert.equal((await call('PUT', '/bi/goals', { kind: 'faturamento', target: 10000 }, fin)).statusCode, 403);          // financeiro só consulta
  assert.equal((await call('PUT', '/bi/goals', { kind: 'ticket_medio', scope_type: 'seller', scope_id: sellerV, target: 5 })).statusCode, 422);
  assert.equal((await call('PUT', '/bi/goals', { kind: 'faturamento', scope_type: 'seller', target: 5 })).statusCode, 422);
  assert.equal((await call('PUT', '/bi/goals', { kind: 'faturamento', target: 10000 })).statusCode, 200); assert.equal((await call('PUT', '/bi/goals', { kind: 'faturamento', target: 20000 })).statusCode, 200);
  assert.equal((await call('GET', '/bi/goals')).json().items.filter((g: { kind: string }) => g.kind === 'faturamento').length, 1);   // atualiza, não duplica
  const month = day(0).slice(0, 7); assert.equal((await call('PUT', '/bi/goals', { kind: 'faturamento', month, target: 5000 })).statusCode, 200);   // meta do mês vence a padrão
  const d = await com(); assert.equal(d.goals.revenue.target, 5000); assert.ok(d.goals.revenue.pct > 0); assert.ok(d.goals.revenue.projected > 0);
  assert.equal((await call('PUT', '/bi/goals', { kind: 'faturamento', scope_type: 'seller', scope_id: sellerV, target: 400 })).statusCode, 200);
  const sv = (await com()).sellers.find((s: { name: string }) => s.name === 'vendedor'); assert.equal(sv.goal, 400); assert.ok(sv.goal_pct >= 0);
  await call('PUT', '/bi/goals', { kind: 'margem_bruta_pct', target: 55 }); await call('PUT', '/bi/goals', { kind: 'ticket_medio', target: 600 });
  const g = (await com()).goals; assert.equal(g.margin_pct.ok, true); assert.equal(g.ticket.ok, false);
  const del = (await call('GET', '/bi/goals')).json().items.find((x: { month: string | null; kind: string }) => x.month && x.kind === 'faturamento'); assert.equal((await call('DELETE', '/bi/goals/' + del.id)).statusCode, 200); assert.equal((await com()).goals.revenue.target, 20000);
  const dash = (await call('GET', '/dashboard/summary')).json().commercial; assert.equal(dash.goal, 20000);              // painel inicial usa a mesma meta
});

test('BI de estoque: valor, giro, cobertura, ABC, ruptura e excesso; metas por categoria', async () => {
  const s = (await call('GET', '/bi/stock')).json();
  assert.equal(s.stock_value, (200 - 25) * 40 + 10 * 40); assert.equal(s.cmv_90d, 25 * 40);
  assert.equal(s.turnover_annual, Math.round(1000 * (365 / 90) / s.stock_value * 100) / 100); assert.equal(s.coverage_days, Math.round(s.stock_value / (1000 / 90) * 10) / 10);
  assert.equal(s.abc.reduce((n: number, x: { products: number }) => n + x.products, 0), 2); assert.equal(s.abc.find((x: { class: string }) => x.class === 'A').products, 1);
  assert.ok(s.excess.count >= 1 && s.excess.items.some((x: { name: string }) => x.name.includes('B2')));                                              // B2 sem venda em 90 dias
  await call('POST', '/stock/movements', { op: 'saida', product_id: p2, qty: 10, reason: 'zerar para teste' }); await sell(null, 'balcao', p2, 0.001 as never, 0).catch(() => null);
  await call('PUT', '/bi/goals', { kind: 'giro_estoque', scope_type: 'category', scope_id: cat1, target: 100 }); await call('PUT', '/bi/goals', { kind: 'cobertura_dias_max', target: 30 });
  const g = (await call('GET', '/bi/stock')).json(); const cat = g.categories.find((c: { name: string }) => c.name === 'Freios'); assert.equal(cat.goal_turnover, 100); assert.equal(cat.turnover_ok, false); assert.equal(g.goals.coverage_max, 30); assert.equal(g.goals.coverage_ok, false);
  assert.equal(g.idle.length, 6);
});

test('ruptura: item com venda recente e sem saldo é listado com a perda diária estimada', async () => {
  await call('POST', '/stock/movements', { op: 'entrada', product_id: p2, qty: 5, unit_cost: 40 }); await sell(c2, 'b2b', p2, 5, 10);          // vende tudo há 10 dias
  const s = (await call('GET', '/bi/stock')).json(); const it = s.stockouts.items.find((x: { name: string }) => x.name.includes('B2')); assert.ok(it); assert.equal(it.avg_daily, Math.round(5 / 90 * 100) / 100); assert.ok(s.stockouts.est_daily_revenue_lost > 0);
});

test('BI de compras: volume, pontualidade, variação de preço e economia potencial', async () => {
  await pool.query(`insert into supplier_prices (company_id, supplier_id, product_id, price, source, created_at) values ($1,$2,$3,10,'manual', now() - interval '60 days'), ($1,$4,$3,9,'manual', now() - interval '60 days')`, [cid, sup1, p1, sup2]);
  await call('PUT', `/suppliers/${sup2}/products/${p1}`, { price: 9.5 });                                                // fornecedor B continua mais barato
  const po = (await call('POST', '/purchase-orders', { supplier_id: sup1, items: [{ product_id: p1, qty: 10, unit_price: 12 }], submit: true, expected_date: day(5) })).json();
  const rc = (await call('POST', '/receivings', { supplier_id: sup1, po_id: po.id, nf_number: 'BI-1', items: [{ product_id: p1, qty: 10, unit_price: 12 }] })).json();
  await call('POST', `/receivings/${rc.id}/check-all`); assert.equal((await call('POST', `/receivings/${rc.id}/finish`, {})).statusCode, 200);
  await pool.query(`update purchase_orders set approved_at = now() - interval '4 days' where id = $1`, [po.id]);
  const d = (await call('GET', `/bi/purchasing?from=${day(-30)}&to=${day(0)}`)).json();
  assert.equal(d.total, 120); assert.equal(d.nfs, 1); assert.equal(d.suppliers[0].name, 'Fornecedor A'); assert.equal(d.suppliers[0].share_pct, 100); assert.equal(d.suppliers[0].on_time_pct, 100); assert.ok(d.suppliers[0].lead_real_days >= 3.9 && d.suppliers[0].lead_real_days <= 4.1);
  const inc = d.price_moves.increases.find((m: { supplier: string }) => m.supplier === 'Fornecedor A'); assert.equal(inc.before, 10); assert.equal(inc.after, 12); assert.equal(inc.pct, 20); assert.equal(inc.impact, 20);
  assert.equal(d.price_moves.by_supplier[0].supplier, 'Fornecedor A'); assert.equal(d.savings.items[0].best_price, 9.5); assert.equal(d.savings.items[0].potential_saving, 25); assert.ok(d.to_buy.items >= 0);
  const ev = (await call('GET', `/bi/purchasing/cost-evolution?product_id=${p1}`)).json(); assert.ok(ev.months.length >= 1); assert.ok(ev.series.find((s: { supplier: string }) => s.supplier === 'Fornecedor A'));
});

test('BI financeiro: caixa, inadimplência, aging, DSO/DPO e fluxo projetado; meta de inadimplência', async () => {
  await call('POST', '/bank-accounts', { name: 'Banco BI', kind: 'banco', opening_balance: 3000 });
  await call('POST', '/receivables', { customer_id: c1, due_date: day(-45), amount: 700, description: 'Título vencido BI' }, fin); await call('PUT', '/bi/goals', { kind: 'inadimplencia_max_pct', target: 10 });
  const d = (await call('GET', '/bi/finance')).json();
  assert.equal(d.cash, 3000); assert.ok(d.receivables.overdue >= 700); assert.ok(d.receivables.delinquency_pct > 10); assert.equal(d.receivables.delinquency_ok, false); assert.equal(d.receivables.goal_max_pct, 10);
  assert.ok(d.receivables.aging.find((b: { bucket: string }) => b.bucket === '31-60').amount >= 700); assert.equal(d.receivables.top_overdue[0].name, 'Cliente Um'); assert.ok(d.receivables.dso_days > 0);
  assert.equal(d.cashflow.length, 3); assert.equal(d.cashflow[0].horizon, 30); assert.ok(d.monthly_result.length >= 1); assert.match(d.projection.note, /estimativa|insuficiente/i);
});

test('painel executivo responde às perguntas do dono com a origem de cada número', async () => {
  const d = (await call('GET', '/bi/executive')).json(); assert.equal(d.answers.length, 14);
  for (const a of d.answers) { assert.ok(a.q && a.a && a.source && a.link); }
  assert.ok(d.answers.find((a: { q: string }) => /vendemos/.test(a.q)).a.includes('R$')); assert.ok(d.answers.find((a: { q: string }) => /comprando menos/.test(a.q)).a.includes('Cliente Um'));
  assert.ok(d.highlights.goals.revenue);
});

test('permissões e isolamento do BI', async () => {
  for (const u of ['/bi/executive', '/bi/commercial', '/bi/stock', '/bi/purchasing', '/bi/finance', '/bi/goals']) assert.equal((await call('GET', u, undefined, vend)).statusCode, 403);
  assert.equal((await call('GET', '/bi/commercial', undefined, fin)).statusCode, 200);
  assert.equal((await call('DELETE', '/bi/goals/' + crypto.randomUUID(), undefined, fin)).statusCode, 403); assert.equal((await call('DELETE', '/bi/goals/' + crypto.randomUUID())).statusCode, 404);
});
