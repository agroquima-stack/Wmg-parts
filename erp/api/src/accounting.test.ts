import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { buildApp } = await import('./app.js');
const { pool, tx } = await import('./db.js');
const { createCompany } = await import('./scripts/company.js');
const { hashPassword } = await import('./lib/security.js');

let app: Awaited<ReturnType<typeof buildApp>>; let adm = '', fin = '', vend = '', other = '', cid = '';
let bank = '', apl = '', prod = '', sup = '', cust = '', brandId = '', catId = '', prod2 = '';
const call = (method: string, url: string, body?: unknown, token = adm) =>
  app.inject({ method: method as 'GET', url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Senha12345x' } })).json().token;
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);
const prevMonthStart = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); };
const dre = async (q = '') => (await call('GET', `/accounting/dre?from=${month()}-01&to=${day(0)}${q}`, undefined, fin)).json();
const sm = (r: any, k: string) => (r.summary[k].total ?? Object.values(r.summary[k])[0]) as number;
const ledgerBal = async (key: string) => Number((await pool.query(`select coalesce(sum(l.debit - l.credit),0) s from journal_lines l join ledger_accounts a on a.id = l.account_id where l.company_id = $1 and a.system_key = $2`, [cid, key])).rows[0].s);
const bankBal = async (id: string) => Number((await call('GET', '/bank-accounts')).json().items.find((a: { id: string }) => a.id === id).balance);
const sell = async (type: string, qty: number, product = prod, token = adm) => {
  const pre = (await call('POST', '/sales/preview', { customer_id: cust, channel: type, items: [{ product_id: product, qty }] }, token)).json();
  const r = await call('POST', '/sales', { type, customer_id: cust, items: [{ product_id: product, qty }], confirm: true, payments: [{ method: 'pix', amount: pre.totals.total }] }, token); assert.equal(r.statusCode, 201, r.body); return r.json();
};

before(async () => {
  app = await buildApp(); const st = Date.now(); const pw = await hashPassword('Senha12345x');
  const r = await tx((db) => createCompany(db, { legalName: 'Contábil Teste', adminName: 'Adm', adminEmail: `adm${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false })); cid = r.companyId;
  for (const [role, k] of [['financeiro', 'f'], ['vendedor', 'v']] as const) await pool.query(`insert into users (company_id, role_id, name, email, password_hash, is_seller, commission_pct) values ($1,$2,$3,$4,$5,$6,2)`, [r.companyId, r.roleIds[role], role, `${k}${st}@t.local`, pw, role === 'vendedor']);
  adm = await login(`adm${st}@t.local`); fin = await login(`f${st}@t.local`); vend = await login(`v${st}@t.local`);
  await tx((db) => createCompany(db, { legalName: 'Outra', adminName: 'O', adminEmail: `o${st}@t.local`, adminPassword: 'Senha12345x', mustChangePassword: false })); other = await login(`o${st}@t.local`);
  await call('PUT', '/pricing/settings', { params: { freight_pct: 0, insurance_pct: 0, accessory_pct: 0, tax_pct: 6, commission_pct: 0, card_fee_pct: 0, variable_expenses_pct: 0 } });
  bank = (await call('POST', '/bank-accounts', { name: 'BTG Pactual', kind: 'banco', opening_balance: 22600.07, opening_date: day(-20) })).json().id;
  apl = (await call('POST', '/bank-accounts', { name: 'Aplicação BTG', kind: 'aplicacao', opening_balance: 0 })).json().id;
  await call('PUT', '/finance/settings', { fine_pct: 2, interest_monthly_pct: 1, grace_days: 0, default_accounts: { pix: bank } });
  brandId = (await call('POST', '/brands', { name: 'Marca X' })).json().id; catId = (await call('POST', '/categories', { name: 'Cat X' })).json().id;
  prod = (await call('POST', '/products', { sku: 'AC1', description: 'Peça contábil', cost_current: 10, sale_price: 50, min_margin_pct: 10, brand_id: brandId, category_id: catId, ncm: '87141000', origin: 0 })).json().id;
  prod2 = (await call('POST', '/products', { sku: 'AC2', description: 'Peça contábil 2', cost_current: 10, sale_price: 50, min_margin_pct: 10, ncm: '87141000', origin: 0 })).json().id;
  sup = (await call('POST', '/suppliers', { legal_name: 'Fornecedor Cont', payment_terms_days: 30 })).json().id;
  cust = (await call('POST', '/customers', { type: 'PJ', document: '11.222.333/0001-81', legal_name: 'Cliente Contábil', credit_limit: 100000 })).json().id;
});
after(async () => { await app.close(); await pool.end(); });

test('plano de contas padrão, mapa de categorias e proteção das contas do sistema', async () => {
  const accs = (await call('GET', '/accounting/accounts', undefined, fin)).json().items; assert.ok(accs.length >= 40); assert.ok(accs.find((x: { system_key: string }) => x.system_key === 'cmv'));
  assert.ok((await call('GET', '/accounting/category-map', undefined, fin)).json().items.every((c: { ledger_account_id: string | null }) => c.ledger_account_id));
  assert.equal((await call('POST', '/accounting/accounts', { code: '5.2.9.50', name: 'Seguros', type: 'despesa' }, fin)).statusCode, 422);                       // conta de resultado exige grupo da DRE
  assert.equal((await call('POST', '/accounting/accounts', { code: '5.2.9.50', name: 'Seguros', type: 'despesa', dre_group: 'desp_administrativa' }, fin)).statusCode, 201);
  assert.equal((await call('POST', '/accounting/accounts', { code: '5.2.9.50', name: 'Duplicada', type: 'despesa', dre_group: 'desp_administrativa' }, fin)).statusCode, 409);
  const cmv = accs.find((x: { system_key: string }) => x.system_key === 'cmv'); assert.equal((await call('PATCH', '/accounting/accounts/' + cmv.id, { active: false }, fin)).statusCode, 409);
  assert.equal((await call('PATCH', '/accounting/accounts/' + cmv.id, { name: 'CMV (renomeado)' }, fin)).statusCode, 200);                                          // renomear pode; a chave interna segue valendo
});

test('saldo inicial R$ 22.600,07: débito em bancos, crédito em capital social, balanço fechando', async () => {
  const bs = (await call('GET', `/accounting/balance-sheet?as_of=${day(0)}`, undefined, fin)).json();
  assert.equal(bs.assets.total, 22600.07); assert.equal(bs.equity.accounts.find((a: { key: string }) => a.key === 'capital').value, 22600.07); assert.equal(bs.balanced, true);
  assert.equal(await ledgerBal('bancos'), 22600.07);
});

test('compra: entrada de NF → estoque × fornecedores; pagamento → fornecedores × bancos', async () => {
  const rc = (await call('POST', '/receivings', { supplier_id: sup, nf_number: 'C-1', items: [{ product_id: prod, qty: 100, unit_price: 10 }, { product_id: prod2, qty: 50, unit_price: 10 }] })).json();
  await call('POST', `/receivings/${rc.id}/check-all`); assert.equal((await call('POST', `/receivings/${rc.id}/finish`, {})).statusCode, 200);
  assert.equal(await ledgerBal('estoques'), 1500); assert.equal(-(await ledgerBal('fornecedores')), 1500);
  const pay = (await call('GET', '/payables?status=aberto')).json().items.find((p: { doc_number: string }) => p.doc_number === 'C-1');
  const b0 = await bankBal(bank); assert.equal((await call('POST', `/payables/${pay.id}/settle`, { account_id: bank }, fin)).statusCode, 200);
  assert.equal(await ledgerBal('fornecedores'), 0); assert.equal(await bankBal(bank), Math.round((b0 - 1500) * 100) / 100); assert.equal(await ledgerBal('bancos'), await bankBal(bank));
});

test('venda: receita, impostos (6%), CMV e comissão (2%) na DRE por competência', async () => {
  const s = await sell('externo', 10, prod, vend); assert.equal(Number(s.total), 500);
  const r = await dre(); assert.equal(sm(r, 'receita_bruta'), 500); assert.equal(r.lines.find((l: { key: string }) => l.key === 'impostos').values.total, -30);
  assert.equal(sm(r, 'receita_liquida'), 470); assert.equal(r.lines.find((l: { key: string }) => l.key === 'cmv').values.total, -100); assert.equal(sm(r, 'lucro_bruto'), 370);
  assert.equal(r.lines.find((l: { key: string }) => l.key === 'desp_comercial').values.total, -10); assert.equal(sm(r, 'lucro_liquido'), 360); assert.equal(r.regime, 'competência');
  assert.equal(await ledgerBal('contas_receber'), 0);                        // Pix baixado automaticamente na conta padrão
  assert.equal(await ledgerBal('estoques'), 1400);
});

test('DRE por canal, marca e categoria; somas fecham com o total', async () => {
  await sell('online', 5, prod, adm);
  const tot = await dre(); const ch = await dre('&group_by=channel'); const keys = ch.columns.map((c: { key: string }) => c.key);
  assert.ok(keys.includes('externo') && keys.includes('online')); const rb = ch.lines.find((l: { key: string }) => l.key === 'receita_bruta').values;
  assert.equal(rb.externo, 500); assert.equal(rb.online, 250); assert.equal(sm(tot, 'receita_bruta'), 750);
  const br = await dre('&group_by=brand'); assert.ok(br.columns.some((c: { label: string }) => c.label === 'Marca X')); const ct = await dre('&group_by=category'); assert.ok(ct.columns.some((c: { label: string }) => c.label === 'Cat X'));
  const only = await dre('&channel=online'); assert.equal(sm(only, 'receita_bruta'), 250); assert.equal(only.lines.find((l: { key: string }) => l.key === 'cmv').values.total, -50);
  const byMonth = await dre('&group_by=month'); assert.equal(byMonth.columns.length, 1);
  assert.equal((await call('GET', `/accounting/dre?group_by=xyz`, undefined, fin)).statusCode, 422);
});

test('despesa por competência: aluguel do mês anterior aparece na DRE daquele mês, não neste', async () => {
  const cat = (await call('GET', '/finance/categories')).json().items.find((c: { name: string }) => c.name === 'Aluguel').id; const cc = (await call('GET', '/finance/cost-centers')).json().items.find((c: { name: string }) => c.name === 'Administrativo').id;
  const p = (await call('POST', '/payables', { description: 'Aluguel mês anterior', category_id: cat, cost_center_id: cc, first_due_date: day(5), amount: 1000, competence: prevMonthStart(), supplier_id: sup }, fin)).json().items[0];
  const prev = (await call('GET', `/accounting/dre?from=${prevMonthStart()}&to=${prevMonthStart().slice(0, 7)}-28`, undefined, fin)).json(); assert.equal(prev.lines.find((l: { key: string }) => l.key === 'desp_administrativa').values.total, -1000);
  assert.equal((await dre()).lines.find((l: { key: string }) => l.key === 'desp_administrativa').values.total, 0);
  assert.equal(await ledgerBal('outras_pagar'), -1000);
  assert.equal((await call('POST', `/payables/${p.id}/settle`, { account_id: bank }, fin)).statusCode, 200); assert.equal(await ledgerBal('outras_pagar'), 0);
  const ccr = (await call('GET', `/accounting/cost-centers?from=${prevMonthStart()}&to=${prevMonthStart().slice(0, 7)}-28`, undefined, fin)).json(); assert.equal(ccr.items.find((x: { name: string }) => x.name === 'Administrativo').total, 1000);
  assert.equal((await call('POST', '/payables', { description: 'Compra sem NF', category_id: (await call('GET', '/finance/categories')).json().items.find((c: { name: string }) => c.name === 'Compra de mercadorias').id, first_due_date: day(5), amount: 10 }, fin)).statusCode, 422);   // mercadoria só entra por NF
});

test('baixa com juros, multa, desconto e taxa: receitas/despesas financeiras e descontos na DRE; estorno', async () => {
  const t = (await call('POST', '/receivables', { customer_id: cust, due_date: day(-30), amount: 1000, description: 'Serviço avulso' }, fin)).json();
  const b0 = await bankBal(bank); const s = await call('POST', `/receivables/${t.id}/settle`, { account_id: bank, discount: 10, fee: 5 }, adm); assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json().cash, 1015);                                           // 1000 − 10 desconto + 20 multa + 10 juros − 5 taxa
  const r = await dre(); assert.equal(r.lines.find((l: { key: string }) => l.key === 'rec_financeira').values.total, 30); assert.equal(r.lines.find((l: { key: string }) => l.key === 'desp_financeira').values.total, -5);
  assert.equal(r.lines.find((l: { key: string }) => l.key === 'deducoes').values.total, -10); assert.equal(r.lines.find((l: { key: string }) => l.key === 'outros').values.total, 1000);
  assert.equal(await bankBal(bank), Math.round((b0 + 1015) * 100) / 100); assert.equal(await ledgerBal('bancos'), await bankBal(bank));
  assert.equal((await call('POST', `/settlements/${s.json().settlement.id}/reverse`, undefined, adm)).statusCode, 200);
  assert.equal(await ledgerBal('contas_receber'), 1000); assert.equal(await ledgerBal('bancos'), await bankBal(bank)); assert.equal((await dre()).lines.find((l: { key: string }) => l.key === 'rec_financeira').values.total, 0);
});

test('cancelamento de venda: devolução na DRE, estoque volta, valor recebido vira restituição a pagar', async () => {
  const s = await sell('online', 4, prod2, adm); const before = await dre(); const cmvBefore = before.lines.find((l: { key: string }) => l.key === 'cmv').values.total;
  assert.equal((await call('POST', `/sales/${s.id}/cancel`, { reason: 'Cliente desistiu da compra' }, adm)).statusCode, 200);
  const after = await dre(); assert.equal(after.lines.find((l: { key: string }) => l.key === 'deducoes').values.total, -200);               // devolução de R$ 200
  assert.equal(after.lines.find((l: { key: string }) => l.key === 'cmv').values.total, cmvBefore + 40);                                    // CMV da venda revertido
  assert.equal(-(await ledgerBal('clientes_restituir')), 200);
  const refund = (await call('GET', '/payables?status=aberto&q=Restituição')).json().items[0]; assert.equal(Number(refund.amount), 200); assert.equal(refund.category_name, 'Restituições a clientes');
  assert.equal((await call('POST', `/payables/${refund.id}/settle`, { account_id: bank }, fin)).statusCode, 200); assert.equal(await ledgerBal('clientes_restituir'), 0); assert.equal(await ledgerBal('bancos'), await bankBal(bank));
});

test('tarifas, rendimentos e aplicação entre contas; transferências compensam a zero', async () => {
  assert.equal((await call('POST', '/account-movements', { account_id: bank, kind: 'tarifa', amount: -39.9, description: 'Tarifa pacote' }, fin)).statusCode, 201);
  assert.equal((await call('POST', '/account-movements', { account_id: apl, kind: 'rendimento', amount: 12.34, description: 'Rendimento CDB' }, fin)).statusCode, 201);
  assert.equal((await call('POST', '/bank-accounts/transfer', { from_account_id: bank, to_account_id: apl, amount: 300, kind: 'aplicacao' }, fin)).statusCode, 201);
  assert.equal(await ledgerBal('aplicacoes'), 312.34); assert.equal(await ledgerBal('transferencias'), 0); assert.equal(await ledgerBal('bancos'), await bankBal(bank));
  const r = await dre(); assert.equal(r.lines.find((l: { key: string }) => l.key === 'desp_financeira').values.total, -39.9);               // só a tarifa: a taxa de cartão foi estornada junto com a baixa
});

test('DAS: provisão nas vendas e ajuste ao valor oficial da guia; pagamento baixa a obrigação', async () => {
  const prov = async () => -(await ledgerBal('obrigacoes_trib')) || 0;
  const p0 = await prov(); assert.ok(p0 > 0);
  const gen = (await call('POST', '/taxes/obligations/generate', { competence: month() }, adm)).json(); await call('PATCH', `/taxes/obligations/${gen.id}`, { amount: 100, guide_ref: 'PGDAS' }, adm);
  const pay = (await call('POST', `/taxes/obligations/${gen.id}/payable`, {}, adm)).json(); assert.equal(await prov(), 100);                        // provisão ajustada para o valor da guia
  assert.equal((await dre()).lines.find((l: { key: string }) => l.key === 'impostos').values.total, -100);
  assert.equal((await call('POST', `/payables/${pay.payable_id}/settle`, { account_id: bank }, adm)).statusCode, 200); assert.equal(await prov(), 0); assert.equal(await ledgerBal('bancos'), await bankBal(bank));
});

test('estoque: perda manual vai para CMV (perdas); entrada manual vai para ajustes de abertura', async () => {
  const cmv0 = (await dre()).lines.find((l: { key: string }) => l.key === 'cmv').values.total;
  assert.equal((await call('POST', '/stock/movements', { op: 'ajuste_saida', product_id: prod, qty: 2, reason: 'Item danificado no depósito' })).statusCode, 201);
  assert.equal((await dre()).lines.find((l: { key: string }) => l.key === 'cmv').values.total, cmv0 - 20);
  const est0 = await ledgerBal('estoques'); await call('POST', '/stock/movements', { op: 'entrada', product_id: prod2, qty: 3, unit_cost: 10 }); assert.equal(await ledgerBal('estoques'), est0 + 30); assert.equal(-(await ledgerBal('ajustes_abertura')), 30);
});

test('lançamentos manuais (abertura/ajustes): só quem aprova, balanceados, estorno e razão por conta', async () => {
  const accs = (await call('GET', '/accounting/accounts', undefined, fin)).json().items; const id = (k: string) => accs.find((a: { system_key: string }) => a.system_key === k).id;
  const body = { date: day(-20), description: 'Abertura: imobilizado e empréstimo', kind: 'abertura', lines: [{ account_id: id('imobilizado'), debit: 5000 }, { account_id: id('emprestimos'), credit: 3000 }, { account_id: id('capital'), credit: 2000 }] };
  assert.equal((await call('POST', '/accounting/entries', body, fin)).statusCode, 403);
  assert.equal((await call('POST', '/accounting/entries', { ...body, lines: [{ account_id: id('imobilizado'), debit: 5000 }, { account_id: id('capital'), credit: 4000 }] }, adm)).statusCode, 422);
  const e = await call('POST', '/accounting/entries', body, adm); assert.equal(e.statusCode, 201, e.body);
  const bs = (await call('GET', `/accounting/balance-sheet?as_of=${day(0)}`, undefined, fin)).json(); assert.equal(bs.assets.non_current.find((a: { key: string }) => a.key === 'imobilizado').value, 5000); assert.equal(bs.liabilities.non_current[0].value, 3000); assert.equal(bs.balanced, true);
  const led = (await call('GET', `/accounting/ledger?account_id=${id('imobilizado')}`, undefined, fin)).json(); assert.equal(led.closing, 5000); assert.equal(led.items[0].description, 'Abertura: imobilizado e empréstimo');
  const rev = await call('POST', `/accounting/entries/${e.json().id}/reverse`, { reason: 'lançado em duplicidade' }, adm); assert.equal(rev.statusCode, 200); assert.equal((await call('POST', `/accounting/entries/${e.json().id}/reverse`, { reason: 'de novo' }, adm)).statusCode, 409);
  assert.equal((await call('POST', `/accounting/entries/${rev.json().reversal_id}/reverse`, { reason: 'estorno do estorno' }, adm)).statusCode, 409);
  assert.equal((await call('GET', `/accounting/ledger?account_id=${id('imobilizado')}`, undefined, fin)).json().closing, 0);
});

test('o banco recusa lançamento desbalanceado e impede alterar o razão', async () => {
  const acc = (await pool.query(`select id from ledger_accounts where company_id = $1 and system_key = 'caixa'`, [cid])).rows[0].id; const c = await pool.connect();
  try {
    await c.query('begin'); const e = (await c.query(`insert into journal_entries (company_id, entry_date, competence, description) values ($1, current_date, current_date, 'teste') returning id`, [cid])).rows[0].id;
    await c.query(`insert into journal_lines (entry_id, company_id, account_id, debit) values ($1,$2,$3,10)`, [e, cid, acc]);
    await assert.rejects(c.query('commit'), /desbalanceado/);
  } finally { await c.query('rollback').catch(() => null); c.release(); }
  await assert.rejects(pool.query(`update journal_lines set debit = debit + 1 where company_id = $1`, [cid]), /imutável/); await assert.rejects(pool.query(`delete from journal_entries where company_id = $1`, [cid]), /imutável/);
});

test('verificações de consistência, balancete, identidade do balanço e sincronização idempotente', async () => {
  const ck = (await call('GET', '/accounting/checks', undefined, fin)).json(); const bad = ck.checks.filter((c: { ok: boolean }) => !c.ok); assert.deepEqual(bad.map((c: { key: string; diff: number }) => `${c.key}:${c.diff}`), []);
  const tb = (await call('GET', `/accounting/trial-balance?from=${month()}-01&to=${day(0)}`, undefined, fin)).json(); assert.equal(tb.total_debit, tb.total_credit);
  const bs = (await call('GET', `/accounting/balance-sheet`, undefined, fin)).json(); assert.equal(bs.balanced, true); assert.equal(bs.total_liabilities_equity, bs.assets.total);
  const s1 = (await call('POST', '/accounting/sync', undefined, adm)).json(); assert.equal(s1.created, 0);                     // tudo já foi lançado pelos eventos
  await pool.query(`insert into payables (company_id, due_date, amount, description, category_id, competence) select $1, current_date, 77, 'Despesa legada sem lançamento', id, date_trunc('month', current_date)::date from finance_categories where company_id = $1 and name = 'Aluguel'`, [cid]);
  const s2 = (await call('POST', '/accounting/sync', undefined, adm)).json(); assert.equal(s2.created, 1); assert.equal((await call('POST', '/accounting/sync', undefined, adm)).json().created, 0);
  assert.equal((await call('POST', '/accounting/sync', undefined, fin)).statusCode, 403);
});

test('permissões e isolamento da contabilidade', async () => {
  assert.equal((await call('GET', '/accounting/dre', undefined, vend)).statusCode, 403); assert.equal((await call('GET', '/accounting/balance-sheet', undefined, vend)).statusCode, 403);
  const mine = (await call('GET', '/accounting/entries', undefined, other)).json().items; assert.equal(mine.length, 0);
  const o = (await call('GET', '/accounting/accounts', undefined, other)).json().items; assert.ok(o.length >= 40); assert.ok(o.every((a: { id: string }) => a.id));
  const dash = (await call('GET', '/dashboard/summary', undefined, fin)).json().accounting; assert.ok(dash && typeof dash.lucro_liquido === 'number');
});
