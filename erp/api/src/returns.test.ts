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
  const r = await tx((db) => createCompany(db, { legalName: 'Dev Teste', adminName: 'Adm', adminEmail: `adm${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false })); cid = r.companyId;
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


let bank = '';
const stockQ = async (p: string, st: string) => Number((await pool.query(`select coalesce(sum(qty),0) as q from stock_balances where company_id = $1 and product_id = $2 and status = $3`, [cid, p, st])).rows[0].q);
const checks = async () => { const ck = (await call('GET', '/accounting/checks')).json(); return ck.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { key: string }) => c.key); };
const itemOf = async (saleId: string, product: string) => (await pool.query('select id, unit_cost, unit_price from sale_items where sale_id = $1 and product_id = $2', [saleId, product])).rows[0];
const ledger = async (key: string) => (await pool.query(`select coalesce(sum(l.debit),0) as d, coalesce(sum(l.credit),0) as c from journal_lines l join ledger_accounts a on a.id = l.account_id where l.company_id = $1 and a.system_key = $2`, [cid, key])).rows[0];
let saleA: any;

test('Devolução parcial de venda com título em aberto: abate o título, volta ao estoque e o razão fecha', async () => {
  bank = (await call('POST', '/bank-accounts', { name: 'BTG', kind: 'banco', opening_balance: 0 })).json().id;
  saleA = await sell(c1, 'b2b', p1, 10, 0); const item = await itemOf(saleA.id, p1); const total = Number(saleA.total); const st0 = await stockQ(p1, 'disponivel');
  const info = (await call('GET', `/sales/${saleA.id}/returnable`)).json(); assert.equal(info.items[0].remaining, 10);
  const r = await call('POST', '/sale-returns', { sale_id: saleA.id, reason: 'Cliente comprou a mais', items: [{ sale_item_id: item.id, qty: 3, condition: 'revenda' }] }); assert.equal(r.statusCode, 201, r.body); const ret = r.json();
  assert.equal(Number(ret.total), Math.round(Number(item.unit_price) * 3 * 100) / 100); assert.equal(Number(ret.abated), Number(ret.total)); assert.equal(Number(ret.refunded), 0); assert.equal(ret.refund_payable_id, null);
  assert.equal(await stockQ(p1, 'disponivel'), st0 + 3);
  const rec = (await pool.query(`select amount, status from receivables where sale_id = $1`, [saleA.id])).rows; assert.equal(Math.round(rec.reduce((s: number, x: any) => s + Number(x.amount), 0) * 100) / 100, Math.round((total - Number(ret.total)) * 100) / 100);
  assert.equal((await call('GET', `/sales/${saleA.id}/returnable`)).json().items[0].remaining, 7);
  assert.deepEqual(await checks(), []);
  const dev = await ledger('devolucoes'); assert.ok(Number(dev.d) >= Number(ret.total));
  // limites e regras
  assert.equal((await call('POST', '/sale-returns', { sale_id: saleA.id, reason: 'excesso', items: [{ sale_item_id: item.id, qty: 8 }] })).statusCode, 422);
  assert.equal((await call('POST', '/sale-returns', { sale_id: saleA.id, reason: 'x', items: [{ sale_item_id: item.id, qty: 1 }] })).statusCode, 422); // motivo curto
  assert.equal((await call('POST', '/sale-returns', { sale_id: saleA.id, reason: 'sem permissão', items: [{ sale_item_id: item.id, qty: 1 }] }, vend)).statusCode, 403);
  const open = (await call('POST', '/sales', { type: 'b2b', customer_id: c1, items: [{ product_id: p1, qty: 1 }] })).json();
  assert.equal((await call('POST', '/sale-returns', { sale_id: open.id, reason: 'pedido aberto', items: [{ sale_item_id: (await itemOf(open.id, p1)).id, qty: 1 }] })).statusCode, 409);
  assert.equal((await call('GET', `/sale-returns?sale_id=${saleA.id}`)).json().items.length, 1);
  assert.equal((await call('GET', `/sale-returns/${ret.id}`)).json().items.length, 1);
});

test('Devolução de venda já recebida gera restituição; item avariado vai para o estoque avariado; comissão acompanha', async () => {
  const sale = await sell(c2, 'externo', p1, 4, 0, vend); const item = await itemOf(sale.id, p1);
  const commBefore = Number((await pool.query('select commission_amount from sales where id = $1', [sale.id])).rows[0].commission_amount);
  const rid = (await pool.query(`select id from receivables where sale_id = $1`, [sale.id])).rows[0].id;
  assert.equal((await call('POST', `/receivables/${rid}/settle`, { account_id: bank })).statusCode, 200);
  const av0 = await stockQ(p1, 'avariado');
  const r = await call('POST', '/sale-returns', { sale_id: sale.id, reason: 'Produto com defeito', items: [{ sale_item_id: item.id, qty: 2, condition: 'avariado' }] }); assert.equal(r.statusCode, 201, r.body); const ret = r.json();
  assert.equal(Number(ret.abated), 0); assert.equal(Number(ret.refunded), Number(ret.total)); assert.ok(ret.refund_payable_id);
  const pay = (await pool.query('select amount, status, description from payables where id = $1', [ret.refund_payable_id])).rows[0]; assert.equal(Number(pay.amount), Number(ret.total)); assert.equal(pay.status, 'aberto'); assert.match(pay.description, /Restituição/);
  assert.equal(await stockQ(p1, 'avariado'), av0 + 2);
  const commAfter = Number((await pool.query('select commission_amount from sales where id = $1', [sale.id])).rows[0].commission_amount); if (commBefore > 0) assert.ok(commAfter < commBefore && Math.abs(commAfter - commBefore / 2) < 0.02);
  assert.deepEqual(await checks(), []);
  // pagar a restituição fecha o ciclo
  assert.equal((await call('POST', `/payables/${ret.refund_payable_id}/settle`, { account_id: bank })).statusCode, 200); assert.deepEqual(await checks(), []);
  // devolver o resto: abate nada (já pago), restitui mais
  const rest = await call('POST', '/sale-returns', { sale_id: sale.id, reason: 'Devolução do restante', items: [{ sale_item_id: item.id, qty: 2 }] }); assert.equal(rest.statusCode, 201); assert.equal((await call('POST', '/sale-returns', { sale_id: sale.id, reason: 'de novo', items: [{ sale_item_id: item.id, qty: 1 }] })).statusCode, 422);
});

let claim: any, saleW: any;
test('Garantia: prazo, fora do prazo exige concessão, troca move estoque e mantém o razão em dia', async () => {
  saleW = await sell(c1, 'b2b', p2, 5, 0); const item = await itemOf(saleW.id, p2);
  const o = await call('POST', '/warranty', { sale_item_id: item.id, qty: 1, defect: 'Não funciona após 10 dias' }); assert.equal(o.statusCode, 201, o.body); claim = o.json();
  assert.equal(claim.in_warranty, true); assert.equal(claim.warranty_days, 90); assert.equal(claim.status, 'aberta'); assert.equal(claim.customer_id, c1);
  assert.equal((await call('POST', '/warranty', { sale_item_id: item.id, qty: 99, defect: 'quantidade maior' })).statusCode, 422); assert.equal((await call('POST', '/warranty', { sale_item_id: item.id, qty: 1, defect: 'x' })).statusCode, 422);
  assert.equal((await call('POST', `/warranty/${claim.id}/analysis`, { note: 'em teste' }, adm)).statusCode, 200);
  assert.equal((await call('POST', `/warranty/${claim.id}/resolve`, { resolution: 'troca', note: 'ok' }, vend)).statusCode, 403); // vendedor abre, gestor decide
  const disp0 = await stockQ(p2, 'disponivel'), av0 = await stockQ(p2, 'avariado');
  const r = await call('POST', `/warranty/${claim.id}/resolve`, { resolution: 'troca', note: 'Defeito de fabricação confirmado' }); assert.equal(r.statusCode, 200, r.body); const c = r.json();
  assert.equal(c.status, 'resolvida'); assert.equal(c.resolution, 'troca'); assert.equal(Number(c.defective_pending), 1);
  assert.equal(await stockQ(p2, 'disponivel'), disp0 - 1); assert.equal(await stockQ(p2, 'avariado'), av0 + 1); assert.deepEqual(await checks(), []);
  assert.equal((await call('POST', `/warranty/${claim.id}/resolve`, { resolution: 'troca', note: 'de novo' })).statusCode, 409);
  // fora do prazo
  await pool.query(`update sales set confirmed_at = now() - interval '120 days' where id = $1`, [saleW.id]);
  const old = (await call('POST', '/warranty', { sale_item_id: item.id, qty: 1, defect: 'Falhou depois de muito tempo' })).json(); assert.equal(old.in_warranty, false);
  const bad = await call('POST', `/warranty/${old.id}/resolve`, { resolution: 'troca', note: 'tentativa' }); assert.equal(bad.statusCode, 422); assert.equal(bad.json().code, 'out_of_warranty');
  assert.equal((await call('POST', `/warranty/${old.id}/resolve`, { resolution: 'recusa', note: 'Fora do prazo' })).json().status, 'recusada');
  // prazo por produto sobrescreve o padrão
  await pool.query('update products set warranty_days = 200 where id = $1', [p2]); assert.equal((await call('POST', '/warranty', { sale_item_id: item.id, qty: 1, defect: 'Dentro do prazo do produto' })).json().in_warranty, true);
  await pool.query('update products set warranty_days = null where id = $1', [p2]);
  assert.equal((await call('PUT', '/warranty/settings', { default_warranty_days: 30 })).statusCode, 200); assert.equal((await call('GET', '/warranty/settings')).json().default_warranty_days, 30); await call('PUT', '/warranty/settings', { default_warranty_days: 90 });
});

test('Garantia: resposta do fornecedor (crédito ou recusa) baixa o estoque avariado e reconhece o resultado', async () => {
  const av0 = await stockQ(p2, 'avariado'); const cost = Number((await pool.query('select cost_avg from products where id = $1', [p2])).rows[0].cost_avg);
  assert.equal((await call('POST', `/warranty/${claim.id}/supplier`, { outcome: 'credito' })).statusCode, 422); // sem fornecedor/valor
  const cr = await call('POST', `/warranty/${claim.id}/supplier`, { outcome: 'credito', supplier_id: sup1, amount: 35 }); assert.equal(cr.statusCode, 200, cr.body); assert.equal(cr.json().supplier_status, 'credito'); assert.equal(Number(cr.json().defective_pending), 0);
  assert.equal(await stockQ(p2, 'avariado'), av0 - 1);
  const pay = (await pool.query(`select kind, amount from payables where supplier_id = $1 and description like 'Crédito de garantia%'`, [sup1])).rows[0]; assert.equal(pay.kind, 'credito'); assert.equal(Number(pay.amount), 35);
  assert.deepEqual(await checks(), []); assert.equal((await call('POST', `/warranty/${claim.id}/supplier`, { outcome: 'recusado' })).statusCode, 409);
  // reembolso + fornecedor recusa → perda
  const item2 = await itemOf(saleW.id, p2); await pool.query(`update sales set confirmed_at = now() where id = $1`, [saleW.id]);
  const c2 = (await call('POST', '/warranty', { sale_item_id: item2.id, qty: 1, defect: 'Quebrou na instalação' })).json();
  const rr = await call('POST', `/warranty/${c2.id}/resolve`, { resolution: 'reembolso', note: 'Reembolso aprovado' }); assert.equal(rr.statusCode, 200, rr.body); assert.ok(rr.json().return_id); assert.equal(Number(rr.json().defective_pending), 1);
  const g0 = await ledger('desp_garantias'); const rf = await call('POST', `/warranty/${c2.id}/supplier`, { outcome: 'recusado' }); assert.equal(rf.statusCode, 200, rf.body);
  const g1 = await ledger('desp_garantias'); assert.ok(Math.abs((Number(g1.d) - Number(g0.d)) - Number(item2.unit_cost)) < 0.02, `perda ${Number(g1.d) - Number(g0.d)} × custo ${item2.unit_cost}`);
  assert.deepEqual(await checks(), []); void cost;
  const pend = (await call('GET', '/warranty?pending_supplier=true')).json().items; assert.equal(pend.length, 0);
  // reparo e solicitação sem venda
  const sv = (await call('POST', '/warranty', { product_id: p1, qty: 1, defect: 'Cliente sem nota fiscal' })).json(); assert.equal(sv.in_warranty, null);
  assert.equal((await call('POST', `/warranty/${sv.id}/resolve`, { resolution: 'reembolso', note: 'sem venda' })).statusCode, 422);
  assert.equal((await call('POST', `/warranty/${sv.id}/resolve`, { resolution: 'reparo', note: 'Enviado para conserto' })).json().status, 'resolvida');
});

const manual = async (date: string, amount: number, desc: string, token = adm) => {
  const acc = async (k: string) => (await pool.query(`select id from ledger_accounts where company_id = $1 and system_key = $2`, [cid, k])).rows[0].id;
  return call('POST', '/accounting/entries', { date, description: desc, lines: [{ account_id: await acc('outras_despesas'), debit: amount }, { account_id: await acc('outras_pagar'), credit: amount }] }, token);
};
const ym = (d: number) => { const x = new Date(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() - d); return x.toISOString().slice(0, 7); };
test('Fechamento contábil: sequência, bloqueio de lançamentos, reabertura e verificação de integridade', async () => {
  assert.equal((await manual(`${ym(3)}-10`, 100, 'Despesa de teste m-3')).statusCode, 201); assert.equal((await manual(`${ym(2)}-10`, 200, 'Despesa de teste m-2')).statusCode, 201);
  const list = (await call('GET', '/accounting/periods')).json(); assert.equal(list.items[0].status, 'em_andamento'); assert.ok(list.items.some((x: any) => x.period === ym(3)));
  const ck = (await call('GET', `/accounting/periods/${ym(2)}/checks`)).json(); assert.equal(ck.blocking_ok, false); assert.ok(ck.checks.find((c: any) => c.key === 'sequencia' && !c.ok)); // m-3 ainda aberto
  assert.equal((await call('POST', `/accounting/periods/${ym(2)}/close`, {})).statusCode, 409);
  assert.equal((await call('POST', `/accounting/periods/${ym(3)}/close`, {}, fin)).statusCode, 403);
  const c3 = await call('POST', `/accounting/periods/${ym(3)}/close`, { note: 'Fechamento de teste' }); assert.equal(c3.statusCode, 200, c3.body); assert.ok(c3.json().checksum); assert.ok(c3.json().snapshot.dre); assert.equal(c3.json().snapshot.balance.equilibrado, true);
  assert.equal((await call('POST', `/accounting/periods/${ym(3)}/close`, {})).statusCode, 409); // já fechado
  assert.equal((await call('POST', `/accounting/periods/${ym(0)}/close`, {})).statusCode, 409); // mês corrente
  // lançamento em período fechado é recusado pelo banco (data ou competência)
  const blocked = await manual(`${ym(3)}-20`, 50, 'Tentativa em período fechado'); assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().code, 'period_closed'); assert.match(blocked.json().error, new RegExp(`${ym(3).slice(5)}/${ym(3).slice(0, 4)}`));
  const comp = await call('POST', '/accounting/entries', { date: `${ym(2)}-12`, competence: `${ym(3)}-01`, description: 'Competência em período fechado', lines: [{ account_id: (await pool.query(`select id from ledger_accounts where company_id = $1 and system_key = 'outras_despesas'`, [cid])).rows[0].id, debit: 10 }, { account_id: (await pool.query(`select id from ledger_accounts where company_id = $1 and system_key = 'outras_pagar'`, [cid])).rows[0].id, credit: 10 }] }); assert.equal(comp.statusCode, 409);
  assert.equal((await manual(`${ym(2)}-20`, 5, 'Mês seguinte continua aberto')).statusCode, 201);
  // verificação de integridade
  assert.equal((await call('GET', `/accounting/periods/${ym(3)}/verify`)).json().intact, true);
  // m-2 pode ser fechado agora (sequência ok); a nota de m-3 não mudou
  const c2 = await call('POST', `/accounting/periods/${ym(2)}/close`, {}); assert.equal(c2.statusCode, 200, c2.body);
  // reabrir: só o mais recente, com motivo
  assert.equal((await call('POST', `/accounting/periods/${ym(3)}/reopen`, { reason: 'ajuste necessário aqui' })).statusCode, 409);
  assert.equal((await call('POST', `/accounting/periods/${ym(2)}/reopen`, { reason: 'curto' })).statusCode, 422);
  assert.equal((await call('POST', `/accounting/periods/${ym(2)}/reopen`, { reason: 'Correção de lançamento esquecido' }, fin)).statusCode, 403);
  assert.equal((await call('POST', `/accounting/periods/${ym(2)}/reopen`, { reason: 'Correção de lançamento esquecido' })).statusCode, 200);
  assert.equal((await manual(`${ym(2)}-25`, 7, 'Lançamento após reabertura')).statusCode, 201);
  assert.equal((await call('POST', `/accounting/periods/${ym(2)}/close`, { note: 'Refechado' })).statusCode, 200);
  const lst = (await call('GET', '/accounting/periods')).json().items; assert.equal(lst.find((x: any) => x.period === ym(2)).status, 'fechado'); assert.equal(lst.find((x: any) => x.period === ym(2)).reopen_reason, 'Correção de lançamento esquecido');
  assert.equal((await call('GET', `/accounting/periods/${ym(2)}/verify`)).json().intact, true);
  assert.ok((await pool.query(`select 1 from audit_log where company_id = $1 and entity = 'accounting_period' and action in ('close','reopen')`, [cid])).rowCount! >= 4);
  // operações normais do mês corrente seguem funcionando
  const s = await sell(c1, 'b2b', p1, 1, 0); assert.ok(s.id); assert.equal((await call('GET', `/accounting/periods/abc/checks`)).statusCode, 422);
});
