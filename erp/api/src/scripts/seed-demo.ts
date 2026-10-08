// Cria uma empresa de DEMONSTRAÇÃO (marcada is_demo) com cadastros da Fase 1.
// Tudo aqui é fictício e identificado como DEMO. Nunca rode em ambiente de produção.
import { pool, tx } from '../db.js';
import { migrate } from './migrate.js';
import { createCompany } from './company.js';
import { hashPassword } from '../lib/security.js';

const DEMO_EMAIL = process.env.DEMO_EMAIL ?? 'admin@demo.local';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo@12345678';

const cpfDigit = (base: number[]) => { const n = base.length + 1; const s = base.reduce((a, d, i) => a + d * (n - i), 0); return ((s * 10) % 11) % 10; };
function fakeCPF(seed: number) {
  const b = String(100000000 + ((seed * 7919) % 899999999)).split('').map(Number);
  const d1 = cpfDigit(b), d2 = cpfDigit([...b, d1]); return [...b, d1, d2].join('');
}
function fakeCNPJ(seed: number) {
  const b = (String(10000000 + ((seed * 104729) % 89999999)) + '0001').split('').map(Number);
  const dv = (arr: number[], w: number[]) => { const r = arr.reduce((a, d, i) => a + d * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = dv(b, [5,4,3,2,9,8,7,6,5,4,3,2]); const d2 = dv([...b, d1], [6,5,4,3,2,9,8,7,6,5,4,3,2]);
  return [...b, d1, d2].join('');
}
function ean13(seed: number) {
  const b = ('789' + String(900000000 + seed * 137).slice(0, 9)).split('').map(Number);
  const s = b.reduce((a, d, i) => a + d * (i % 2 ? 3 : 1), 0); return [...b, (10 - (s % 10)) % 10].join('');
}

const brands = ['Cobreq', 'Fischer', 'Fras-le', 'Honda (original)', 'Yamaha (original)', 'Vedamotors', 'Metal Leve', 'Cofap', 'Pro Tork', 'NGK'];
const models: Array<[string, string, string | null, number, number | null, number | null]> = [
  ['Honda', 'CG 160', 'Titan', 2016, null, 160], ['Honda', 'CG 160', 'Fan', 2016, null, 160], ['Honda', 'CG 160', 'Start', 2018, null, 160],
  ['Honda', 'CG 125', 'Fan', 2009, 2013, 125], ['Honda', 'Biz 125', null, 2011, null, 125], ['Honda', 'Pop 110i', null, 2015, null, 110],
  ['Honda', 'CB 300F', 'Twister', 2010, 2015, 300], ['Honda', 'XRE 300', null, 2009, null, 300], ['Honda', 'Bros 160', null, 2015, null, 160], ['Honda', 'NXR 150', 'Bros', 2006, 2014, 150],
  ['Yamaha', 'Fazer 250', null, 2006, null, 250], ['Yamaha', 'Factor 150', null, 2016, null, 150], ['Yamaha', 'Factor 125', null, 2009, null, 125],
  ['Yamaha', 'YBR 125', null, 2000, 2015, 125], ['Yamaha', 'Fazer 150', null, 2014, null, 150], ['Yamaha', 'XTZ 250', 'Lander', 2006, null, 250],
  ['Yamaha', 'NMAX 160', null, 2016, null, 160], ['Suzuki', 'Yes 125', null, 2005, 2015, 125], ['Shineray', 'XY 50', 'Q', 2010, null, 50], ['Kawasaki', 'Ninja 400', null, 2018, null, 400],
];
// [nome, categoria, subcategoria, sistema, posição, custo base, estoque mínimo]
const parts: Array<[string, string, string, string, string | null, number, number]> = [
  ['Pastilha de freio dianteira', 'Freios', 'Pastilhas', 'Sistema de freio', 'Dianteira', 22, 20],
  ['Pastilha de freio traseira', 'Freios', 'Pastilhas', 'Sistema de freio', 'Traseira', 19, 15],
  ['Disco de freio dianteiro', 'Freios', 'Discos', 'Sistema de freio', 'Dianteira', 118, 6],
  ['Lona de freio traseira', 'Freios', 'Lonas', 'Sistema de freio', 'Traseira', 16, 15],
  ['Kit relação (corrente, coroa e pinhão)', 'Transmissão', 'Kit relação', 'Transmissão', null, 78, 10],
  ['Corrente de transmissão 428H', 'Transmissão', 'Correntes', 'Transmissão', null, 41, 10],
  ['Vela de ignição', 'Elétrica', 'Velas', 'Ignição', null, 12, 40],
  ['Filtro de óleo', 'Filtros', 'Óleo', 'Lubrificação', null, 8, 40],
  ['Filtro de ar', 'Filtros', 'Ar', 'Admissão', null, 14, 25],
  ['Kit pistão e anéis', 'Motor', 'Pistões', 'Motor', null, 135, 5],
  ['Cabo de acelerador', 'Cabos', 'Acelerador', 'Comandos', null, 17, 15],
  ['Cabo de embreagem', 'Cabos', 'Embreagem', 'Comandos', null, 18, 15],
  ['Bateria 12V 5Ah', 'Elétrica', 'Baterias', 'Elétrica', null, 95, 8],
  ['Pneu dianteiro 80/100-18', 'Pneus', 'Dianteiros', 'Rodagem', 'Dianteira', 142, 6],
  ['Pneu traseiro 90/90-18', 'Pneus', 'Traseiros', 'Rodagem', 'Traseira', 168, 6],
  ['Amortecedor traseiro', 'Suspensão', 'Amortecedores', 'Suspensão', 'Traseira', 126, 6],
  ['Retentor de garfo', 'Suspensão', 'Retentores', 'Suspensão', 'Dianteira', 21, 20],
];
const honda = [0, 1, 2, 8, 6, 4, 5, 7, 3, 9]; const yamaha = [10, 11, 14, 12, 13, 15, 16];
const cities: Array<[string, string]> = [['Goiânia', 'GO'], ['Anápolis', 'GO'], ['Aparecida de Goiânia', 'GO'], ['Brasília', 'DF'], ['Uberlândia', 'MG'], ['Rio Verde', 'GO']];

await migrate();
const exists = await pool.query('select 1 from users where lower(email) = lower($1)', [DEMO_EMAIL]);
if (exists.rowCount) { console.log('Demo já existe — nada a fazer.'); await pool.end(); process.exit(0); }

await tx(async (db) => {
  const { companyId, roleIds } = await createCompany(db, {
    legalName: 'DEMONSTRAÇÃO — Distribuidora Exemplo Ltda', tradeName: 'Demo Motopeças', isDemo: true,
    adminName: 'Admin Demonstração', adminEmail: DEMO_EMAIL, adminPassword: DEMO_PASSWORD, mustChangePassword: false });
  const ins = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows[0].id as string;

  const brandIds = [] as string[];
  for (const b of brands) brandIds.push(await ins('insert into brands (company_id, name) values ($1,$2) returning id', [companyId, b]));

  const catIds = new Map<string, string>();
  for (const [, cat, sub] of parts) {
    if (!catIds.has(cat)) catIds.set(cat, await ins('insert into categories (company_id, name) values ($1,$2) returning id', [companyId, cat]));
    const k = `${cat}/${sub}`;
    if (!catIds.has(k)) catIds.set(k, await ins('insert into categories (company_id, name, parent_id) values ($1,$2,$3) returning id', [companyId, sub, catIds.get(cat)]));
  }

  const modelIds = [] as string[];
  for (const [make, model, version, yf, yt, cc] of models)
    modelIds.push(await ins('insert into vehicle_models (company_id, make, model, version, year_from, year_to, displacement_cc) values ($1,$2,$3,$4,$5,$6,$7) returning id', [companyId, make, model, version, yf, yt, cc]));

  const pwd = await hashPassword(DEMO_PASSWORD);
  const sellers = [] as string[];
  const names = ['Carlos Vendas', 'Marina Balcão', 'Roberto Externo', 'Juliana B2B', 'Paulo Atacado'];
  for (let i = 0; i < 5; i++)
    sellers.push(await ins(`insert into users (company_id, role_id, name, email, password_hash, is_seller, commission_pct, max_discount_pct)
      values ($1,$2,$3,$4,$5,true,$6,$7) returning id`, [companyId, roleIds.vendedor, `${names[i]} (DEMO)`, `vendedor${i + 1}@demo.local`, pwd, 2 + (i % 3), 5]));

  const productIds = [] as string[];
  for (let i = 0; i < 50; i++) {
    const [name, cat, sub, , , baseCost, minStock] = parts[i % parts.length];
    const isHonda = i % 2 === 0; const bi = (i * 3 + (isHonda ? 0 : 1)) % brands.length;
    const cost = Math.round(baseCost * (0.9 + (bi % 5) * 0.08) * 100) / 100;
    const margin = 38 + (i % 4) * 3;
    const price = Math.floor(cost / (1 - margin / 100)) + 0.9;
    const id = await ins(
      `insert into products (company_id, sku, internal_code, manufacturer_code, description, commercial_description, brand_id, category_id, subcategory_id,
        unit, ncm, origin, active, min_stock, max_stock, ideal_stock, location, cost_current, cost_avg, cost_last, sale_price, min_price, min_margin_pct, target_margin_pct)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'UN','87141000',0,true,$10,$11,$12,$13,$14,$14,$14,$15,$16,20,$17) returning id`,
      [companyId, `DEMO-${String(i + 1).padStart(4, '0')}`, `D${1000 + i}`, `MFR-${2000 + i * 7}`, `${name} ${isHonda ? 'Honda' : 'Yamaha'} — ${brands[bi]}`,
       'DEMONSTRAÇÃO — dado fictício', brandIds[bi], catIds.get(cat), catIds.get(`${cat}/${sub}`),
       minStock, minStock * 4, minStock * 2, `A${(i % 9) + 1}-P${(i % 5) + 1}`, cost, price, Math.round(cost * 1.25 * 100) / 100, margin]);
    productIds.push(id);
    await db.query('insert into product_barcodes (company_id, product_id, barcode) values ($1,$2,$3)', [companyId, id, ean13(i + 1)]);
    const set = isHonda ? honda : yamaha; const [, , , system, position] = parts[i % parts.length];
    for (let k = 0; k < 3; k++) {
      const m = set[(k + (i % 4)) % set.length];
      await db.query('insert into product_applications (company_id, product_id, vehicle_model_id, system, position) values ($1,$2,$3,$4,$5) on conflict do nothing',
        [companyId, id, modelIds[m], system, position]);
    }
  }
  // Equivalências: mesmo tipo de peça e mesma marca de moto (i e i+34)
  for (let i = 0; i < 16; i++) {
    if (i % 2) continue;
    const g = await ins('insert into equivalence_groups (company_id, name) values ($1,$2) returning id', [companyId, `${parts[i % parts.length][0]} — grupo DEMO`]);
    await db.query('insert into product_equivalences values ($1,$2,true)', [g, productIds[i]]);
    await db.query('insert into product_equivalences values ($1,$2,false)', [g, productIds[i + 34]]);
  }

  for (let i = 0; i < 20; i++) {
    const pj = i % 4 !== 3; const [city, uf] = cities[i % cities.length];
    await db.query(
      `insert into customers (company_id, type, document, legal_name, trade_name, city, state, phone, whatsapp, email, segment, seller_id, price_table, credit_limit, payment_condition, payment_term_days, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,$15,'DEMONSTRAÇÃO — dado fictício')`,
      [companyId, pj ? 'PJ' : 'PF', pj ? fakeCNPJ(i + 1) : fakeCPF(i + 1),
       pj ? `${['Oficina', 'Moto Center', 'Auto Moto', 'Motopeças', 'Box'][i % 5]} ${['Silva', 'Souza', 'Goiás', 'Central', 'Norte'][i % 5]} ${i + 1} (DEMO)` : `Cliente Pessoa Física ${i + 1} (DEMO)`,
       pj ? `Demo ${i + 1}` : null, city, uf, `62 9${String(80000000 + i * 1111).slice(0, 8)}`, `cliente${i + 1}@demo.local`,
       pj ? ['oficina', 'lojista', 'revenda'][i % 3] : 'consumidor', sellers[i % 5], pj ? ['oficina', 'atacado', 'revenda'][i % 3] : 'varejo',
       pj ? 2000 * ((i % 5) + 1) : 0, pj ? '28 dias' : 'à vista', pj ? 28 : 0]);
  }
  for (let i = 0; i < 10; i++) {
    const [city, uf] = cities[(i + 2) % cities.length];
    await db.query(
      `insert into suppliers (company_id, legal_name, trade_name, cnpj, city, state, phone, email, payment_terms_days, lead_time_days, freight_type, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DEMONSTRAÇÃO — dado fictício')`,
      [companyId, `Fornecedor ${brands[i]} Ltda (DEMO)`, `${brands[i]} DEMO`, fakeCNPJ(100 + i), city, uf, `11 4${String(0).padStart(1, '0')}00-${1000 + i}`, `compras${i + 1}@demo.local`,
       [28, 30, 45, 60][i % 4], 3 + (i % 8), i % 2 ? 'FOB' : 'CIF']);
  }
  await db.query(`insert into branches (company_id, code, name, city, state) values ($1,'FIL01','Filial Anápolis (DEMO)','Anápolis','GO')`, [companyId]);
});
console.log(`Demo criada. Login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}  (vendedor1@demo.local..vendedor5@demo.local usam a mesma senha)`);
await pool.end();
