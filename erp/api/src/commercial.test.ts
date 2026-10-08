import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { buildApp } = await import('./app.js');
const { pool, tx } = await import('./db.js');
const { createCompany } = await import('./scripts/company.js');
const { hashPassword } = await import('./lib/security.js');
const { simulate, priceForMargin } = await import('./pricing.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let adm = '', vend = '', ger = ''; let prodA = '', prodB = '', cust = '', custCredit = ''; let hq = '';
const call = (method: string, url: string, body?: unknown, token = adm) =>
  app.inject({ method: method as 'GET', url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Senha12345x' } })).json().token;
const stock = async (id: string, status = 'disponivel') => Number((await pool.query('select coalesce(sum(qty),0) q from stock_balances where product_id=$1 and status=$2', [id, status])).rows[0].q);
const sell = (items: object[], extra: object = {}, token = vend) => call('POST', '/sales', { type: 'balcao', items, ...extra }, token);

before(async () => {
  app = await buildApp(); const st = Date.now();
  const r = await tx((db) => createCompany(db, { legalName: 'Comercial Teste', adminName: 'Adm', adminEmail: `adm${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false }));
  hq = r.branchId; const pw = await hashPassword('Senha12345x');
  await pool.query(`insert into users (company_id, role_id, name, email, password_hash, is_seller, commission_pct) values ($1,$2,'Vend',$3,$4,true,2)`, [r.companyId, r.roleIds.vendedor, `v${st}@t.local`, pw]);
  await pool.query(`insert into users (company_id, role_id, name, email, password_hash) values ($1,$2,'Ger',$3,$4)`, [r.companyId, r.roleIds.gerente, `g${st}@t.local`, pw]);
  adm = await login(`adm${st}@t.local`); vend = await login(`v${st}@t.local`); ger = await login(`g${st}@t.local`);
  assert.equal((await call('PUT', '/pricing/settings', { params: { freight_pct: 0, insurance_pct: 0, accessory_pct: 0, tax_pct: 6, commission_pct: 3, card_fee_pct: 2.5, variable_expenses_pct: 2 }, monthly_goal: 10000 })).statusCode, 200);
  const mk = async (sku: string, price: number) => (await call('POST', '/products', { sku, description: `Produto ${sku}`, cost_current: 10, sale_price: price, min_margin_pct: 20 })).json().id;
  prodA = await mk('A1', 30); prodB = await mk('B1', 28);
  for (const [id, q] of [[prodA, 20], [prodB, 20]] as const) await call('POST', '/stock/movements', { op: 'entrada', product_id: id, qty: q, unit_cost: 10 });
  await call('POST', `/products/${prodA}/equivalents`, { otherProductId: prodB });
  cust = (await call('POST', '/customers', { type: 'PF', legal_name: 'Cliente PF', price_table: 'oficina' })).json().id;
  custCredit = (await call('POST', '/customers', { type: 'PJ', document: '11.222.333/0001-81', legal_name: 'Oficina Crédito', credit_limit: 100, price_table: 'varejo' })).json().id;
});
after(async () => { await app.close(); await pool.end(); });

test('motor de preço: margem ↔ preço (tributos, comissão, cartão, despesas)', () => {
  const p = { freight_pct: 0, insurance_pct: 0, accessory_pct: 0, tax_pct: 6, commission_pct: 3, card_fee_pct: 2.5, variable_expenses_pct: 2 };
  const price = priceForMargin(10, p, 30)!; assert.equal(price, 17.7);
  const s = simulate(10, price, p); assert.ok(Math.abs(s.margin_pct! - 30) < 0.1); assert.equal(s.markup_pct, 77);
  assert.equal(priceForMargin(10, p, 90), null);
  const r = simulate(10, 12, p); assert.ok(r.margin_pct! < 0 || r.margin_pct! < 10);
});

test('simulador via API usa custo médio e parâmetros da empresa', async () => {
  const r = (await call('POST', '/pricing/simulate', { product_id: prodA, price: 30, margin_pct: 30 })).json();
  assert.equal(r.cost, 10); assert.ok(r.margin_pct > 0 && r.suggested_price > 10);
});

test('tabelas de preço: regra por tabela do cliente e por quantidade', async () => {
  const t = (await call('GET', '/price-tables?q=oficina')).json().items[0];
  assert.equal((await call('POST', '/price-rules', { table_id: t.id, scope: 'all', adjust_pct: -10 })).statusCode, 201);
  assert.equal((await call('POST', '/price-rules', { table_id: t.id, scope: 'product', scope_id: prodA, min_qty: 10, fixed_price: 25 })).statusCode, 201);
  const p1 = (await call('GET', `/pricing/resolve?product_id=${prodA}&customer_id=${cust}&qty=1`)).json();
  const p10 = (await call('GET', `/pricing/resolve?product_id=${prodA}&customer_id=${cust}&qty=10`)).json();
  const pv = (await call('GET', `/pricing/resolve?product_id=${prodA}&customer_id=${custCredit}&qty=1`)).json();
  assert.equal(p1.price, 27); assert.equal(p10.price, 25); assert.equal(pv.price, 30);
  assert.equal((await call('POST', '/price-rules', { table_id: t.id, scope: 'product', scope_id: crypto.randomUUID(), adjust_pct: 1 })).statusCode, 422);
});

test('venda dentro da alçada (5%): baixa estoque, recebível pago, comissão e margem', async () => {
  const before = await stock(prodA);
  const r = await sell([{ product_id: prodA, qty: 2, discount_pct: 5 }], { confirm: true, payments: [{ method: 'pix', amount: 57 }] });
  assert.equal(r.statusCode, 201, r.body); const s = r.json();
  assert.equal(s.status, 'concluida'); assert.equal(await stock(prodA), before - 2); assert.equal(await stock(prodA, 'reservado'), 0);
  const d = (await call('GET', '/sales/' + s.id, undefined, vend)).json();
  assert.equal(Number(d.total), 57); assert.equal(Number(d.commission_amount), 1.14); assert.equal(Number(d.cost_total), 20);
  assert.equal(Number(d.tax_amount), 3.42); assert.equal(Number(d.margin_total), 33.58);
  assert.equal(d.receivables[0].status, 'pago');
  const mov = (await call('GET', `/stock/movements?product_id=${prodA}&type=saida`)).json().items[0];
  assert.equal(mov.document_type, 'venda');
});

test('pagamento diferente do total é recusado', async () => {
  const s = (await sell([{ product_id: prodA, qty: 1 }])).json();
  assert.equal((await call('POST', `/sales/${s.id}/confirm`, { payments: [{ method: 'dinheiro', amount: 10 }] }, vend)).statusCode, 422);
  assert.equal((await call('POST', `/sales/${s.id}/cancel`, { reason: 'teste' }, vend)).statusCode, 200);
});

test('desconto acima do limite exige aprovação do gestor (segregação de funções)', async () => {
  const pre = (await call('POST', '/sales/preview', { items: [{ product_id: prodA, qty: 1, discount_pct: 10 }] }, vend)).json();
  assert.equal(pre.needs_approval, true); assert.equal(pre.violations[0].type, 'desconto');
  assert.equal(pre.lines[0].unit_price, 27); assert.ok(pre.lines[0].margin_after_pct < pre.lines[0].margin_before_pct);
  const before = await stock(prodA);
  const s = (await sell([{ product_id: prodA, qty: 1, discount_pct: 10 }], { confirm: true, payments: [{ method: 'pix', amount: 27 }] })).json();
  assert.equal(s.status, 'aguardando_aprovacao'); assert.equal(await stock(prodA, 'reservado'), 1); assert.equal(await stock(prodA), before - 1);
  assert.equal((await call('POST', `/sales/${s.id}/confirm`, { payments: [{ method: 'pix', amount: 27 }] }, vend)).statusCode, 409);
  assert.equal((await call('GET', '/approvals', undefined, vend)).statusCode, 403);
  const ap = (await call('GET', '/approvals', undefined, ger)).json().items.find((x: { sale_id: string }) => x.sale_id === s.id);
  assert.ok(ap); assert.equal((await call('POST', `/approvals/${ap.id}/approve`, {}, vend)).statusCode, 403);
  assert.equal((await call('POST', `/approvals/${ap.id}/approve`, { note: 'ok' }, ger)).statusCode, 200);
  assert.equal((await call('POST', `/sales/${s.id}/confirm`, { payments: [{ method: 'pix', amount: 27 }] }, vend)).statusCode, 200);
  assert.equal(await stock(prodA, 'reservado'), 0);
});

test('recusa do gestor cancela e libera a reserva; gestor vende com desconto sem barreira (registrado)', async () => {
  const before = await stock(prodA);
  const s = (await sell([{ product_id: prodA, qty: 1, discount_pct: 12 }])).json();
  const ap = (await call('GET', '/approvals', undefined, ger)).json().items.find((x: { sale_id: string }) => x.sale_id === s.id);
  assert.equal((await call('POST', `/approvals/${ap.id}/reject`, { note: 'sem margem' }, ger)).statusCode, 200);
  assert.equal(await stock(prodA), before); assert.equal((await call('GET', '/sales/' + s.id, undefined, vend)).json().status, 'cancelada');
  const g = (await sell([{ product_id: prodA, qty: 1, discount_pct: 12 }], {}, ger)).json(); assert.equal(g.status, 'aberto');
  const a = (await call('GET', `/audit?entity=sale&entity_id=${g.id}`)).json().items.map((x: { action: string }) => x.action); assert.ok(a.includes('self_approved'));
  await call('POST', `/sales/${g.id}/cancel`, { reason: 'teste' }, ger);
});

test('margem abaixo da mínima exige aprovação mesmo sem desconto no limite', async () => {
  await call('PATCH', '/products/' + prodB, { min_margin_pct: 70 });
  const pre = (await call('POST', '/sales/preview', { items: [{ product_id: prodB, qty: 1 }] }, vend)).json();
  assert.ok(pre.violations.some((v: { type: string }) => v.type === 'margem_minima'));
  await call('PATCH', '/products/' + prodB, { min_margin_pct: 20 });
});

test('sem estoque: 409 com equivalentes disponíveis e nada é reservado', async () => {
  const r = await sell([{ product_id: prodA, qty: 9999 }]);
  assert.equal(r.statusCode, 409); const j = r.json();
  assert.equal(j.code, 'insufficient_stock'); assert.ok(j.suggestions.some((s: { id: string }) => s.id === prodB));
  assert.equal(await stock(prodA, 'reservado'), 0);
});

test('venda a prazo: limite de crédito barra vendedor; gestor conclui; cancelamento só do gestor devolve estoque', async () => {
  const before = await stock(prodA);
  const s = (await sell([{ product_id: prodA, qty: 4 }], { customer_id: custCredit, type: 'b2b' })).json();   // 120 > limite 100
  const pay = { payments: [{ method: 'boleto', amount: 120, installments: 2 }] };
  const bad = await call('POST', `/sales/${s.id}/confirm`, pay, vend); assert.equal(bad.statusCode, 409); assert.equal(bad.json().code, 'credit_limit');
  assert.equal((await call('POST', `/sales/${s.id}/confirm`, pay, ger)).statusCode, 200);
  const d = (await call('GET', '/sales/' + s.id, undefined, ger)).json();
  assert.equal(d.receivables.length, 2); assert.equal(d.receivables[0].status, 'aberto'); assert.equal(Number(d.receivables[0].amount) + Number(d.receivables[1].amount), 120);
  const sum = (await call('GET', `/customers/${custCredit}/summary`)).json();
  assert.equal(sum.credit.used, 120); assert.equal(sum.credit.available, 0); assert.equal(sum.sales_count, 1); assert.equal(sum.top_products[0].sku, 'A1');
  assert.equal((await call('POST', `/sales/${s.id}/cancel`, { reason: 'devolvido' }, vend)).statusCode, 403);
  assert.equal((await call('POST', `/sales/${s.id}/cancel`, { reason: 'devolvido' }, ger)).statusCode, 200);
  assert.equal(await stock(prodA), before);
  assert.equal((await call('GET', '/sales/' + s.id, undefined, ger)).json().receivables[0].status, 'cancelado');
});

test('orçamento → link público → aprovação do cliente gera pedido com estoque reservado', async () => {
  const q = (await call('POST', '/quotes', { customer_id: cust, valid_days: 5, payment_condition: '28 dias', items: [{ product_id: prodA, qty: 3 }] }, vend)).json();
  const sent = (await call('POST', `/quotes/${q.id}/send`, undefined, vend)).json();
  assert.match(sent.link, /\/orcamento\//); const token = sent.link.split('/').pop();
  const pubView = (await call('GET', `/public/quotes/${token}`, undefined, '')).json();
  assert.equal(pubView.status, 'visualizado'); assert.equal(Number(pubView.total), 81); assert.equal(pubView.items[0].sku, 'A1');
  assert.equal((await call('GET', `/public/quotes/invalido`, undefined, '')).statusCode, 404);
  const before = await stock(prodA);
  const ok = (await call('POST', `/public/quotes/${token}/approve`, undefined, '')).json();
  assert.equal(ok.status, 'convertido'); assert.ok(ok.order_number);
  assert.equal(await stock(prodA), before - 3); assert.equal(await stock(prodA, 'reservado'), 3);
  assert.equal((await call('GET', '/quotes/' + q.id, undefined, vend)).json().status, 'convertido');
  assert.equal((await call('POST', `/quotes/${q.id}/convert`, undefined, vend)).statusCode, 409);
  const sale = (await call('GET', '/sales?q=' + ok.order_number, undefined, vend)).json().items[0];
  await call('POST', `/sales/${sale.id}/cancel`, { reason: 'teste' }, vend);
});

test('orçamento expirado não converte; conversão manual com um clique', async () => {
  const q = (await call('POST', '/quotes', { customer_id: cust, valid_days: 1, items: [{ product_id: prodB, qty: 1 }] }, vend)).json();
  await pool.query(`update quotes set valid_until = current_date - 1 where id = $1`, [q.id]);
  assert.equal((await call('GET', '/quotes/' + q.id, undefined, vend)).json().status, 'expirado');
  assert.equal((await call('POST', `/quotes/${q.id}/convert`, undefined, vend)).statusCode, 409);
  const q2 = (await call('POST', '/quotes', { customer_id: cust, items: [{ product_id: prodB, qty: 1 }] }, vend)).json();
  const c = await call('POST', `/quotes/${q2.id}/convert`, undefined, vend); assert.equal(c.statusCode, 201, c.body);
  await call('POST', `/sales/${c.json().id}/cancel`, { reason: 'teste' }, vend);
});

test('repetir pedido e pedido recorrente B2B', async () => {
  const s = (await sell([{ product_id: prodB, qty: 2 }], { confirm: true, payments: [{ method: 'dinheiro', amount: 56 }] })).json();
  const rep = await call('POST', `/sales/${s.id}/repeat`, undefined, vend); assert.equal(rep.statusCode, 201); assert.equal(rep.json().status, 'aberto');
  await call('POST', `/sales/${rep.json().id}/cancel`, { reason: 'teste' }, vend);
  const rc = (await call('POST', '/b2b/recurring', { customer_id: custCredit, interval_days: 15, next_run: '2020-01-01', items: [{ product_id: prodB, qty: 1 }] }, vend)).json();
  const due = (await call('POST', '/b2b/recurring/run-due', undefined, vend)).json(); assert.equal(due.results.length, 1); assert.equal(due.results[0].ok, true);
  const after = (await call('GET', '/b2b/recurring', undefined, vend)).json().items.find((x: { id: string }) => x.id === rc.id);
  assert.ok(after.next_run > '2020-01-01'); assert.ok(after.last_sale_id);
  await call('POST', `/sales/${after.last_sale_id}/cancel`, { reason: 'teste' }, vend);
});

test('dashboard comercial com dados reais; vendedor só vê as próprias vendas', async () => {
  const d = (await call('GET', '/dashboard/summary')).json().commercial;
  assert.ok(Number(d.revenue_month) > 0 && d.goal === 10000 && d.by_seller.length >= 1);
  const own = (await call('GET', '/sales', undefined, vend)).json(); assert.ok(own.items.every((x: { seller_name: string }) => x.seller_name === 'Vend'));
  assert.equal(hq.length > 0, true);
});

test('RBAC comercial: vendedor não altera parâmetros de preço nem aplica preços', async () => {
  assert.equal((await call('PUT', '/pricing/settings', { monthly_goal: 1 }, vend)).statusCode, 403);
  assert.equal((await call('POST', '/pricing/apply', { product_ids: [prodA] }, vend)).statusCode, 403);
  const r = await call('POST', '/pricing/apply', { product_ids: [prodA] }); assert.equal(r.statusCode, 200);
});
