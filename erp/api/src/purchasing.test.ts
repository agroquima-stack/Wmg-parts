import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { buildApp } = await import('./app.js');
const { pool, tx } = await import('./db.js');
const { createCompany } = await import('./scripts/company.js');
const { hashPassword } = await import('./lib/security.js');
const { allocateCosts } = await import('./purchasing.js');
const { parseNFe } = await import('./lib/nfe.js');

let app: Awaited<ReturnType<typeof buildApp>>; let adm = '', buyer = '', stockist = '', seller = '', ger = '', other = '';
let sup1 = '', sup2 = '', pA = '', pB = '', hq = '';
const call = (method: string, url: string, body?: unknown, token = adm) =>
  app.inject({ method: method as 'GET', url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Senha12345x' } })).json().token;
const stock = async (id: string) => Number((await pool.query(`select coalesce(sum(qty),0) q from stock_balances where product_id=$1 and status='disponivel'`, [id])).rows[0].q);
const prod = async (id: string) => (await call('GET', '/products/' + id)).json();
const rnd = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

const xml = (o: { nf?: string; cnpj?: string; items: { cProd: string; ean?: string; qty: number; price: number; ipi?: number }[]; freight?: number; discount?: number; dups?: [string, number][] }) => {
  const prods = o.items.reduce((s, i) => s + i.qty * i.price, 0), ipi = o.items.reduce((s, i) => s + (i.ipi ?? 0), 0);
  const nf = prods + ipi + (o.freight ?? 0) - (o.discount ?? 0);
  return `<?xml version="1.0"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${rnd(44)}" versao="4.00"><ide><nNF>${o.nf ?? rnd(6)}</nNF><serie>1</serie><dhEmi>2026-10-01T10:00:00-03:00</dhEmi></ide>
  <emit><CNPJ>${o.cnpj ?? '11222333000181'}</CNPJ><xNome>Fornecedor XML</xNome></emit>
  ${o.items.map((i, k) => `<det nItem="${k + 1}"><prod><cProd>${i.cProd}</cProd><cEAN>${i.ean ?? 'SEM GTIN'}</cEAN><xProd>Item ${i.cProd}</xProd><NCM>87141000</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>${i.qty}.0000</qCom><vUnCom>${i.price}.0000</vUnCom><vProd>${(i.qty * i.price).toFixed(2)}</vProd></prod><imposto><IPI><IPITrib><vIPI>${(i.ipi ?? 0).toFixed(2)}</vIPI></IPITrib></IPI></imposto></det>`).join('')}
  <total><ICMSTot><vProd>${prods.toFixed(2)}</vProd><vFrete>${(o.freight ?? 0).toFixed(2)}</vFrete><vSeg>0.00</vSeg><vDesc>${(o.discount ?? 0).toFixed(2)}</vDesc><vOutro>0.00</vOutro><vIPI>${ipi.toFixed(2)}</vIPI><vNF>${nf.toFixed(2)}</vNF></ICMSTot></total>
  ${o.dups ? `<cobr>${o.dups.map(([d, v], k) => `<dup><nDup>00${k + 1}</nDup><dVenc>${d}</dVenc><vDup>${v.toFixed(2)}</vDup></dup>`).join('')}</cobr>` : ''}</infNFe></NFe></nfeProc>`;
};

before(async () => {
  app = await buildApp(); const st = Date.now(); const pw = await hashPassword('Senha12345x');
  const r = await tx((db) => createCompany(db, { legalName: 'Compras Teste', adminName: 'Adm', adminEmail: `adm${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false }));
  hq = r.branchId;
  for (const [role, k] of [['comprador', 'b'], ['estoquista', 'e'], ['vendedor', 'v'], ['gerente', 'g']] as const)
    await pool.query(`insert into users (company_id, role_id, name, email, password_hash) values ($1,$2,$3,$4,$5)`, [r.companyId, r.roleIds[role], role, `${k}${st}@t.local`, pw]);
  adm = await login(`adm${st}@t.local`); buyer = await login(`b${st}@t.local`); stockist = await login(`e${st}@t.local`); seller = await login(`v${st}@t.local`); ger = await login(`g${st}@t.local`);
  const o = await tx((db) => createCompany(db, { legalName: 'Outra', adminName: 'O', adminEmail: `o${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false }));
  void o; other = await login(`o${st}@t.local`);
  sup1 = (await call('POST', '/suppliers', { legal_name: 'Fornecedor Um', cnpj: '11.222.333/0001-81', payment_terms_days: 30, lead_time_days: 5 })).json().id;
  sup2 = (await call('POST', '/suppliers', { legal_name: 'Fornecedor Dois', payment_terms_days: 45, lead_time_days: 10 })).json().id;
  const mk = async (sku: string, extra: object = {}) => (await call('POST', '/products', { sku, description: `Produto ${sku}`, cost_current: 10, sale_price: 30, manufacturer_code: `FAB-${sku}`, ...extra })).json().id;
  pA = await mk('PA', { barcodes: ['7891234567895'] }); pB = await mk('PB', { min_stock: 10, max_stock: 100, ideal_stock: 30 });
  await call('POST', '/stock/movements', { op: 'entrada', product_id: pA, qty: 10, unit_cost: 10 });   // estoque inicial: 10 un a custo 10
});
after(async () => { await app.close(); await pool.end(); });

test('rateio de custo (Simples, sem crédito): item + IPI + frete − desconto', () => {
  const c = allocateCosts([{ qty_nf: 10, unit_price_nf: 10, ipi: 5 }, { qty_nf: 20, unit_price_nf: 5, ipi: 0 }], { freight: 20, insurance: 0, other_expenses: 0, discount: 10 });
  assert.deepEqual(c, [11, 5.25]);
});

test('leitor de NF-e: itens, totais, duplicatas; recusa DTD e arquivos que não são NF-e', () => {
  const n = parseNFe(xml({ nf: '77', items: [{ cProd: 'X1', ean: '7891234567895', qty: 2, price: 10, ipi: 1 }], freight: 3, dups: [['2026-11-01', 12], ['2026-12-01', 12]] }));
  assert.equal(n.number, '77'); assert.equal(n.supplier.cnpj, '11222333000181'); assert.equal(n.items[0].ean, '7891234567895'); assert.equal(n.totals.nf, 24); assert.equal(n.installments.length, 2); assert.equal(n.key?.length, 44);
  assert.throws(() => parseNFe('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><NFe/>'), /DTD/);
  assert.throws(() => parseNFe('<html></html>'), /NF-e/);
  assert.equal(parseNFe(xml({ items: [{ cProd: 'Y', qty: 1, price: 1 }] })).items[0].ean, null);   // "SEM GTIN" ignorado
});

test('importação de XML: fornecedor pelo CNPJ, casamento por EAN, conferência e entrada com custo final', async () => {
  const x = xml({ nf: '1001', items: [{ cProd: 'F-A', ean: '7891234567895', qty: 10, price: 20, ipi: 10 }, { cProd: 'F-B', qty: 10, price: 20 }], freight: 20, discount: 10, dups: [['2099-01-10', 106], ['2099-02-10', 106]] });
  const r = await call('POST', '/receivings/import-xml', { xml: x }); assert.equal(r.statusCode, 201, r.body); const id = r.json().id;
  const d = (await call('GET', '/receivings/' + id)).json();
  assert.equal(d.status, 'em_conferencia'); assert.equal(d.items.length, 2);
  const a = d.items.find((i: { supplier_code: string }) => i.supplier_code === 'F-A'), b = d.items.find((i: { supplier_code: string }) => i.supplier_code === 'F-B');
  assert.equal(a.product_id, pA); assert.equal(b.product_id, null);            // A casou pelo EAN; B precisa ser vinculado
  assert.equal((await call('POST', `/receivings/${id}/finish`, {})).json().code, 'unmapped_items');
  assert.equal((await call('PATCH', `/receivings/${id}/items/${b.id}`, { product_id: pB })).statusCode, 200);
  assert.equal((await call('POST', `/receivings/${id}/finish`, {})).json().code, 'unchecked_items');
  await call('POST', `/receivings/${id}/check-all`);
  const f = await call('POST', `/receivings/${id}/finish`, {}); assert.equal(f.statusCode, 200, f.body); assert.equal(f.json().payables, 2);
  // Custo final: vProd 200 + IPI 10 + frete 20 − desc 10 = 220; A: 200 + 10 + 10 − 5 = 215 → 21,50/un; B: 200 + 10 − 5 = 205 → 20,50/un
  assert.equal(await stock(pA), 20); assert.equal(await stock(pB), 10);
  const A = await prod(pA); assert.equal(Number(A.cost_last), 21.5); assert.equal(Number(A.cost_avg), 15.75);   // média global: (10×10 + 10×21,5)/20
  assert.equal(Number((await prod(pB)).cost_avg), 20.5);
  const pay = (await pool.query(`select amount, due_date::text from payables where receiving_id = $1 order by installment_no`, [id])).rows; assert.deepEqual(pay.map((p) => Number(p.amount)), [106, 106]); assert.equal(pay[0].due_date, '2099-01-10');
  const mov = (await call('GET', `/stock/movements?product_id=${pA}&type=entrada`)).json().items[0]; assert.equal(mov.document_type, 'NF'); assert.equal(mov.document_ref, '1001');
  assert.equal((await call('POST', `/receivings/${id}/finish`, {})).statusCode, 409);
  // mapeamento aprendido: próxima NF casa F-B sozinha
  const r2 = (await call('POST', '/receivings/import-xml', { xml: xml({ items: [{ cProd: 'F-B', qty: 1, price: 20 }] }) })).json();
  assert.ok((await call('GET', '/receivings/' + r2.id)).json().items[0].product_id === pB);
  await call('POST', `/receivings/${r2.id}/cancel`);
});

test('NF duplicada é recusada; fornecedor desconhecido pode ser cadastrado a partir do XML', async () => {
  const x = xml({ nf: '2002', items: [{ cProd: 'F-A', qty: 1, price: 10 }] });
  assert.equal((await call('POST', '/receivings/import-xml', { xml: x })).statusCode, 201);
  const dup = await call('POST', '/receivings/import-xml', { xml: x.replace(/Id="NFe\d{44}"/, `Id="NFe${rnd(44)}"`) }); assert.equal(dup.statusCode, 409); assert.equal(dup.json().code, 'duplicate_nf');
  const unk = xml({ cnpj: '04252011000110', items: [{ cProd: 'Z', qty: 1, price: 1 }] });
  const e = await call('POST', '/receivings/import-xml', { xml: unk }); assert.equal(e.statusCode, 422); assert.equal(e.json().code, 'supplier_not_found');
  assert.equal((await call('POST', '/receivings/import-xml', { xml: unk, create_supplier: true })).statusCode, 201);
  assert.equal((await call('POST', '/receivings/import-xml', { xml: '<x/>' })).statusCode, 422);
});

test('pedido de compra sem limite de aprovação: emitir já aprova; recebimento parcial → recebido; quantidade menor exige aceite', async () => {
  const po = (await call('POST', '/purchase-orders', { supplier_id: sup2, items: [{ product_id: pA, qty: 10, unit_price: 12 }], submit: true, freight: 5 }, buyer)).json();
  assert.equal(po.status, 'aprovado'); assert.equal(Number(po.total), 125);
  const before = await stock(pA);
  const rc = (await call('POST', '/receivings', { supplier_id: sup2, po_id: po.id, nf_number: 'M-1', items: [{ product_id: pA, qty: 10, unit_price: 12 }] }, buyer)).json();
  const item = (await call('GET', '/receivings/' + rc.id)).json().items[0];
  await call('PATCH', `/receivings/${rc.id}/items/${item.id}`, { qty_received: 6 }, stockist);
  const need = await call('POST', `/receivings/${rc.id}/finish`, {}, buyer); assert.equal(need.statusCode, 409); assert.equal(need.json().code, 'divergences'); assert.ok(need.json().divergences.includes('quantidade_menor'));
  assert.equal((await call('POST', `/receivings/${rc.id}/finish`, { accept_divergences: true }, buyer)).statusCode, 200);
  assert.equal(await stock(pA), before + 6);
  const p1 = (await call('GET', '/purchase-orders/' + po.id)).json(); assert.equal(p1.status, 'parcial'); assert.equal(Number(p1.items[0].pending), 4);
  const rc2 = (await call('POST', '/receivings', { supplier_id: sup2, po_id: po.id, nf_number: 'M-2', items: [{ product_id: pA, qty: 4, unit_price: 12 }] }, buyer)).json();
  await call('POST', `/receivings/${rc2.id}/check-all`, undefined, stockist);
  assert.equal((await call('POST', `/receivings/${rc2.id}/finish`, {}, buyer)).statusCode, 200);
  assert.equal((await call('GET', '/purchase-orders/' + po.id)).json().status, 'recebido');
  assert.equal((await call('POST', `/purchase-orders/${po.id}/cancel`, undefined, buyer)).statusCode, 409);
});

test('divergência de preço contra o pedido só é aceita por quem aprova compras', async () => {
  const po = (await call('POST', '/purchase-orders', { supplier_id: sup2, items: [{ product_id: pB, qty: 5, unit_price: 10 }], submit: true }, buyer)).json();
  const rc = (await call('POST', '/receivings', { supplier_id: sup2, po_id: po.id, nf_number: 'P-1', items: [{ product_id: pB, qty: 5, unit_price: 11 }] }, buyer)).json();
  await call('POST', `/receivings/${rc.id}/check-all`, undefined, stockist);
  const flags = (await call('GET', '/receivings/' + rc.id)).json().items[0].flags; assert.ok(flags.includes('preco_divergente'));
  assert.equal((await call('POST', `/receivings/${rc.id}/finish`, {}, buyer)).json().code, 'divergences');
  assert.equal((await call('POST', `/receivings/${rc.id}/finish`, { accept_divergences: true }, buyer)).statusCode, 403);
  assert.equal((await call('POST', `/receivings/${rc.id}/finish`, { accept_divergences: true }, ger)).statusCode, 200);
});

test('limite de aprovação configurável: acima do limite aguarda gestor (outra pessoa)', async () => {
  assert.equal((await call('PUT', '/purchasing/settings', { approval_threshold: 100 }, buyer)).statusCode, 403);
  assert.equal((await call('PUT', '/purchasing/settings', { approval_threshold: 100 }, ger)).statusCode, 200);
  const po = (await call('POST', '/purchase-orders', { supplier_id: sup1, items: [{ product_id: pA, qty: 20, unit_price: 10 }], submit: true }, buyer)).json();
  assert.equal(po.status, 'aguardando_aprovacao');
  assert.equal((await call('POST', `/purchase-orders/${po.id}/approve`, undefined, buyer)).statusCode, 403);
  assert.equal((await call('POST', `/purchase-orders/${po.id}/approve`, undefined, ger)).json().status, 'aprovado');
  const small = (await call('POST', '/purchase-orders', { supplier_id: sup1, items: [{ product_id: pA, qty: 1, unit_price: 10 }], submit: true }, buyer)).json(); assert.equal(small.status, 'aprovado');
  await call('PUT', '/purchasing/settings', { approval_threshold: null }, ger);
  await call('POST', `/purchase-orders/${po.id}/cancel`, undefined, buyer); await call('POST', `/purchase-orders/${small.id}/cancel`, undefined, buyer);
});

test('cotação: ofertas de dois fornecedores, melhor preço por item, adjudicação gera pedidos', async () => {
  const q = (await call('POST', '/quotations', { items: [{ product_id: pA, qty: 8 }, { product_id: pB, qty: 4 }] }, buyer)).json();
  for (const [s, p, price, lead] of [[sup1, pA, 11, 5], [sup2, pA, 10, 12], [sup1, pB, 7, 5], [sup2, pB, 9, 3]] as const)
    assert.equal((await call('POST', `/quotations/${q.id}/offers`, { product_id: p, supplier_id: s, unit_price: price, lead_time_days: lead, payment_terms_days: 28 }, buyer)).statusCode, 201);
  const d = (await call('GET', '/quotations/' + q.id, undefined, buyer)).json();
  const bestA = d.items.find((i: { product_id: string }) => i.product_id === pA); assert.equal(bestA.offers.find((o: { id: string }) => o.id === bestA.best_offer_id).supplier_id, sup2);
  const bestB = d.items.find((i: { product_id: string }) => i.product_id === pB); assert.equal(bestB.offers.find((o: { id: string }) => o.id === bestB.best_offer_id).supplier_id, sup1);
  const aw = await call('POST', `/quotations/${q.id}/award`, { awards: [{ product_id: pA, supplier_id: sup2 }, { product_id: pB, supplier_id: sup1 }] }, buyer);
  assert.equal(aw.statusCode, 201, aw.body); const orders = aw.json().orders; assert.equal(orders.length, 2);
  assert.equal(orders.find((o: { supplier_id: string }) => o.supplier_id === sup2).total, '80.00'); assert.equal(orders.find((o: { supplier_id: string }) => o.supplier_id === sup1).total, '28.00');
  assert.equal((await call('GET', '/quotations/' + q.id, undefined, buyer)).json().status, 'fechada');
  assert.equal((await call('POST', `/quotations/${q.id}/offers`, { product_id: pA, supplier_id: sup1, unit_price: 1 }, buyer)).statusCode, 409);
  for (const o of orders) await call('POST', `/purchase-orders/${o.id}/cancel`, undefined, buyer);
});

test('comparação de fornecedores mostra último preço, variação e histórico', async () => {
  await call('PUT', `/suppliers/${sup1}/products/${pB}`, { supplier_code: 'S1-PB', preferred: true, price: 8 });
  const c = (await call('GET', `/purchasing/compare?product_id=${pB}`)).json();
  const s1 = c.suppliers.find((s: { supplier_id: string }) => s.supplier_id === sup1);
  assert.equal(Number(s1.last_price), 8); assert.ok(s1.variation_pct != null); assert.ok(c.history.length >= 3);
  assert.equal(c.cheapest_supplier_id, c.suppliers[0].supplier_id);
});

test('sugestão de compra: abaixo do ponto de pedido, desconta pedidos pendentes e informa confiança', async () => {
  // pB: mínimo 10, ideal 30; estoque atual = 10 (do recebimento) → ajusta para 4
  await call('POST', '/stock/movements', { op: 'saida', product_id: pB, qty: Number(await stock(pB)) - 4, reason: 'ajuste do teste' });
  const s = (await call('GET', '/purchasing/suggestions?branch_id=all', undefined, buyer)).json();
  const it = s.items.find((x: { product_id: string }) => x.product_id === pB);
  assert.ok(it, JSON.stringify(s.items.map((x: { sku: string }) => x.sku))); assert.equal(it.disponivel, 4); assert.ok(it.suggested_qty >= 26 && it.suggested_qty <= 96); assert.equal(it.confidence, 'baixa');
  assert.equal(it.supplier_id, sup1); assert.equal(it.last_price, 8); assert.match(it.seasonality_note, /sem histórico/); assert.match(s.note, /Estimativa/);
  const po = (await call('POST', '/purchase-orders/from-suggestions', { items: [{ product_id: pB, supplier_id: sup1, qty: it.suggested_qty, unit_price: 8 }] }, buyer)).json().orders[0];
  assert.equal(po.status, 'aprovado');
  const after = (await call('GET', '/purchasing/suggestions?branch_id=all', undefined, buyer)).json();
  assert.ok(!after.items.find((x: { product_id: string }) => x.product_id === pB));          // pedido pendente cobre a necessidade
  await call('POST', `/purchase-orders/${po.id}/cancel`, undefined, buyer);
});

test('devolução ao fornecedor: baixa estoque e gera crédito a abater', async () => {
  const before = await stock(pA);
  const r = await call('POST', '/supplier-returns', { supplier_id: sup1, reason: 'Peça com defeito', items: [{ product_id: pA, qty: 2 }] }, buyer); assert.equal(r.statusCode, 201, r.body);
  assert.equal(await stock(pA), before - 2); assert.ok(Number(r.json().total) > 0);
  const cr = (await pool.query(`select kind, amount from payables where supplier_id = $1 and kind = 'credito'`, [sup1])).rows; assert.equal(cr.length, 1);
  assert.equal((await call('POST', '/supplier-returns', { supplier_id: sup1, reason: 'Devolução inválida', items: [{ product_id: pA, qty: 9999 }] }, buyer)).statusCode, 409);
});

test('permissões e isolamento de empresa em compras', async () => {
  assert.equal((await call('GET', '/purchase-orders', undefined, seller)).statusCode, 403);
  assert.equal((await call('POST', '/purchase-orders', { supplier_id: sup1, items: [{ product_id: pA, qty: 1, unit_price: 1 }] }, stockist)).statusCode, 403);
  const list = (await call('GET', '/purchase-orders')).json(); assert.ok(list.total > 0);
  assert.equal((await call('GET', '/purchase-orders/' + list.items[0].id, undefined, other)).statusCode, 404);
  assert.equal((await call('GET', '/purchase-orders', undefined, other)).json().total, 0);
  const d = (await call('GET', '/dashboard/summary')).json().purchasing; assert.ok(d && Number(d.payables_7d) >= 0);
  assert.equal(hq.length > 0, true);
});
