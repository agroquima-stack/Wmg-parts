// Compras de DEMONSTRAÇÃO: vínculo fornecedor×produto, histórico de preços, pedidos, recebimentos e contas a pagar (via serviços reais).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { pool, tx } from '../db.js';
import { authForUser } from '../sales.js';
import { createReceiving, finishReceiving, recordSupplierPrice } from '../purchasing.js';
import { createPO } from '../routes/purchasing.js';

const co = (await pool.query(`select id from companies where is_demo order by created_at limit 1`)).rows[0];
if (!co) { console.log('Sem empresa demo.'); await pool.end(); process.exit(0); }
if ((await pool.query('select 1 from purchase_orders where company_id = $1 limit 1', [co.id])).rowCount) { console.log('Compras demo já existem.'); await pool.end(); process.exit(0); }
const cid = co.id as string;

const sups = (await pool.query('select id, cnpj, legal_name from suppliers where company_id = $1 order by legal_name', [cid])).rows;
const prods = (await pool.query('select p.id, p.sku, p.cost_current, p.manufacturer_code, b.name as brand, (select barcode from product_barcodes where product_id = p.id limit 1) as ean from products p left join brands b on b.id = p.brand_id where p.company_id = $1 order by p.sku', [cid])).rows;
const branch = (await pool.query('select id from branches where company_id = $1 order by is_headquarters desc limit 1', [cid])).rows[0].id;
const admin = (await pool.query('select id from users where company_id = $1 order by created_at limit 1', [cid])).rows[0].id;
const supOf = (brand: string) => sups.find((s) => s.legal_name.includes(brand.split(' ')[0])) ?? sups[0];

await tx(async (db) => {
  for (const [i, p] of prods.entries()) {
    const main = supOf(p.brand), alt = sups[(sups.indexOf(main) + 3) % sups.length];
    for (const [k, s] of [main, alt].entries()) {
      await db.query(`insert into supplier_products (company_id, supplier_id, product_id, supplier_code, preferred) values ($1,$2,$3,$4,$5) on conflict do nothing`, [cid, s.id, p.id, `${s.cnpj.slice(0, 4)}-${p.manufacturer_code}`, k === 0]);
      // 3 cotações ao longo do tempo; alguns fornecedores vêm subindo o preço
      const base = Number(p.cost_current) * (k === 0 ? 1 : 1.06); const raise = (sups.indexOf(s) % 3 === 0) ? 1.07 : 1.005;
      for (let m = 0; m < 3; m++) await recordSupplierPrice(db, cid, s.id, p.id, Math.round(base * Math.pow(raise, m) * 100) / 100, 'manual', 'DEMONSTRAÇÃO');
      await db.query(`update supplier_prices set created_at = now() - (($3 - id % 3) * 40 || ' days')::interval where supplier_id = $1 and product_id = $2 and ref = 'DEMONSTRAÇÃO'`, [s.id, p.id, 3]);
    }
    void i;
  }
  const a = await authForUser(db, admin, branch);
  const price = async (pid: string, sid: string) => Number((await db.query('select price from supplier_prices where supplier_id = $1 and product_id = $2 order by created_at desc, id desc limit 1', [sid, pid])).rows[0].price);
  const mk = async (supplier: (typeof sups)[number], pickup: typeof prods, qty: number, expected: string) =>
    createPO(db, a, { branchId: branch, supplierId: supplier.id, items: await Promise.all(pickup.map(async (p) => ({ product_id: p.id, qty, unit_price: await price(p.id, supplier.id) }))), submit: true, expectedDate: expected, notes: 'DEMONSTRAÇÃO' });
  const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const s0 = supOf(prods[0].brand), s1 = supOf(prods[1].brand);
  const forS0 = prods.filter((p) => supOf(p.brand) === s0).slice(0, 3);
  await mk(s0, forS0, 20, day(-4));                                   // atrasado
  await mk(s1, prods.filter((p) => supOf(p.brand) === s1).slice(0, 2), 15, day(6));   // em dia
  // pedido recebido por completo → entrada de estoque, custo médio e contas a pagar (uma vencida, uma a vencer)
  const poDone = await mk(sups[2], prods.filter((p) => supOf(p.brand) === sups[2]).slice(0, 2), 10, day(-10));
  const items = (await db.query('select * from purchase_order_items where po_id = $1', [poDone.id])).rows;
  const rec = await createReceiving(db, a, { branchId: branch, poId: poDone.id, supplierId: sups[2].id, source: 'manual', nfNumber: 'DEMO-1001', freight: 40, issueDate: day(-9),
    items: items.map((i) => ({ product_id: i.product_id, description: 'DEMONSTRAÇÃO', qty: Number(i.qty), unit_price: Number(i.unit_price) })) });
  await db.query('update receiving_items set qty_received = qty_nf where receiving_id = $1', [rec.id]);
  await finishReceiving(db, a, rec.id, false);
  await db.query(`update payables set due_date = current_date - 3 where receiving_id = $1`, [rec.id]);
  // segunda NF: a vencer em 5 dias
  const po2 = await mk(sups[4], prods.filter((p) => supOf(p.brand) === sups[4]).slice(0, 1), 12, day(-5));
  const it2 = (await db.query('select * from purchase_order_items where po_id = $1', [po2.id])).rows;
  const rec2 = await createReceiving(db, a, { branchId: branch, poId: po2.id, supplierId: sups[4].id, source: 'manual', nfNumber: 'DEMO-1002', issueDate: day(-4), items: it2.map((i) => ({ product_id: i.product_id, description: 'DEMONSTRAÇÃO', qty: Number(i.qty), unit_price: Number(i.unit_price) })) });
  await db.query('update receiving_items set qty_received = qty_nf where receiving_id = $1', [rec2.id]);
  await finishReceiving(db, a, rec2.id, false);
  await db.query(`update payables set due_date = current_date + 5 where receiving_id = $1`, [rec2.id]);
});

// NF-e de exemplo (fictícia) para testar a importação de XML: fornecedor e produtos da demonstração
const s = sups[0]; const mine = prods.filter((p) => supOf(p.brand) === s).slice(0, 2);
const lines = mine.map((p, k) => `<det nItem="${k + 1}"><prod><cProd>${s.cnpj.slice(0, 4)}-${p.manufacturer_code}</cProd><cEAN>${p.ean ?? 'SEM GTIN'}</cEAN><xProd>${p.sku} DEMONSTRACAO</xProd><NCM>87141000</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>10.0000</qCom><vUnCom>${Number(p.cost_current).toFixed(4)}</vUnCom><vProd>${(Number(p.cost_current) * 10).toFixed(2)}</vProd></prod><imposto><IPI><IPITrib><vIPI>0.00</vIPI></IPITrib></IPI></imposto></det>`).join('');
const prodTotal = mine.reduce((t, p) => t + Number(p.cost_current) * 10, 0);
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../samples/nfe-exemplo-demo.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<!-- NF-e FICTÍCIA para DEMONSTRAÇÃO -->\n<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe35261000000000000000550010000099991000099990" versao="4.00"><ide><nNF>9999</nNF><serie>1</serie><dhEmi>2026-10-01T10:00:00-03:00</dhEmi></ide><emit><CNPJ>${s.cnpj}</CNPJ><xNome>${s.legal_name}</xNome></emit>${lines}<total><ICMSTot><vProd>${prodTotal.toFixed(2)}</vProd><vFrete>25.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vOutro>0.00</vOutro><vIPI>0.00</vIPI><vNF>${(prodTotal + 25).toFixed(2)}</vNF></ICMSTot></total><cobr><dup><nDup>001</nDup><dVenc>2026-11-10</dVenc><vDup>${(prodTotal + 25).toFixed(2)}</vDup></dup></cobr></infNFe></NFe></nfeProc>\n`);
console.log('Compras de demonstração criadas (3 pedidos, 2 recebimentos, contas a pagar) e samples/nfe-exemplo-demo.xml gerado.');
await pool.end();
