import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { buildApp } = await import('./app.js');
const { pool, tx } = await import('./db.js');
const { createCompany } = await import('./scripts/company.js');
const { hashPassword } = await import('./lib/security.js');
const { calcCharges, DEFAULT_FINANCE } = await import('./finance.js');
const { parseCsv, parseAmount, parseDate, guessMapping } = await import('./lib/csv.js');

let app: Awaited<ReturnType<typeof buildApp>>; let adm = '', fin = '', ger = '', vend = '', other = '';
let bank = '', bank2 = '', caixa = '', cust = '', sup = '';
const call = (method: string, url: string, body?: unknown, token = adm) =>
  app.inject({ method: method as 'GET', url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Senha12345x' } })).json().token;
const balance = async (id: string) => Number((await call('GET', '/bank-accounts')).json().items.find((a: { id: string }) => a.id === id).balance);
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const mkRec = async (amount: number, dueOffset: number, desc = 'Título teste') => (await call('POST', '/receivables', { customer_id: cust, due_date: day(dueOffset), amount, description: desc })).json();
const csvOf = (rows: string[]) => ['Data;Histórico;Documento;Valor;Saldo', ...rows].join('\n');

before(async () => {
  app = await buildApp(); const st = Date.now(); const pw = await hashPassword('Senha12345x');
  const r = await tx((db) => createCompany(db, { legalName: 'Financeiro Teste', adminName: 'Adm', adminEmail: `adm${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false }));
  for (const [role, k] of [['financeiro', 'f'], ['gerente', 'g'], ['vendedor', 'v']] as const)
    await pool.query(`insert into users (company_id, role_id, name, email, password_hash, is_seller, commission_pct) values ($1,$2,$3,$4,$5,$6,2)`, [r.companyId, r.roleIds[role], role, `${k}${st}@t.local`, pw, role === 'vendedor']);
  adm = await login(`adm${st}@t.local`); fin = await login(`f${st}@t.local`); ger = await login(`g${st}@t.local`); vend = await login(`v${st}@t.local`);
  await tx((db) => createCompany(db, { legalName: 'Outra', adminName: 'O', adminEmail: `o${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false })); other = await login(`o${st}@t.local`);
  bank = (await call('POST', '/bank-accounts', { name: 'BTG Pactual', kind: 'banco', bank_name: 'BTG Pactual', opening_balance: 1000 })).json().id;
  bank2 = (await call('POST', '/bank-accounts', { name: 'Aplicação BTG', kind: 'aplicacao', opening_balance: 0 })).json().id;
  caixa = (await call('POST', '/bank-accounts', { name: 'Caixa', kind: 'caixa', opening_balance: 0 })).json().id;
  cust = (await call('POST', '/customers', { type: 'PF', legal_name: 'Maria Souza Cliente' })).json().id;
  sup = (await call('POST', '/suppliers', { legal_name: 'Fornecedor Fin' })).json().id;
});
after(async () => { await app.close(); await pool.end(); });

test('encargos de atraso (padrão de mercado: multa 2% uma vez + juros 1% a.m. pro rata dia)', () => {
  const base = { outstanding: 1000, due_date: '2026-01-01', fine_already_charged: false, last_settle_date: null };
  assert.deepEqual(calcCharges({ ...base, on_date: '2026-01-31' }, DEFAULT_FINANCE), { days_late: 30, interest: 10, fine: 20, total: 30 });
  assert.equal(calcCharges({ ...base, on_date: '2025-12-31' }, DEFAULT_FINANCE).total, 0);
  assert.equal(calcCharges({ ...base, on_date: '2026-01-05' }, { ...DEFAULT_FINANCE, grace_days: 5 }).total, 0);
  const second = calcCharges({ outstanding: 600, due_date: '2026-01-01', on_date: '2026-02-15', fine_already_charged: true, last_settle_date: '2026-01-31' }, DEFAULT_FINANCE);
  assert.equal(second.fine, 0); assert.equal(second.interest, 3);        // 600 × 1%/30 × 15 dias desde a última baixa
});

test('CSV: separador, aspas, números e datas brasileiros, detecção de colunas e débito/crédito', () => {
  assert.equal(parseAmount('1.234,56'), 1234.56); assert.equal(parseAmount('(10,00)'), -10); assert.equal(parseAmount('-R$ 5,00'), -5); assert.equal(parseAmount('10,50-'), -10.5); assert.equal(parseAmount('abc'), null); assert.equal(parseAmount('1,234.50', '.'), 1234.5);
  assert.equal(parseDate('05/10/2026'), '2026-10-05'); assert.equal(parseDate('2026-10-05'), '2026-10-05'); assert.equal(parseDate('31/02/2026'), null);
  const p = parseCsv('﻿Data;Histórico;Valor\r\n01/10/2026;"PIX; recebido ""Maria""";1.500,00\r\n'); assert.equal(p.delimiter, ';'); assert.equal(p.rows[1][1], 'PIX; recebido "Maria"');
  const g = guessMapping(parseCsv('Extrato BTG;;;\nConta 123;;;\nData;Descrição;Débito;Crédito\n01/10/2026;Tarifa;10,00;').rows); assert.equal(g.header_row, 2); assert.equal(g.mapping?.debit, 2); assert.equal(g.mapping?.credit, 3);
});

test('baixa de título em atraso: calcula juros/multa, movimenta a conta e pode ser estornada', async () => {
  const t = await mkRec(1000, -30);
  const ch = (await call('GET', `/receivables/${t.id}/charges`)).json(); assert.equal(ch.fine, 20); assert.equal(ch.interest, 10); assert.equal(ch.days_late, 30);
  const before = await balance(bank);
  const s = await call('POST', `/receivables/${t.id}/settle`, { account_id: bank }, fin); assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json().cash, 1030); assert.equal(await balance(bank), before + 1030);
  assert.equal((await call('GET', '/receivables/' + t.id)).json().status, 'pago');
  assert.equal((await call('POST', `/receivables/${t.id}/settle`, { account_id: bank }, fin)).statusCode, 409);
  assert.equal((await call('POST', `/settlements/${s.json().settlement.id}/reverse`, undefined, fin)).statusCode, 403);
  assert.equal((await call('POST', `/settlements/${s.json().settlement.id}/reverse`, undefined, ger)).statusCode, 200);
  assert.equal(await balance(bank), before); assert.equal((await call('GET', '/receivables/' + t.id)).json().status, 'aberto');
});

test('baixa parcial: multa só na primeira baixa; saldo restante; status parcial → pago', async () => {
  const t = await mkRec(1000, -30, 'Parcial');
  const p1 = (await call('POST', `/receivables/${t.id}/settle`, { account_id: bank, principal: 400 }, fin)).json();
  assert.equal(p1.settlement.fine, '20.00'); assert.equal(p1.outstanding_after, 600); assert.equal((await call('GET', '/receivables/' + t.id)).json().status, 'parcial');
  const p2 = (await call('POST', `/receivables/${t.id}/settle`, { account_id: bank }, fin)).json();
  assert.equal(p2.settlement.fine, '0.00'); assert.equal(p2.outstanding_after, 0); assert.equal((await call('GET', '/receivables/' + t.id)).json().status, 'pago');
  assert.equal((await call('POST', `/receivables/${t.id}/settle`, { account_id: bank, principal: 5000 }, ger)).statusCode, 409);
});

test('perdoar encargos e dar desconto grande exige aprovação; tudo auditado', async () => {
  const t = await mkRec(500, -10, 'Perdão');
  const w = await call('POST', `/receivables/${t.id}/settle`, { account_id: bank, interest: 0, fine: 0 }, fin); assert.equal(w.statusCode, 403); assert.equal(w.json().code, 'waiver_requires_approval');
  assert.equal((await call('POST', `/receivables/${t.id}/settle`, { account_id: bank, principal: 100, discount: 20 }, fin)).statusCode, 403);
  assert.equal((await call('POST', `/receivables/${t.id}/settle`, { account_id: bank, interest: 0, fine: 0 }, ger)).statusCode, 200);
  const a = (await call('GET', `/audit?entity=receivable&entity_id=${t.id}`)).json().items.map((x: { action: string }) => x.action); assert.ok(a.includes('charges_waived') && a.includes('settle'));
});

test('contas a pagar: parcelamento, recorrência mensal, pagamento e compensação de crédito do fornecedor', async () => {
  const cat = (await call('GET', '/finance/categories')).json().items.find((c: { name: string }) => c.name === 'Aluguel').id;
  const p = (await call('POST', '/payables', { description: 'Compra parcelada', category_id: cat, first_due_date: '2099-01-31', amount: 100, installments: 3, supplier_id: sup }, fin)).json().items;
  assert.equal(p.length, 3); assert.equal(p.reduce((s: number, x: { amount: string }) => s + Number(x.amount), 0), 100); assert.equal(p[1].due_date.slice(0, 10), '2099-02-28');
  const rep = (await call('POST', '/payables', { description: 'Aluguel', category_id: cat, first_due_date: '2099-01-05', amount: 2500, installments: 6, repeat_monthly: true }, fin)).json().items;
  assert.equal(rep.length, 6); assert.ok(rep.every((x: { amount: string }) => Number(x.amount) === 2500));
  const before = await balance(bank); const pay = await call('POST', `/payables/${p[0].id}/settle`, { account_id: bank }, fin); assert.equal(pay.statusCode, 200, pay.body);
  assert.equal(await balance(bank), before - Number(p[0].amount));
  const credit = (await pool.query(`insert into payables (company_id, supplier_id, kind, due_date, amount, description) select company_id, $1, 'credito', current_date, 20, 'Crédito devolução' from suppliers where id = $1 returning id`, [sup])).rows[0].id;
  const ap = await call('POST', `/payables/${p[1].id}/apply-credit`, { credit_id: credit, amount: 20 }, fin); assert.equal(ap.statusCode, 200, ap.body);
  const t2 = (await call('GET', '/payables/' + p[1].id)).json(); assert.equal(t2.status, 'parcial'); assert.equal(Number(t2.outstanding).toFixed(2), (Number(p[1].amount) - 20).toFixed(2));
  assert.equal((await call('GET', '/payables/' + credit)).json().status, 'pago');
  assert.equal((await call('POST', `/payables/${p[1].id}/apply-credit`, { credit_id: credit, amount: 1 }, fin)).statusCode, 409);
  const cancel = await call('POST', `/payables/${rep[0].id}/cancel`, { reason: 'duplicado' }, fin); assert.equal(cancel.statusCode, 200);
});

test('transferência e aplicação entre contas mantêm saldos coerentes', async () => {
  const [b1, b2] = [await balance(bank), await balance(bank2)];
  assert.equal((await call('POST', '/bank-accounts/transfer', { from_account_id: bank, to_account_id: bank2, amount: 200, kind: 'aplicacao' }, fin)).statusCode, 201);
  assert.equal(await balance(bank), b1 - 200); assert.equal(await balance(bank2), b2 + 200);
  assert.equal((await call('POST', '/bank-accounts/transfer', { from_account_id: bank, to_account_id: bank, amount: 1 }, fin)).statusCode, 422);
  const st = (await call('GET', `/bank-accounts/${bank}/statement`)).json(); assert.equal(st.closing, await balance(bank));
  assert.equal((await call('POST', '/account-movements', { account_id: bank, amount: -5, kind: 'ajuste', description: 'ajuste teste' }, fin)).statusCode, 403);
});

test('extrato CSV: pré-visualização, importação sem duplicar, conciliação automática e manual', async () => {
  const acc = (await call('POST', '/bank-accounts', { name: 'BTG conciliação', kind: 'banco', opening_balance: 0 })).json().id;
  const t = await mkRec(777.77, 3, 'Venda para conciliar');
  const mv = (await call('POST', '/account-movements', { account_id: acc, amount: -50, kind: 'tarifa', description: 'Tarifa já lançada no ERP', date: day(-1) }, fin)).json();
  const csv = csvOf([`${day(-1).split('-').reverse().join('/')};TARIFA PACOTE SERVICOS;001;-50,00;950,00`, `${day(0).split('-').reverse().join('/')};PIX RECEBIDO MARIA SOUZA;002;777,77;1.727,77`,
    `${day(0).split('-').reverse().join('/')};RENDIMENTO APLIC AUTOMATICA;003;1,23;1.729,00`, `${day(0).split('-').reverse().join('/')};LINHA IGNORAR;004;9,99;1.739,00`]);
  const pv = (await call('POST', `/bank-accounts/${acc}/statement/preview`, { csv }, fin)).json();
  assert.equal(pv.guessed, true); assert.equal(pv.mapping.amount, 3); assert.equal(pv.line_count, 4); assert.equal(pv.total_out, 50); assert.equal(pv.duplicates, 0);
  const imp = await call('POST', `/bank-accounts/${acc}/statement/import`, { csv, save_profile: true }, fin); assert.equal(imp.statusCode, 201, imp.body); assert.equal(imp.json().inserted, 4); assert.equal(imp.json().auto_reconciled, 1);
  assert.equal((await call('POST', `/bank-accounts/${acc}/statement/import`, { csv }, fin)).json().inserted, 0);          // reimportar não duplica
  assert.ok((await call('GET', '/bank-accounts')).json().items.find((a: { id: string; has_profile: boolean }) => a.id === acc).has_profile);
  const lines = (await call('GET', `/reconciliation/lines?account_id=${acc}&status=pendente`)).json().items; assert.equal(lines.length, 3);
  const pix = lines.find((l: { doc_ref: string }) => l.doc_ref === '002'); const cand = (await call('GET', `/reconciliation/lines/${pix.id}/candidates`)).json();
  assert.ok(cand.titles.find((x: { id: string; exact: boolean }) => x.id === t.id && x.exact));
  // valor da baixa precisa bater com o extrato
  const bad = await call('POST', `/reconciliation/lines/${pix.id}/settle`, { kind: 'receivable', doc_id: t.id, principal: 700 }, fin); assert.equal(bad.statusCode, 422); assert.equal(bad.json().code, 'amount_mismatch');
  const ok = await call('POST', `/reconciliation/lines/${pix.id}/settle`, { kind: 'receivable', doc_id: t.id }, fin); assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await call('GET', '/receivables/' + t.id)).json().status, 'pago');
  const rend = lines.find((l: { doc_ref: string }) => l.doc_ref === '003'); assert.equal((await call('POST', `/reconciliation/lines/${rend.id}/create-movement`, { kind: 'rendimento' }, fin)).statusCode, 200);
  const ign = lines.find((l: { doc_ref: string }) => l.doc_ref === '004'); assert.equal((await call('POST', `/reconciliation/lines/${ign.id}/ignore`, { note: 'duplicada no banco' }, fin)).statusCode, 200);
  const sm = (await call('GET', `/reconciliation/summary?account_id=${acc}`)).json(); assert.equal(sm.pending, 0); assert.equal(sm.reconciled, 3); assert.equal(sm.ignored, 1);
  assert.equal((await call('POST', `/settlements/${(await call('GET', '/receivables/' + t.id)).json().settlements[0].id}/reverse`, undefined, ger)).statusCode, 409);   // conciliado: não estorna
  assert.equal((await call('POST', `/reconciliation/lines/${pix.id}/undo`, undefined, fin)).statusCode, 403);
  assert.equal((await call('POST', `/reconciliation/lines/${pix.id}/undo`, undefined, ger)).statusCode, 200);
  assert.ok(mv.id);
});

test('caixa físico opcional: abertura, suprimento, sangria e fechamento com diferença', async () => {
  const s = (await call('POST', '/cash/open', { account_id: caixa, opening_amount: 100 }, fin)).json(); assert.ok(s.id);
  assert.equal((await call('POST', '/cash/open', { account_id: caixa, opening_amount: 1 }, fin)).statusCode, 409);
  assert.equal((await call('POST', '/cash/open', { account_id: bank, opening_amount: 1 }, fin)).statusCode, 422);
  await call('POST', `/cash/${s.id}/movement`, { type: 'suprimento', amount: 50, note: 'troco' }, fin);
  const b0 = await balance(bank); await call('POST', `/cash/${s.id}/movement`, { type: 'sangria', amount: 30, other_account_id: bank, note: 'depósito' }, fin); assert.equal(await balance(bank), b0 + 30);
  const c = (await call('POST', `/cash/${s.id}/close`, { counted_amount: 115 }, fin)).json(); assert.equal(c.expected, 120); assert.equal(c.difference, -5);
  assert.equal(await balance(caixa), 15);                                    // 50 − 30 − 5 de quebra; saldo do caixa reflete a contagem
  assert.equal((await call('POST', `/cash/${s.id}/close`, { counted_amount: 1 }, fin)).statusCode, 404);
});

test('fluxo de caixa: realizado, previsto e projetado, com confiança e alerta de saldo negativo', async () => {
  const a = await mkRec(300, 5, 'A receber em 5 dias');
  const cat = (await call('GET', '/finance/categories')).json().items[0].id;
  await call('POST', '/payables', { description: 'Conta enorme', category_id: cat, first_due_date: day(10), amount: 900000, installments: 1 }, fin);
  const f = (await call('GET', '/finance/cashflow?horizon=30', undefined, fin)).json();
  assert.equal(f.series.length, 31); assert.equal(f.projection.confidence, 'baixa'); assert.match(f.projection.note, /estimativa/);
  assert.ok(f.series.some((s: { planned_in: number }) => s.planned_in >= 300)); assert.ok(f.negative_from); assert.ok(f.min_projected_balance.value < 0);
  assert.equal((await call('GET', '/finance/cashflow?horizon=365')).json().bucket, 'mês'); assert.equal((await call('GET', '/finance/cashflow?horizon=0')).json().series.length, 1);
  assert.equal((await call('GET', '/finance/cashflow?horizon=45')).statusCode, 422);
  const d = (await call('GET', '/dashboard/summary')).json().finance; assert.ok(d.negative_from && Number(d.bank_balance) !== 0);
  void a;
});

test('comissões do representante externo: fechamento gera contas a pagar uma única vez', async () => {
  const prod = (await call('POST', '/products', { sku: 'C1', description: 'Peça comissão', cost_current: 10, sale_price: 100, min_margin_pct: 10 })).json().id;
  await call('POST', '/stock/movements', { op: 'entrada', product_id: prod, qty: 10, unit_cost: 10 });
  const s = await call('POST', '/sales', { type: 'balcao', items: [{ product_id: prod, qty: 2 }], confirm: true, payments: [{ method: 'pix', amount: 200 }], customer_id: cust }, vend); assert.equal(s.statusCode, 201, s.body);
  const pend = (await call('GET', '/commissions/pending', undefined, fin)).json().items; const row = pend.find((x: { name: string }) => x.name === 'vendedor'); assert.equal(Number(row.commission), 4);
  assert.equal((await call('POST', '/commissions/close', { seller_id: row.seller_id, up_to: day(0), due_date: day(10) }, fin)).statusCode, 403);
  const c = await call('POST', '/commissions/close', { seller_id: row.seller_id, up_to: day(0), due_date: day(10) }, ger); assert.equal(c.statusCode, 201, c.body);
  const pay = (await call('GET', '/payables/' + c.json().payable_id)).json(); assert.equal(Number(pay.amount), 4); assert.equal(pay.payee_name, 'vendedor'); assert.equal(pay.category_name, 'Comissões');
  assert.equal((await call('POST', '/commissions/close', { seller_id: row.seller_id, up_to: day(0), due_date: day(10) }, ger)).statusCode, 422);
  // recebível da venda a prazo ficou em aberto (boleto) e no aging
  const aging = (await call('GET', '/receivables/aging')).json().buckets; assert.ok(Number(aging.find((b: { bucket: string }) => b.bucket === 'a vencer').amount) >= 200);
});

test('vendas à vista: baixa automática só com conta padrão da forma de pagamento', async () => {
  await call('PUT', '/finance/settings', { fine_pct: 2, interest_monthly_pct: 1, grace_days: 0, default_accounts: { pix: bank } }, ger);
  const prod = (await call('GET', '/products?q=C1')).json().items[0].id; const b0 = await balance(bank);
  const pixSale = (await call('POST', '/sales', { type: 'balcao', items: [{ product_id: prod, qty: 1 }], confirm: true, payments: [{ method: 'pix', amount: 100 }] }, adm)).json();
  const cashSale = (await call('POST', '/sales', { type: 'balcao', items: [{ product_id: prod, qty: 1 }], confirm: true, payments: [{ method: 'dinheiro', amount: 100 }] }, adm)).json();
  assert.equal(await balance(bank), b0 + 100);
  assert.equal((await call('GET', '/sales/' + pixSale.id)).json().receivables[0].status, 'pago'); assert.equal((await call('GET', '/sales/' + cashSale.id)).json().receivables[0].status, 'aberto');
  assert.equal((await call('PUT', '/finance/settings', { fine_pct: 2, interest_monthly_pct: 1, grace_days: 0, default_accounts: { pix: bank } }, fin)).statusCode, 403);
});

test('permissões e isolamento do financeiro', async () => {
  assert.equal((await call('GET', '/receivables', undefined, vend)).statusCode, 403); assert.equal((await call('GET', '/bank-accounts', undefined, vend)).statusCode, 403);
  assert.equal((await call('GET', '/bank-accounts', undefined, other)).json().items.length, 0);
  assert.equal((await call('GET', `/bank-accounts/${bank}/statement`, undefined, other)).statusCode, 404);
  assert.equal((await call('POST', `/receivables/${(await mkRec(10, 1)).id}/settle`, { account_id: bank }, other)).statusCode, 404);
});
