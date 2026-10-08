// Teste de integração (precisa do Postgres com a demo: npm run seed:demo)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { buildApp } = await import('./app.js');
const { pool, tx } = await import('./db.js');
const { createCompany } = await import('./scripts/company.js');

let app: Awaited<ReturnType<typeof buildApp>>; let tok: string;
const call = (method: string, url: string, body?: unknown, token = tok) =>
  app.inject({ method: method as 'GET', url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const login = async (email: string, password = 'Demo@12345678') => {
  const r = await call('POST', '/auth/login', { email, password }, ''); return r;
};

before(async () => { app = await buildApp(); tok = (await login('admin@demo.local')).json().token; });
after(async () => { await app.close(); await pool.end(); });

test('exige autenticação e rejeita token inválido', async () => {
  assert.equal((await call('GET', '/products', undefined, '')).statusCode, 401);
  assert.equal((await call('GET', '/products', undefined, 'xxx')).statusCode, 401);
});

test('login errado não revela se o e-mail existe', async () => {
  const a = await login('admin@demo.local', 'errada'); const b = await login('naoexiste@x.com', 'errada');
  assert.equal(a.statusCode, 401); assert.equal(b.statusCode, 401);
  assert.equal(a.json().error, b.json().error);
});

test('busca por aplicação: "Pastilha CG 160 2020"', async () => {
  const r = await call('GET', '/search/applications?q=' + encodeURIComponent('Pastilha CG 160 2020'));
  const j = r.json(); assert.equal(r.statusCode, 200);
  assert.equal(j.interpreted.year, 2020);
  assert.ok(j.items.length >= 1);
  for (const it of j.items) {
    assert.match(it.description, /Pastilha/i);
    assert.ok(it.applications.some((a: { model: string; year_from: number; year_to: number | null }) => /CG 160/.test(a.model) && a.year_from <= 2020 && (a.year_to ?? 9999) >= 2020));
  }
  // modelo CG 125 Fan acabou em 2013: ano 2020 não pode retornar
  const old = (await call('GET', '/search/applications?q=' + encodeURIComponent('Pastilha CG 125 2020'))).json();
  assert.equal(old.items.length, 0);
});

test('produto: CRUD, código de barras único, auditoria de preço', async () => {
  const sku = 'T-' + Date.now();
  const c = await call('POST', '/products', { sku, description: 'Peça teste', cost_current: 10, sale_price: 20, barcodes: ['7890000' + Date.now().toString().slice(-6)] });
  assert.equal(c.statusCode, 201, c.body);
  const id = c.json().id;
  const dup = await call('POST', '/products', { sku, description: 'dup' });
  assert.equal(dup.statusCode, 409);
  const bc = (await call('GET', '/products/' + id)).json().barcodes[0];
  const dupBc = await call('POST', '/products', { sku: sku + 'b', description: 'x', barcodes: [bc] });
  assert.equal(dupBc.statusCode, 409);
  assert.equal((await call('PATCH', '/products/' + id, { sale_price: 25 })).statusCode, 200);
  const a = (await call('GET', `/audit?entity=product&entity_id=${id}`)).json();
  const actions = a.items.map((x: { action: string }) => x.action);
  assert.ok(actions.includes('create') && actions.includes('update') && actions.includes('sale_price_change'));
  const pc = a.items.find((x: { action: string }) => x.action === 'sale_price_change');
  assert.equal(Number(pc.before.sale_price), 20); assert.equal(Number(pc.after.sale_price), 25);
  assert.equal((await call('PATCH', '/products/' + id, { min_price: 999 })).statusCode, 422);
  assert.equal((await call('DELETE', '/products/' + id)).statusCode, 200);
});

test('validação de CPF/CNPJ em clientes', async () => {
  const bad = await call('POST', '/customers', { type: 'PF', document: '111.111.111-11', legal_name: 'X' });
  assert.equal(bad.statusCode, 422);
  const ok = await call('POST', '/customers', { type: 'PF', document: '529.982.247-25', legal_name: 'Cliente Teste ' + Date.now() });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().document, '52998224725');
  await call('DELETE', '/customers/' + ok.json().id);
});

test('RBAC: vendedor não cria produto nem vê usuários/auditoria', async () => {
  const v = (await login('vendedor1@demo.local')).json().token;
  assert.equal((await call('GET', '/products', undefined, v)).statusCode, 200);
  assert.equal((await call('POST', '/products', { sku: 'Z', description: 'Z' }, v)).statusCode, 403);
  assert.equal((await call('GET', '/users', undefined, v)).statusCode, 403);
  assert.equal((await call('GET', '/audit', undefined, v)).statusCode, 403);
});

test('isolamento multiempresa: outra empresa não vê nem altera dados', async () => {
  const email = `outra${Date.now()}@teste.local`;
  await tx((db) => createCompany(db, { legalName: 'Outra Empresa', adminName: 'A', adminEmail: email, adminPassword: 'Senha12345x', mustChangePassword: false }));
  const t2 = (await login(email, 'Senha12345x')).json().token;
  assert.equal((await call('GET', '/products', undefined, t2)).json().total, 0);
  const demoProd = (await call('GET', '/products?pageSize=1')).json().items[0];
  assert.equal((await call('GET', '/products/' + demoProd.id, undefined, t2)).statusCode, 404);
  assert.equal((await call('PATCH', '/products/' + demoProd.id, { description: 'hack' }, t2)).statusCode, 404);
  // referência cruzada: marca de outra empresa não pode ser usada
  const demoBrand = (await call('GET', '/brands')).json().items[0];
  const x = await call('POST', '/products', { sku: 'X1', description: 'x', brand_id: demoBrand.id }, t2);
  assert.equal(x.statusCode, 422);
});

test('senha provisória bloqueia o uso até ser trocada', async () => {
  const email = `prov${Date.now()}@teste.local`;
  await tx((db) => createCompany(db, { legalName: 'Prov', adminName: 'P', adminEmail: email, adminPassword: 'Senha12345x', mustChangePassword: true }));
  const t = (await login(email, 'Senha12345x')).json().token;
  assert.equal((await call('GET', '/products', undefined, t)).statusCode, 403);
  assert.equal((await call('POST', '/auth/change-password', { current: 'Senha12345x', next: 'NovaSenha123' }, t)).statusCode, 200);
  assert.equal((await call('GET', '/products', undefined, t)).statusCode, 200);
});
