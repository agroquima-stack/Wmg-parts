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
  const r = await tx((db) => createCompany(db, { legalName: 'IA Teste', adminName: 'Adm', adminEmail: `adm${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false })); cid = r.companyId;
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


const alerts = async (q = '') => (await call('GET', `/alerts?status=todos${q}`)).json();
const byFp = (items: any[], fp: string) => items.find((x) => x.fingerprint === fp);

test('Alertas: ruptura, abaixo do mínimo, vencidos — abrem, não duplicam e resolvem sozinhos', async () => {
  await sell(c1, 'b2b', p2, 10, 2); // zera o estoque do p2
  await pool.query('update products set min_stock = 500 where id = $1', [p1]);
  await pool.query(`insert into receivables (company_id, customer_id, installment_no, installments, due_date, amount, method) values ($1,$2,1,1,current_date - 20,350,'boleto')`, [cid, c1]);
  await pool.query(`insert into payables (company_id, supplier_id, due_date, amount) values ($1,$2,current_date - 3,900), ($1,$2,current_date + 2,100)`, [cid, sup1]);
  const run1 = (await call('POST', '/alerts/run')).json(); assert.deepEqual(run1.errors, []); assert.ok(run1.opened >= 4);
  let a = await alerts(); const rup = byFp(a.items, `ruptura:${p2}`); assert.ok(rup); assert.equal(rup.severity, 'critico'); assert.match(rup.title, /B2/);
  assert.ok(byFp(a.items, `minimo:${p1}`)); assert.ok(byFp(a.items, `inad:${c1}`)); assert.equal(byFp(a.items, 'pagar:vencidas').severity, 'critico'); assert.ok(byFp(a.items, 'pagar:vencendo'));
  const total = a.items.length; const run2 = (await call('POST', '/alerts/run')).json(); assert.equal(run2.opened, 0); a = await alerts(); assert.equal(a.items.length, total); // idempotente
  assert.ok(a.summary.critico >= 2);
  // reabastece → a ruptura some sozinha
  await call('POST', '/stock/movements', { op: 'entrada', product_id: p2, qty: 50, unit_cost: 40 }); await call('POST', '/alerts/run');
  a = await alerts(); assert.equal(byFp(a.items, `ruptura:${p2}`).status, 'resolvido'); assert.equal((await call('GET', '/alerts?status=abertos')).json().items.some((x: any) => x.fingerprint === `ruptura:${p2}`), false);
  // volta a zerar → reabre
  await sell(c1, 'b2b', p2, 50, 1); await call('POST', '/alerts/run'); assert.equal(byFp((await alerts()).items, `ruptura:${p2}`).status, 'aberto');
});

test('Alertas: reconhecer, adiar, reabrir, permissões e auditoria', async () => {
  const id = byFp((await alerts()).items, 'pagar:vencidas').id;
  assert.equal((await call('POST', `/alerts/${id}/ack`, { note: 'vou pagar amanhã' })).statusCode, 200);
  let x = byFp((await alerts()).items, 'pagar:vencidas'); assert.equal(x.status, 'reconhecido'); assert.equal(x.note, 'vou pagar amanhã');
  assert.equal((await call('POST', `/alerts/${id}/snooze`, { days: 3 })).statusCode, 200); x = byFp((await alerts()).items, 'pagar:vencidas'); assert.equal(x.status, 'adiado'); assert.ok(x.snoozed_until);
  await call('POST', '/alerts/run'); assert.equal(byFp((await alerts()).items, 'pagar:vencidas').status, 'adiado'); // continua adiado
  await pool.query(`update alerts set snoozed_until = current_date - 1 where id = $1`, [id]); await call('POST', '/alerts/run'); assert.equal(byFp((await alerts()).items, 'pagar:vencidas').status, 'aberto'); // adiamento venceu
  assert.equal((await call('POST', `/alerts/${id}/snooze`, { days: 999 })).statusCode, 422);
  assert.equal((await call('POST', `/alerts/${id}/ack`, {}, fin)).statusCode, 403); assert.equal((await call('GET', '/alerts', undefined, fin)).statusCode, 200); assert.equal((await call('GET', '/alerts', undefined, vend)).statusCode, 403);
  assert.equal((await call('POST', `/alerts/00000000-0000-0000-0000-000000000000/ack`, {})).statusCode, 404);
  assert.ok((await pool.query(`select 1 from audit_log where company_id = $1 and entity = 'alert' and entity_id = $2`, [cid, String(id)])).rowCount! >= 2);
  const sm = (await call('GET', '/alerts/summary')).json(); assert.ok(sm.total >= 4);
});

test('Alertas: regras configuráveis (desligar resolve, limites validados)', async () => {
  const rules = (await call('GET', '/alerts/rules')).json(); assert.ok(rules.length >= 12); assert.ok(rules.every((r: any) => r.label && r.description));
  assert.equal((await call('PUT', '/alerts/rules/inadimplencia', { enabled: true, params: { days: 0 } })).statusCode, 422);
  assert.equal((await call('PUT', '/alerts/rules/inadimplencia', { enabled: true, params: { xyz: 1 } })).statusCode, 422);
  assert.equal((await call('PUT', '/alerts/rules/nao_existe', { enabled: true })).statusCode, 404);
  assert.equal((await call('PUT', '/alerts/rules/inadimplencia', { enabled: true, params: { days: 30 } }, fin)).statusCode, 403);
  // tolerância de 30 dias: o título de 20 dias deixa de alertar
  assert.equal((await call('PUT', '/alerts/rules/inadimplencia', { enabled: true, params: { days: 30 } })).statusCode, 200); await call('POST', '/alerts/run'); assert.equal(byFp((await alerts()).items, `inad:${c1}`).status, 'resolvido');
  await call('PUT', '/alerts/rules/inadimplencia', { enabled: true, params: { days: 7 } }); await call('POST', '/alerts/run'); assert.equal(byFp((await alerts()).items, `inad:${c1}`).status, 'aberto');
  await call('PUT', '/alerts/rules/inadimplencia', { enabled: false, params: {} }); await call('POST', '/alerts/run'); assert.equal(byFp((await alerts()).items, `inad:${c1}`).status, 'resolvido');
  await call('PUT', '/alerts/rules/inadimplencia', { enabled: true, params: {} });
});

test('Alertas de meta só existem se houver meta cadastrada; margem baixa e queda de cliente', async () => {
  await call('POST', '/alerts/run'); assert.equal(byFp((await alerts()).items, 'margem_geral'), undefined);
  await call('PUT', '/bi/goals', { kind: 'margem_bruta_pct', target: 99 }); await call('POST', '/alerts/run'); assert.ok(byFp((await alerts()).items, 'margem_geral')); // meta irreal → alerta
  await call('DELETE', `/bi/goals/${(await call('GET', '/bi/goals')).json().items.find((g: any) => g.kind === 'margem_bruta_pct').id}`); await call('POST', '/alerts/run'); assert.equal(byFp((await alerts()).items, 'margem_geral').status, 'resolvido');
  await pool.query('update products set min_margin_pct = 80 where id = $1', [p1]); await call('POST', '/alerts/run'); assert.ok(byFp((await alerts()).items, `margem:${p1}`)); await pool.query('update products set min_margin_pct = 10 where id = $1', [p1]);
});

test('Previsão: série (média ponderada + tendência) e endpoint com confiança honesta', async () => {
  const { forecastSeries } = await import('./intelligence.js');
  const flat = forecastSeries(Array(12).fill(10), 4); assert.equal(Math.round(flat.wma), 10); assert.ok(flat.forecast.every((v) => Math.abs(v - 10) < 0.01)); assert.equal(flat.trend_pct, 0);
  const up = forecastSeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 8); assert.ok(up.forecast[7] > up.wma); assert.ok(up.forecast[7] <= up.wma * 1.5 + 0.0001); // tendência limitada
  const zero = forecastSeries(Array(12).fill(0), 3); assert.deepEqual(zero.forecast, [0, 0, 0]);
  const down = forecastSeries([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 8); assert.ok(down.forecast.every((v) => v >= 0));
  const f = (await call('GET', `/ai/forecast?product_id=${p1}&weeks=6`)).json();
  assert.equal(f.history.length, 12); assert.equal(f.forecast.length, 6); assert.equal(f.confidence, 'baixa'); assert.match(f.note, /histórico/); assert.ok(f.method);
  assert.equal((await call('GET', `/ai/forecast?product_id=00000000-0000-0000-0000-000000000000`)).statusCode, 404);
  assert.equal((await call('GET', `/ai/forecast?product_id=${p1}`, undefined, vend)).statusCode, 403);
  const cov = (await call('GET', '/ai/coverage')).json(); assert.ok(Array.isArray(cov));
});

test('Recomendações trazem a base de cada sugestão', async () => {
  const r = (await call('GET', '/ai/recommendations')).json(); assert.ok(Array.isArray(r)); assert.ok(r.length > 0);
  for (const x of r) { assert.ok(x.basis && x.title && x.link && x.kind); }
  assert.ok(r.some((x: any) => x.kind === 'cobrar'));
});

test('Pergunte à Empresa: responde com dados, cita a origem e admite quando não entende', async () => {
  const ask = async (question: string, token = adm) => (await call('POST', '/ai/ask', { question }, token)).json();
  const fat = await ask('Quanto vendemos nos últimos 30 dias?'); assert.equal(fat.intent, 'faturamento'); assert.match(fat.answer, /R\$/); assert.ok(fat.source);
  const exp = Number((await pool.query(`select coalesce(sum(total),0) as v from sales where company_id = $1 and status = 'concluida' and confirmed_at::date >= current_date - 29`, [cid])).rows[0].v);
  assert.ok(fat.answer.includes(exp.toLocaleString('pt-BR', { minimumFractionDigits: 2 })), fat.answer); // o número é o do banco
  assert.equal((await ask('Qual vendedor vende mais?')).intent, 'vendedor');
  assert.equal((await ask('Quem está devendo?')).intent, 'inadimplencia');
  assert.equal((await ask('Quais clientes estão comprando menos?')).intent, 'cliente_queda');
  assert.equal((await ask('O que precisamos comprar?')).intent, 'comprar');
  assert.equal((await ask('Quais produtos estão sem estoque?')).intent, 'ruptura');
  assert.equal((await ask('Quanto dinheiro está parado?')).intent, 'parado');
  assert.equal((await ask('Quanto teremos em caixa em 30/60/90 dias?')).intent, 'caixa');
  assert.equal((await ask('Quanto temos a pagar?')).intent, 'pagar');
  assert.equal((await ask('Quanto pagaremos de impostos?')).intent, 'impostos');
  assert.equal((await ask('Qual produto é mais rentável?')).intent, 'produto_top');
  assert.equal((await ask('Quais alertas estão abertos?')).intent, 'alertas');
  assert.equal((await ask('Onde estamos perdendo margem?')).intent, 'margem_baixa');
  assert.equal((await ask('Quanto temos em estoque?')).intent, 'estoque');
  const prod = await ask('Quando acaba o estoque do B1?'); assert.equal(prod.intent, 'previsao'); assert.match(prod.answer, /B1/); assert.ok(prod.table);
  const nope = await ask('Qual a cor do céu em Marte?'); assert.equal(nope.intent, null); assert.match(nope.answer, /Não entendi/);
  assert.equal((await call('POST', '/ai/ask', { question: 'ok' })).statusCode, 422);
  assert.equal((await call('POST', '/ai/ask', { question: 'Quanto vendemos?' }, vend)).statusCode, 403);
  assert.ok((await pool.query(`select 1 from ask_log where company_id = $1 and answered = false`, [cid])).rowCount! >= 1);
  assert.ok(((await call('GET', '/ai/examples')).json() as string[]).length >= 10);
});

test('Isolamento entre empresas nos alertas', async () => {
  const st = Date.now(); const r = await tx((db) => createCompany(db, { legalName: 'Outra IA', adminName: 'X', adminEmail: `x${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false }));
  const other = await login(`x${st}@t.local`); const mine = await alerts(); assert.ok(mine.items.length > 0);
  const theirs = (await call('GET', '/alerts?status=todos', undefined, other)).json(); assert.equal(theirs.items.length, 0);
  assert.equal((await call('POST', `/alerts/${mine.items[0].id}/ack`, {}, other)).statusCode, 404); void r;
});
