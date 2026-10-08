import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { buildApp } = await import('./app.js');
const { pool, tx } = await import('./db.js');
const { createCompany } = await import('./scripts/company.js');
const { hashPassword } = await import('./lib/security.js');
const R = await import('./fiscal/rules.js');

let app: Awaited<ReturnType<typeof buildApp>>; let adm = '', fis = '', vend = '', other = '', hq = '', pA = '', pNoNcm = '';
let cGoPJ = '', cSpRevenda = '', cSpPF = '', cGoPF = '', cPFnoAddr = '';
const call = (method: string, url: string, body?: unknown, token = adm) =>
  app.inject({ method: method as 'GET', url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Senha12345x' } })).json().token;
const sellTo = async (customer: string | null, type = 'b2b', product = pA, qty = 2, token = adm) => {
  const r = await call('POST', '/sales', { type, customer_id: customer, items: [{ product_id: product, qty }], confirm: true, payments: [{ method: 'pix', amount: 0 }] }, token);
  if (r.statusCode === 422 || r.statusCode === 201) { /* ajusta o valor do pagamento ao total da prévia */ }
  const pre = (await call('POST', '/sales/preview', { customer_id: customer, channel: type, items: [{ product_id: product, qty }] }, token)).json();
  const res = await call('POST', '/sales', { type, customer_id: customer, items: [{ product_id: product, qty }], confirm: true, payments: [{ method: 'pix', amount: pre.totals.total }] }, token);
  assert.equal(res.statusCode, 201, res.body); return res.json();
};
const draft = async (saleId: string, model?: string) => (await call('POST', '/fiscal/documents/from-sale', { sale_id: saleId, model }, fis));
const keyFor = (o: { uf?: string; cnpj?: string; model?: '55' | '65'; series?: number; number: number }) => R.buildAccessKey({ uf: o.uf ?? 'GO', issue: new Date(), cnpj: o.cnpj ?? '11222333000181', model: o.model ?? '55', series: o.series ?? 1, number: o.number, code: 12345678 });
const cust = async (b: object) => (await call('POST', '/customers', b)).json().id;
const addr = { street: 'Rua A', number: '10', district: 'Centro', city: 'Goiânia', state: 'GO', zip: '74000-000' };

before(async () => {
  app = await buildApp(); const st = Date.now(); const pw = await hashPassword('Senha12345x');
  const r = await tx((db) => createCompany(db, { legalName: 'Fiscal Teste Ltda', adminName: 'Adm', adminEmail: `adm${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false }));
  hq = r.branchId;
  for (const [role, k] of [['fiscal', 'f'], ['vendedor', 'v']] as const) await pool.query(`insert into users (company_id, role_id, name, email, password_hash) values ($1,$2,$3,$4,$5)`, [r.companyId, r.roleIds[role], role, `${k}${st}@t.local`, pw]);
  adm = await login(`adm${st}@t.local`); fis = await login(`f${st}@t.local`); vend = await login(`v${st}@t.local`);
  await tx((db) => createCompany(db, { legalName: 'Outra', adminName: 'O', adminEmail: `o${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false })); other = await login(`o${st}@t.local`);
  await pool.query(`update branches set cnpj = '11222333000181', ie = '102345678', crt = 1, street = 'Av. Teste', number = '100', district = 'Setor Central', city = 'Goiânia', state = 'GO', zip = '74000000', city_ibge = '5208707' where id = $1`, [hq]);
  const mk = async (sku: string, extra: object = {}) => (await call('POST', '/products', { sku, description: `Produto ${sku}`, cost_current: 10, sale_price: 100, min_margin_pct: 10, ncm: '87141000', origin: 0, ...extra })).json().id;
  pA = await mk('F1', { barcodes: ['7891234567895'] }); pNoNcm = await mk('F2', { ncm: null });
  for (const p of [pA, pNoNcm]) await call('POST', '/stock/movements', { op: 'entrada', product_id: p, qty: 100, unit_cost: 10 });
  cGoPJ = await cust({ type: 'PJ', document: '11.222.333/0001-81', legal_name: 'Oficina GO Ltda', ie: '109876543', segment: 'oficina', ...addr });
  cSpRevenda = await cust({ type: 'PJ', document: '04.252.011/0001-10', legal_name: 'Revenda SP Ltda', ie: '111222333444', segment: 'revenda', street: 'Rua B', number: '5', district: 'Centro', city: 'São Paulo', state: 'SP', zip: '01000000' });
  cSpPF = await cust({ type: 'PF', document: '529.982.247-25', legal_name: 'João Consumidor SP', street: 'Rua C', number: '7', district: 'Centro', city: 'Campinas', state: 'SP', zip: '13000000' });
  cGoPF = await cust({ type: 'PF', document: '111.444.777-35', legal_name: 'Maria Consumidora GO', ...addr });
  cPFnoAddr = await cust({ type: 'PF', legal_name: 'Cliente sem endereço' });
});
after(async () => { await app.close(); await pool.end(); });

test('regras: chave de acesso (DV), CFOP, modelo, IE e consumidor final', () => {
  const k = keyFor({ number: 77 }); assert.equal(k.length, 44); const p = R.parseAccessKey(k)!; assert.equal(p.number, 77); assert.equal(p.cnpj, '11222333000181'); assert.equal(p.model, '55');
  assert.equal(R.parseAccessKey(k.slice(0, 43) + String((Number(k[43]) + 1) % 10)), null);
  assert.deepEqual(R.determineCfop('GO', 'GO', 1), { cfop: '5102', idDest: 1 }); assert.deepEqual(R.determineCfop('GO', 'SP', 1), { cfop: '6102', idDest: 2 }); assert.equal(R.determineCfop('GO', 'SP', 9).cfop, '6108');
  assert.equal(R.chooseModel({ recipientType: 'PJ', saleType: 'balcao', useNfceForCounter: true }), '55');            // CNPJ → sempre NF-e
  assert.equal(R.chooseModel({ recipientType: 'PF', saleType: 'externo', useNfceForCounter: true }), '55');          // não presencial → NF-e
  assert.equal(R.chooseModel({ recipientType: 'PF', saleType: 'balcao', useNfceForCounter: true }), '65'); assert.equal(R.chooseModel({ recipientType: null, saleType: 'balcao', useNfceForCounter: false }), '55');
  assert.equal(R.ieIndicator({ type: 'PF', ie: '123', ie_indicator: null, segment: null, final_consumer: null, state: 'GO' }), 9); assert.equal(R.ieIndicator({ type: 'PJ', ie: '123', ie_indicator: null, segment: null, final_consumer: null, state: 'GO' }), 1);
  assert.equal(R.isFinalConsumer({ type: 'PJ', ie: '1', ie_indicator: 1, segment: 'revenda', final_consumer: null, state: 'GO' }), false); assert.equal(R.isFinalConsumer({ type: 'PJ', ie: '1', ie_indicator: 1, segment: 'oficina', final_consumer: null, state: 'GO' }), true);
  assert.equal(R.effectiveRateAnexoI(100000)!.rate, 4); assert.equal(R.effectiveRateAnexoI(360000)!.rate, 5.65); assert.equal(R.effectiveRateAnexoI(1000000)!.rate, 8.45); assert.equal(R.effectiveRateAnexoI(5000000), null);
});

test('NF-e para CNPJ contribuinte no estado: modelo 55, CFOP 5102, CSOSN 102, totais e texto do Simples', async () => {
  const s = await sellTo(cGoPJ); const r = await draft(s.id); assert.equal(r.statusCode, 201, r.body); const d = (await call('GET', '/fiscal/documents/' + r.json().id, undefined, fis)).json();
  assert.equal(d.model, '55'); assert.equal(d.validation.errors.length, 0, JSON.stringify(d.validation.errors)); const p = d.payload;
  assert.equal(p.ide.idDest, 1); assert.equal(p.ide.indFinal, 1); assert.equal(p.destinatario.indIEDest, 1); assert.equal(p.itens[0].cfop, '5102'); assert.equal(p.itens[0].csosn, '102'); assert.equal(p.itens[0].ean, '7891234567895');
  assert.equal(p.totais.valor_nf, Number(s.total)); assert.equal(p.pagamentos[0].tPag, '17'); assert.match(p.informacoes_complementares, /SIMPLES NACIONAL/); assert.ok(d.validation.warnings.some((w: { field: string }) => w.field === 'st'));
  assert.equal((await draft(s.id)).statusCode, 409);                        // uma nota ativa por venda
});

test('interestadual: revenda SP → 6102 (indFinal 0); consumidor final PF SP → 6108 + alerta de DIFAL', async () => {
  const a = (await draft((await sellTo(cSpRevenda)).id)).json(); const da = (await call('GET', '/fiscal/documents/' + a.id, undefined, fis)).json();
  assert.equal(da.payload.itens[0].cfop, '6102'); assert.equal(da.payload.ide.idDest, 2); assert.equal(da.payload.ide.indFinal, 0); assert.ok(!da.validation.warnings.some((w: { field: string }) => w.field === 'difal'));
  const b = (await draft((await sellTo(cSpPF, 'online')).id)).json(); const db = (await call('GET', '/fiscal/documents/' + b.id, undefined, fis)).json();
  assert.equal(db.model, '55'); assert.equal(db.payload.itens[0].cfop, '6108'); assert.equal(db.payload.ide.indPres, 2); assert.ok(db.validation.warnings.some((w: { field: string }) => w.field === 'difal'));
});

test('validações bloqueiam: NCM ausente, destinatário sem endereço/CPF, NFC-e em venda externa, NFC-e para CNPJ, emitente sem IE', async () => {
  const noNcm = (await draft((await sellTo(cGoPJ, 'b2b', pNoNcm)).id)).json(); assert.ok(noNcm.validation.errors.some((e: { field: string }) => e.field.includes('ncm')));
  const noAddr = (await draft((await sellTo(cPFnoAddr, 'externo')).id)).json(); const f = noAddr.validation.errors.map((e: { field: string }) => e.field);
  assert.ok(f.includes('destinatario.documento') && f.includes('destinatario.logradouro') && f.includes('destinatario.cep'));
  const ext = (await draft((await sellTo(cGoPF, 'externo')).id, '65')).json(); assert.ok(ext.validation.errors.some((e: { field: string }) => e.field === 'modelo'));
  const pj65 = (await draft((await sellTo(cGoPJ, 'balcao')).id, '65')).json(); assert.ok(pj65.validation.errors.some((e: { message: string }) => /CNPJ exige NF-e/.test(e.message)));
  await pool.query('update branches set ie = null where id = $1', [hq]);
  const noIe = (await draft((await sellTo(cGoPF, 'online')).id)).json(); assert.ok(noIe.validation.errors.some((e: { field: string }) => e.field === 'emitente.ie'));
  await pool.query(`update branches set ie = '102345678' where id = $1`, [hq]);
  const rv = (await call('POST', `/fiscal/documents/${noIe.id}/revalidate`, undefined, fis)).json(); assert.equal(rv.validation.errors.length, 0);   // corrigido o cadastro, revalida
  const e = await call('POST', `/fiscal/documents/${noNcm.id}/emit`, undefined, fis); assert.ok([409, 422].includes(e.statusCode));
});

test('vendas pendentes de nota e preparação em lote', async () => {
  const s = await sellTo(cGoPJ); const p = (await call('GET', '/fiscal/pending-sales', undefined, fis)).json().items; assert.ok(p.find((x: { id: string }) => x.id === s.id));
  const prep = (await call('POST', '/fiscal/documents/prepare-pending', undefined, fis)).json(); assert.ok(prep.created >= 1);
  assert.equal((await call('GET', '/fiscal/pending-sales', undefined, fis)).json().items.find((x: { id: string }) => x.id === s.id), undefined);
});

test('provedor manual: não emite; registra nota emitida fora validando chave, CNPJ, modelo e XML', async () => {
  const s = await sellTo(cGoPJ); const d = (await draft(s.id)).json(); assert.equal(d.validation.errors.length, 0);
  const em = await call('POST', `/fiscal/documents/${d.id}/emit`, undefined, fis); assert.equal(em.statusCode, 409); assert.equal(em.json().code, 'manual_provider');
  const base = { protocol: '152260000123456' };
  assert.equal((await call('POST', `/fiscal/documents/${d.id}/register-manual`, { ...base, access_key: keyFor({ number: 501 }).slice(0, 43) + '0' }, fis)).statusCode, 422);                  // DV inválido (na maioria dos casos)
  assert.match((await call('POST', `/fiscal/documents/${d.id}/register-manual`, { ...base, access_key: keyFor({ number: 501, cnpj: '04252011000110' }) }, fis)).json().error, /CNPJ da chave/);
  assert.match((await call('POST', `/fiscal/documents/${d.id}/register-manual`, { ...base, access_key: keyFor({ number: 501, model: '65' }) }, fis)).json().error, /modelo 65/);
  const key = keyFor({ number: 501 });
  const badXml = `<nfeProc><NFe><infNFe Id="NFe${key}"><ide><nNF>501</nNF></ide><emit><CNPJ>11222333000181</CNPJ><xNome>X</xNome></emit><det nItem="1"><prod><cProd>1</cProd><xProd>x</xProd><qCom>1</qCom><vUnCom>1</vUnCom><vProd>1.00</vProd></prod></det><total><ICMSTot><vNF>1.00</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`;
  assert.match((await call('POST', `/fiscal/documents/${d.id}/register-manual`, { ...base, access_key: key, xml: badXml }, fis)).json().error, /valor da nota no XML/);
  const ok = await call('POST', `/fiscal/documents/${d.id}/register-manual`, { ...base, access_key: key }, fis); assert.equal(ok.statusCode, 200, ok.body); assert.equal(ok.json().number, 501);
  const full = (await call('GET', '/fiscal/documents/' + d.id, undefined, fis)).json(); assert.equal(full.status, 'autorizada'); assert.equal(full.simulated, false); assert.equal(full.events[0].type, 'registro_manual');
  const d2 = (await draft((await sellTo(cGoPJ)).id)).json(); assert.equal((await call('POST', `/fiscal/documents/${d2.id}/register-manual`, { ...base, access_key: key }, fis)).statusCode, 409);   // chave já usada
  assert.equal((await call('POST', '/fiscal/settings', {}, fis)).statusCode, 404);
});

test('cancelamento de nota: justificativa ≥ 15, prazo, protocolo (manual) e trava no cancelamento da venda', async () => {
  const s = await sellTo(cGoPJ); const d = (await draft(s.id)).json(); const key = keyFor({ number: 601 });
  await call('POST', `/fiscal/documents/${d.id}/register-manual`, { access_key: key, protocol: '152260000999999' }, fis);
  assert.equal((await call('POST', `/sales/${s.id}/cancel`, { reason: 'cliente desistiu' }, adm)).json().code, 'fiscal_document_active');
  assert.equal((await call('POST', `/fiscal/documents/${d.id}/cancel`, { reason: 'x'.repeat(20) }, vend)).statusCode, 403);
  assert.equal((await call('POST', `/fiscal/documents/${d.id}/cancel`, { reason: 'curto' }, fis)).statusCode, 422);
  assert.equal((await call('POST', `/fiscal/documents/${d.id}/cancel`, { reason: 'Cancelamento por erro de digitação do pedido' }, fis)).json().code, 'protocol_required');
  await pool.query(`update fiscal_documents set authorized_at = now() - interval '3 days' where id = $1`, [d.id]);
  assert.equal((await call('POST', `/fiscal/documents/${d.id}/cancel`, { reason: 'Cancelamento por erro de digitação do pedido', protocol: '152260000111111' }, fis)).json().code, 'window_expired');
  await pool.query(`update fiscal_documents set authorized_at = now() where id = $1`, [d.id]);
  assert.equal((await call('POST', `/fiscal/documents/${d.id}/cancel`, { reason: 'Cancelamento por erro de digitação do pedido', protocol: '152260000111111' }, fis)).statusCode, 200);
  assert.equal((await call('POST', `/sales/${s.id}/cancel`, { reason: 'cliente desistiu' }, adm)).statusCode, 200);                       // agora pode
  const again = await call('POST', '/fiscal/documents/from-sale', { sale_id: s.id }, fis); assert.ok([201, 409].includes(again.statusCode));
});

test('provedor simulado (sandbox): emite com marca de SEM VALOR FISCAL, numera, gera XML, cancela, CC-e e devolução parcial', async () => {
  assert.equal((await call('PUT', '/fiscal/settings', { provider: 'simulado', environment: 'producao', series_nfe: 1, series_nfce: 1, use_nfce_for_counter: false, cancel_window_hours: 24, das_mode: 'manual', das_effective_pct: 6, rbt12_override: null, ibs_cbs_enabled: false }, adm)).statusCode, 422);
  assert.equal((await call('PUT', '/fiscal/settings', { provider: 'simulado', environment: 'homologacao', series_nfe: 1, series_nfce: 1, use_nfce_for_counter: false, cancel_window_hours: 24, das_mode: 'manual', das_effective_pct: 6, rbt12_override: null, ibs_cbs_enabled: false }, fis)).statusCode, 200);
  const s1 = await sellTo(cGoPJ, 'b2b', pA, 3); const d1 = (await draft(s1.id)).json(); const e1 = await call('POST', `/fiscal/documents/${d1.id}/emit`, undefined, fis); assert.equal(e1.statusCode, 200, e1.body); assert.equal(e1.json().simulated, true); assert.match(e1.json().message, /SIMULADO/);
  const d2 = (await draft((await sellTo(cGoPJ)).id)).json(); const e2 = (await call('POST', `/fiscal/documents/${d2.id}/emit`, undefined, fis)).json(); assert.equal(e2.number, e1.json().number + 1);
  const xml = await call('GET', `/fiscal/documents/${d1.id}/xml`, undefined, fis); assert.equal(xml.statusCode, 200); assert.match(xml.body, /SIMULADO — SEM VALOR FISCAL/); assert.match(xml.body, new RegExp(e1.json().access_key));
  assert.equal(R.parseAccessKey(e1.json().access_key)!.cnpj, '11222333000181');
  const cc = await call('POST', `/fiscal/documents/${d1.id}/correction`, { text: 'Correção do endereço de entrega no complemento' }, fis); assert.equal(cc.statusCode, 200); assert.equal(cc.json().seq, 1);
  assert.equal((await call('POST', `/fiscal/documents/${d1.id}/correction`, { text: 'curta' }, fis)).statusCode, 422);
  // devolução parcial: 3 vendidos → devolve 1, depois 2, depois mais 1 (excede)
  const r1 = await call('POST', '/fiscal/documents/return', { document_id: d1.id, items: [{ product_id: pA, qty: 1 }], reason: 'Peça errada' }, fis); assert.equal(r1.statusCode, 201, r1.body);
  const rd = (await call('GET', '/fiscal/documents/' + r1.json().id, undefined, fis)).json(); assert.equal(rd.kind, 'devolucao_venda'); assert.equal(rd.payload.itens[0].cfop, '1202'); assert.equal(rd.payload.finalidade, 4); assert.equal(rd.payload.referencias[0].refNFe, e1.json().access_key); assert.equal(rd.validation.errors.length, 0, JSON.stringify(rd.validation.errors));
  assert.equal((await call('POST', '/fiscal/documents/return', { document_id: d1.id, items: [{ product_id: pA, qty: 3 }], reason: 'Excede o saldo' }, fis)).statusCode, 422);
  assert.equal((await call('POST', `/fiscal/documents/${r1.json().id}/emit`, undefined, fis)).statusCode, 200);
  const c = await call('POST', `/fiscal/documents/${d2.id}/cancel`, { reason: 'Cancelamento de teste do ambiente simulado' }, fis); assert.equal(c.statusCode, 200);       // simulado gera o protocolo
  await call('PUT', '/fiscal/settings', { provider: 'manual', environment: 'homologacao', series_nfe: 1, series_nfce: 1, use_nfce_for_counter: false, cancel_window_hours: 24, das_mode: 'manual', das_effective_pct: 6, rbt12_override: null, ibs_cbs_enabled: false }, adm);
});

test('XMLs: lista emitidos e recebidos (NF de compra guarda o XML)', async () => {
  const sup = (await call('POST', '/suppliers', { legal_name: 'Fornecedor XML', cnpj: '04.252.011/0001-10' })).json().id; void sup;
  const xml = `<?xml version="1.0"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe35261004252011000110550010000000011000000019" versao="4.00"><ide><nNF>1</nNF><serie>1</serie><dhEmi>2026-10-01T10:00:00-03:00</dhEmi></ide><emit><CNPJ>04252011000110</CNPJ><xNome>Fornecedor XML</xNome></emit><det nItem="1"><prod><cProd>F1</cProd><cEAN>7891234567895</cEAN><xProd>Peça</xProd><NCM>87141000</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>10.0000</vUnCom><vProd>10.00</vProd></prod></det><total><ICMSTot><vProd>10.00</vProd><vNF>10.00</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`;
  assert.equal((await call('POST', '/receivings/import-xml', { xml }, adm)).statusCode, 201);
  const l = (await call('GET', '/fiscal/xmls', undefined, fis)).json().items; assert.ok(l.some((x: { origin: string }) => x.origin === 'emitida')); const rec = l.find((x: { origin: string }) => x.origin === 'recebida'); assert.ok(rec);
  const dl = await call('GET', `/fiscal/xmls/received/${rec.id}`, undefined, fis); assert.equal(dl.statusCode, 200); assert.match(dl.body, /<nNF>1<\/nNF>/);
});

test('DAS: estimativa (manual e Anexo I), obrigação, valor oficial, título a pagar e status pago', async () => {
  const month = new Date().toISOString().slice(0, 7); const panel = (await call('GET', '/taxes/panel', undefined, fis)).json(); const cur = panel.months.find((m: { competence: string }) => m.competence.startsWith(month));
  assert.ok(cur.revenue > 0); assert.equal(cur.effective_rate, 6); assert.equal(cur.estimated, Math.round(cur.revenue * 6) / 100); assert.match(panel.disclaimer, /ESTIMADOS/); assert.ok(![0, 6].includes(new Date(cur.due_date + 'T12:00:00').getDay()));
  const gen = await call('POST', '/taxes/obligations/generate', { competence: month }, fis); assert.equal(gen.statusCode, 201, gen.body); const ob = gen.json(); assert.equal(ob.status, 'previsto');
  assert.equal((await call('POST', `/taxes/obligations/${ob.id}/payable`, {}, adm)).json().code, 'amount_required');
  assert.equal((await call('PATCH', `/taxes/obligations/${ob.id}`, { amount: 123.45, guide_ref: 'PGDAS 2026' }, fis)).json().status, 'a_pagar');
  const p = await call('POST', `/taxes/obligations/${ob.id}/payable`, {}, adm); assert.equal(p.statusCode, 200, p.body); assert.equal(p.json().amount, 123.45);
  assert.equal((await call('POST', `/taxes/obligations/${ob.id}/payable`, {}, adm)).statusCode, 409);
  const acc = (await call('POST', '/bank-accounts', { name: 'Conta DAS', kind: 'banco', opening_balance: 1000 })).json().id;
  assert.equal((await call('POST', `/payables/${p.json().payable_id}/settle`, { account_id: acc, date: new Date().toISOString().slice(0, 10) }, adm)).statusCode, 200);
  const after = (await call('GET', '/taxes/panel', undefined, fis)).json(); assert.equal(after.months.find((m: { competence: string }) => m.competence.startsWith(month)).status, 'pago'); assert.equal(after.totals.paid, 123.45);
  await call('PUT', '/fiscal/settings', { provider: 'manual', environment: 'homologacao', series_nfe: 1, series_nfce: 1, use_nfce_for_counter: false, cancel_window_hours: 24, das_mode: 'anexo_i', das_effective_pct: null, rbt12_override: 360000, ibs_cbs_enabled: false }, adm);
  const an = (await call('GET', '/taxes/panel', undefined, fis)).json().months.find((m: { competence: string }) => m.competence.startsWith(month)); assert.equal(an.effective_rate, 5.65); assert.equal(an.rbt12, 360000); assert.match(an.method, /Anexo I/);
});

test('permissões e isolamento do fiscal', async () => {
  assert.equal((await call('GET', '/fiscal/documents', undefined, vend)).statusCode, 403); assert.equal((await call('GET', '/taxes/panel', undefined, vend)).statusCode, 403);
  assert.equal((await call('PUT', '/fiscal/settings', {}, fis)).statusCode, 422);                                           // fiscal tem approve, mas o corpo é inválido
  const list = (await call('GET', '/fiscal/documents', undefined, fis)).json(); assert.ok(list.total > 0);
  assert.equal((await call('GET', '/fiscal/documents/' + list.items[0].id, undefined, other)).statusCode, 404); assert.equal((await call('GET', '/fiscal/documents', undefined, other)).json().total, 0);
  const dash = (await call('GET', '/dashboard/summary', undefined, fis)).json().fiscal; assert.ok(dash && typeof dash.sales_without_invoice === 'number');
});
