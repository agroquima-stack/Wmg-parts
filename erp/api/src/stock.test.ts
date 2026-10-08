import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { buildApp } = await import('./app.js');
const { pool, tx } = await import('./db.js');
const { createCompany } = await import('./scripts/company.js');
const { hashPassword } = await import('./lib/security.js');

let app: Awaited<ReturnType<typeof buildApp>>; let tok = ''; let vend = ''; let hq = ''; let fil = ''; let prod = '';
const call = (method: string, url: string, body?: unknown, token = tok) =>
  app.inject({ method: method as 'GET', url, payload: body as object, headers: { authorization: `Bearer ${token}` } });
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Senha12345x' } })).json().token;
const bal = async (branch: string, status = 'disponivel') =>
  Number((await pool.query('select coalesce(sum(qty),0) q from stock_balances where product_id=$1 and branch_id=$2 and status=$3', [prod, branch, status])).rows[0].q);

before(async () => {
  app = await buildApp();
  const stamp = Date.now(); const email = `est${stamp}@t.local`;
  const r = await tx((db) => createCompany(db, { legalName: 'Estoque Teste', adminName: 'Adm', adminEmail: email, adminPassword: 'Senha12345x', mustChangePassword: false }));
  hq = r.branchId;
  fil = (await pool.query(`insert into branches (company_id, code, name) values ($1,'F2','Filial 2') returning id`, [r.companyId])).rows[0].id;
  await pool.query(`insert into users (company_id, role_id, name, email, password_hash) values ($1,$2,'Vend',$3,$4)`, [r.companyId, r.roleIds.vendedor, `vend${stamp}@t.local`, await hashPassword('Senha12345x')]);
  tok = await login(email); vend = await login(`vend${stamp}@t.local`);
  prod = (await call('POST', '/products', { sku: 'S1', description: 'Peça estoque', cost_current: 10, sale_price: 30, min_stock: 5, max_stock: 50 })).json().id;
});
after(async () => { await app.close(); await pool.end(); });

const move = (op: string, qty: number, extra: object = {}, token = tok) => call('POST', '/stock/movements', { op, product_id: prod, qty, ...extra }, token);

test('entrada atualiza saldo e custo médio global', async () => {
  assert.equal((await move('entrada', 10, { unit_cost: 10 })).statusCode, 201);
  assert.equal((await move('entrada', 10, { unit_cost: 20 })).statusCode, 201);
  const p = (await call('GET', '/products/' + prod)).json();
  assert.equal(Number(p.cost_avg), 15); assert.equal(Number(p.cost_last), 20);
  assert.equal(await bal(hq), 20);
});

test('saída não deixa saldo negativo e exige motivo', async () => {
  assert.equal((await move('saida', 5)).statusCode, 422);
  const r = await move('saida', 999, { reason: 'teste' }); assert.equal(r.statusCode, 409);
  assert.equal(await bal(hq), 20);
});

test('concorrência: saídas simultâneas nunca estouram o saldo', async () => {
  const rs = await Promise.all(Array.from({ length: 8 }, () => move('saida', 5, { reason: 'concorrência' })));
  assert.equal(rs.filter((r) => r.statusCode === 201).length, 4);
  assert.equal(await bal(hq), 0);
  await move('entrada', 20, { unit_cost: 15 });
});

test('histórico registra antes/depois e é imutável', async () => {
  const m = (await call('GET', `/stock/movements?product_id=${prod}&type=saida`)).json().items[0];
  assert.equal(Number(m.qty_before) - Number(m.qty), Number(m.qty_after)); assert.ok(m.user_name);
  await assert.rejects(pool.query('update stock_movements set qty = 1 where id = $1', [m.id]), /imutável/);
  await assert.rejects(pool.query('delete from stock_movements where id = $1', [m.id]), /imutável/);
});

test('reserva, bloqueio e avaria movem entre status', async () => {
  await move('reserva', 3); assert.equal(await bal(hq, 'reservado'), 3); assert.equal(await bal(hq), 17);
  await move('liberacao', 3); assert.equal(await bal(hq), 20);
  assert.equal((await move('bloqueio', 2)).statusCode, 422);
  await move('bloqueio', 2, { reason: 'lote suspeito' }); assert.equal(await bal(hq, 'quarentena'), 2);
  await move('avaria', 1, { reason: 'caiu' }); assert.equal(await bal(hq, 'avariado'), 1);
  await move('desbloqueio', 2); assert.equal(await bal(hq), 19);
});

test('transferência: saída → trânsito → recebimento; cancelamento devolve', async () => {
  const t = (await call('POST', '/stock/transfers', { to_branch_id: fil, items: [{ product_id: prod, qty: 4 }] })).json();
  assert.equal(await bal(hq), 15); assert.equal(await bal(fil, 'transito'), 4);
  assert.equal((await call('POST', `/stock/transfers/${t.id}/receive`)).statusCode, 200);
  assert.equal(await bal(fil), 4); assert.equal(await bal(fil, 'transito'), 0);
  assert.equal((await call('POST', `/stock/transfers/${t.id}/receive`)).statusCode, 409);
  const t2 = (await call('POST', '/stock/transfers', { to_branch_id: fil, items: [{ product_id: prod, qty: 2 }] })).json();
  assert.equal((await call('POST', `/stock/transfers/${t2.id}/cancel`)).statusCode, 200);
  assert.equal(await bal(hq), 15); assert.equal(await bal(fil, 'transito'), 0);
  assert.equal((await call('POST', '/stock/transfers', { to_branch_id: fil, items: [{ product_id: prod, qty: 999 }] })).statusCode, 409);
  assert.equal(await bal(hq), 15);   // transação desfeita
});

test('inventário: contagem + fechamento só com aprovação ajusta saldo', async () => {
  const inv = (await call('POST', '/stock/inventories', { type: 'geral' })).json();
  const d = (await call('GET', '/stock/inventories/' + inv.id)).json();
  assert.equal(Number(d.items[0].system_qty), 15);
  await call('PUT', `/stock/inventories/${inv.id}/count`, { product_id: prod, counted_qty: 12 });
  assert.equal((await call('POST', `/stock/inventories/${inv.id}/close`, undefined, vend)).statusCode, 403);
  const c = await call('POST', `/stock/inventories/${inv.id}/close`); assert.equal(c.statusCode, 200, c.body);
  assert.equal(await bal(hq), 12); assert.equal(Number(c.json().loss_value), 45);
  assert.equal((await call('POST', `/stock/inventories/${inv.id}/close`)).statusCode, 409);
});

test('permissões: vendedor só consulta estoque', async () => {
  assert.equal((await call('GET', '/stock/balances', undefined, vend)).statusCode, 200);
  assert.equal((await move('entrada', 1, {}, vend)).statusCode, 403);
});

test('saldos, resumo, parados e ABC', async () => {
  const b = (await call('GET', `/stock/balances?branch_id=all&q=S1`)).json();
  assert.equal(Number(b.items[0].disponivel), 16); // 12 hq + 4 filial
  const s = (await call('GET', '/stock/summary?branch_id=all')).json(); assert.ok(Number(s.total_value) > 0);
  const idle = (await call('GET', '/stock/idle?branch_id=all')).json(); assert.equal(idle.buckets.length, 6);
  const abc = (await call('GET', '/stock/abc?criteria=valor_estoque')).json(); assert.equal(abc.items[0].class, 'A');
  assert.equal((await call('GET', '/stock/abc?criteria=faturamento')).statusCode, 422);
});
