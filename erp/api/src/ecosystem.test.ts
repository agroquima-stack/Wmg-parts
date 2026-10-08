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
  const r = await tx((db) => createCompany(db, { legalName: 'Eco Teste', adminName: 'Adm', adminEmail: `adm${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false })); cid = r.companyId;
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


let bank = '', mk = '';
const stockOf = async (p: string) => Number((await pool.query(`select coalesce(sum(qty),0) as q from stock_balances where company_id = $1 and product_id = $2 and status = 'disponivel'`, [cid, p])).rows[0].q);
const balance = async (id: string) => Number((await call('GET', '/bank-accounts')).json().items.find((a: { id: string }) => a.id === id).balance);

test('Marketplace: cadastro, anúncio com margem real e planilha de publicação', async () => {
  bank = (await call('POST', '/bank-accounts', { name: 'BTG', kind: 'banco', opening_balance: 0 })).json().id;
  const r = await call('POST', '/marketplaces', { name: 'Canal Teste', commission_pct: 16, fixed_fee: 5, shipping_cost: 10, payout_days: 14 }); assert.equal(r.statusCode, 201, r.body); mk = r.json().id;
  assert.equal((await call('POST', '/marketplaces', { name: 'Canal Teste' })).statusCode, 409); // nome único
  assert.equal((await call('POST', '/marketplaces', { name: 'X', commission_pct: 120 })).statusCode, 422);
  const e = (await call('GET', `/marketplaces/${mk}/economics?product_id=${p1}&price=100`)).json();
  assert.equal(e.commission, 16); assert.equal(e.cost, 40); assert.equal(e.margin, Math.round((100 - e.tax - 16 - 5 - 10 - 40) * 100) / 100); { const at = (await call('GET', `/marketplaces/${mk}/economics?product_id=${p1}&price=${e.price_for_target_margin}`)).json(); assert.ok(at.margin_pct >= 9.9, String(at.margin_pct)); const under = (await call('GET', `/marketplaces/${mk}/economics?product_id=${p1}&price=${e.price_for_target_margin - 1}`)).json(); assert.ok(under.margin_pct < 10); }
  assert.equal(e.price_for_min_margin_pct, undefined);
  const bad = (await call('GET', `/marketplaces/${mk}/economics?product_id=${p1}&price=55`)).json(); assert.equal(bad.below_min, true); assert.equal(bad.losing_money, true);
  assert.equal((await call('PUT', `/marketplaces/${mk}/listings`, { product_id: p1, price: 120, external_sku: 'MLB-1', stock_buffer: 20 })).statusCode, 200);
  assert.equal((await call('PUT', `/marketplaces/${mk}/listings`, { product_id: p1, price: 0 })).statusCode, 422);
  assert.equal((await call('PUT', `/marketplaces/${mk}/listings`, { product_id: '00000000-0000-0000-0000-000000000000', price: 10 })).statusCode, 422);
  const l = (await call('GET', `/marketplaces/${mk}/listings`)).json(); assert.equal(l.items.length, 1); const av = await stockOf(p1);
  assert.equal(l.items[0].publish_qty, av - 20); assert.equal(l.items[0].external_sku, 'MLB-1'); assert.equal(l.items[0].losing_money, false);
  const csv = await call('GET', `/marketplaces/${mk}/listings/export`); assert.equal(csv.statusCode, 200); assert.match(csv.headers['content-type'] as string, /csv/); assert.match(csv.body, /sku;sku_marketplace;descricao;preco;quantidade/); assert.match(csv.body, /MLB-1/); assert.match(csv.body, /120,00/);
  assert.equal((await call('PUT', `/marketplaces/${mk}/listings`, { product_id: p1, price: 120 }, vend)).statusCode, 403);
});

let ord: any;
test('Pedido do marketplace vira venda concluída com recebível no repasse esperado', async () => {
  const before = await stockOf(p1);
  const r = await call('POST', '/marketplace-orders', { marketplace_id: mk, external_order_id: 'ML-1001', buyer: 'Fulano', items: [{ product_id: p1, qty: 2 }] }); assert.equal(r.statusCode, 201, r.body); ord = r.json();
  assert.equal(Number(ord.gross), 240); assert.equal(Number(ord.commission), 38.4); assert.equal(Number(ord.fixed_fee), 5); assert.equal(Number(ord.shipping_cost), 10); assert.equal(Number(ord.expected_net), 186.6);
  assert.equal(await stockOf(p1), before - 2);
  const sale = (await pool.query('select * from sales where id = $1', [ord.sale_id])).rows[0]; assert.equal(sale.status, 'concluida'); assert.equal(sale.channel, 'marketplace'); assert.equal(Number(sale.total), 240);
  const rec = (await pool.query(`select due_date::text as d, status, amount, method from receivables where sale_id = $1`, [ord.sale_id])).rows[0]; assert.equal(rec.d, day(14)); assert.equal(rec.status, 'aberto'); assert.equal(rec.method, 'marketplace');
  assert.equal((await call('POST', '/marketplace-orders', { marketplace_id: mk, external_order_id: 'ML-1001', items: [{ product_id: p1, qty: 1 }] })).statusCode, 409); // duplicado
  assert.equal((await call('POST', '/marketplace-orders', { marketplace_id: mk, external_order_id: 'ML-1002', items: [{ product_id: p2, qty: 1 }] })).statusCode, 422); // sem preço nem anúncio
  assert.equal((await call('POST', '/marketplace-orders', { marketplace_id: mk, external_order_id: 'ML-1003', items: [{ product_id: p2, qty: 9999, unit_price: 90 }] })).statusCode, 409); // estoque insuficiente (e nada fica gravado)
  assert.equal((await pool.query(`select 1 from marketplace_orders where external_order_id = 'ML-1003'`)).rowCount, 0);
  assert.equal((await call('POST', '/marketplace-orders', { marketplace_id: mk, external_order_id: 'ML-1004', items: [{ product_id: p1, qty: 1 }] }, vend)).statusCode, 403);
  const list = (await call('GET', `/marketplace-orders?marketplace_id=${mk}`)).json().items; assert.equal(list.length, 1); assert.equal(list[0].sale_status, 'concluida'); assert.equal(list[0].late, false);
  // a forma "marketplace" não existe no PDV
  const pre = (await call('POST', '/sales', { type: 'balcao', items: [{ product_id: p1, qty: 1 }] })).json();
  assert.equal((await call('POST', `/sales/${pre.id}/confirm`, { payments: [{ method: 'marketplace', amount: Number(pre.total) }] })).statusCode, 422);
});

test('Repasse: baixa pelo valor cheio com as taxas reais; repasse atrasado não gera juros', async () => {
  const b0 = await balance(bank);
  const r = await call('POST', `/marketplace-orders/${ord.id}/receive`, { account_id: bank, commission: 40, shipping_cost: 12 }); assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().fee, 57); assert.equal(r.json().net, 183); assert.equal(Math.round((await balance(bank) - b0) * 100) / 100, 183);
  const o = (await pool.query('select * from marketplace_orders where id = $1', [ord.id])).rows[0]; assert.equal(o.status, 'recebido'); assert.equal(Number(o.received_net), 183);
  assert.equal((await pool.query(`select status from receivables where sale_id = $1`, [ord.sale_id])).rows[0].status, 'pago');
  assert.equal((await call('POST', `/marketplace-orders/${ord.id}/receive`, { account_id: bank })).statusCode, 409);
  // repasse atrasado: vencimento passado → baixa sem multa/juros
  const o2 = (await call('POST', '/marketplace-orders', { marketplace_id: mk, external_order_id: 'ML-2001', items: [{ product_id: p1, qty: 1 }] })).json();
  await pool.query(`update marketplace_orders set payout_date = current_date - 30 where id = $1`, [o2.id]); await pool.query(`update receivables set due_date = current_date - 30 where sale_id = $1`, [o2.sale_id]);
  const late = (await call('GET', '/marketplace-orders?late=true')).json().items; assert.ok(late.some((x: any) => x.id === o2.id));
  const a = (await call('POST', '/alerts/run')).json(); assert.deepEqual(a.errors, []); assert.ok(((await call('GET', '/alerts')).json().items as any[]).some((x) => x.fingerprint === 'mkt:repasse'));
  const rr = await call('POST', `/marketplace-orders/${o2.id}/receive`, { account_id: bank }); assert.equal(rr.statusCode, 200, rr.body);
  const st = (await pool.query(`select interest, fine from settlements where receivable_id = (select id from receivables where sale_id = $1)`, [o2.sale_id])).rows[0]; assert.equal(Number(st.interest), 0); assert.equal(Number(st.fine), 0);
  assert.equal((await call('POST', `/marketplace-orders/${o2.id}/receive`, { account_id: bank }, vend)).statusCode, 403);
});

test('Cancelamento devolve estoque; resumo mostra margem após taxas; contabilidade segue consistente', async () => {
  const before = await stockOf(p1); const o3 = (await call('POST', '/marketplace-orders', { marketplace_id: mk, external_order_id: 'ML-3001', items: [{ product_id: p1, qty: 3 }] })).json(); assert.equal(await stockOf(p1), before - 3);
  assert.equal((await call('POST', `/marketplace-orders/${o3.id}/cancel`, { reason: 'x' })).statusCode, 422);
  assert.equal((await call('POST', `/marketplace-orders/${o3.id}/cancel`, { reason: 'comprador desistiu' })).statusCode, 200); assert.equal(await stockOf(p1), before);
  assert.equal((await call('POST', `/marketplace-orders/${o3.id}/cancel`, { reason: 'de novo' })).statusCode, 409);
  assert.equal((await pool.query('select status from sales where id = $1', [o3.sale_id])).rows[0].status, 'cancelada');
  const s = (await call('GET', `/marketplaces/${mk}/summary`)).json(); assert.equal(s.orders, 2); assert.equal(s.gross, 360); assert.equal(s.pending_orders, 0);
  assert.ok(s.fees > 0 && s.margin_after_fees < (await pool.query(`select sum(margin_total) as m from sales where channel = 'marketplace' and status = 'concluida' and company_id = $1`, [cid])).rows[0].m);
  const ck = (await call('GET', '/accounting/checks')).json(); const bad = ck.checks.filter((c: { ok: boolean }) => !c.ok); assert.deepEqual(bad.map((c: { key: string }) => c.key), []);
  // anúncio no prejuízo gera alerta crítico
  await call('PUT', `/marketplaces/${mk}/listings`, { product_id: p2, price: 50 }); await call('POST', '/alerts/run');
  const al = ((await call('GET', '/alerts')).json().items as any[]).find((x) => x.fingerprint === `mkt:prejuizo:${mk}:${p2}`); assert.ok(al); assert.equal(al.severity, 'critico');
  assert.equal((await call('DELETE', `/marketplaces/${mk}/listings/${p2}`)).statusCode, 200); await call('POST', '/alerts/run');
  assert.equal(((await call('GET', '/alerts')).json().items as any[]).some((x) => x.fingerprint === `mkt:prejuizo:${mk}:${p2}`), false);
});

test('WhatsApp por link: cobrança com valor atualizado, lembrete, pedido; sem telefone não monta link', async () => {
  await pool.query(`update customers set whatsapp = '(62) 99999-1234' where id = $1`, [c1]);
  const rid = (await pool.query(`insert into receivables (company_id, customer_id, installment_no, installments, due_date, amount, method, description) values ($1,$2,1,1,current_date - 10,1000,'boleto','Duplicata 77') returning id`, [cid, c1])).rows[0].id;
  const r = (await call('POST', '/share/whatsapp', { kind: 'receivable', id: rid })).json(); assert.match(r.url, /^https:\/\/wa\.me\/5562999991234\?text=/); assert.match(r.text, /10 dia\(s\) de atraso/); assert.match(r.text, /Duplicata 77/);
  const upd = r.text.match(/atualizado hoje com multa e juros: R\$\s([\d.]+,\d{2})/)[1]; assert.ok(Number(upd.replace(/\./g, '').replace(',', '.')) > 1000); // multa + juros
  const fut = (await pool.query(`insert into receivables (company_id, customer_id, installment_no, installments, due_date, amount, method) values ($1,$2,1,1,current_date + 5,200,'boleto') returning id`, [cid, c1])).rows[0].id;
  assert.match((await call('POST', '/share/whatsapp', { kind: 'receivable', id: fut })).json().text, /Lembrete/);
  const nophone = (await pool.query(`insert into receivables (company_id, customer_id, installment_no, installments, due_date, amount, method) values ($1,$2,1,1,current_date - 1,50,'boleto') returning id`, [cid, c2])).rows[0].id;
  const np = (await call('POST', '/share/whatsapp', { kind: 'receivable', id: nophone })).json(); assert.equal(np.url, null); assert.equal(np.phone_missing, true); assert.ok(np.text.length > 20);
  const sale = await sell(c1, 'b2b', p1, 1, 0); const sh = (await call('POST', '/share/whatsapp', { kind: 'sale', id: sale.id })).json(); assert.match(sh.text, new RegExp(`Pedido nº ${sale.number}`)); assert.match(sh.text, /Total: R\$/);
  assert.equal((await call('POST', '/share/whatsapp', { kind: 'receivable', id: rid }, vend)).statusCode, 403);
  assert.equal((await call('POST', '/share/whatsapp', { kind: 'sale', id: '00000000-0000-0000-0000-000000000000' })).statusCode, 404);
  assert.ok((await pool.query(`select 1 from audit_log where company_id = $1 and action = 'share_whatsapp'`, [cid])).rowCount! >= 3);
});
