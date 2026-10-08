// Dados fiscais de DEMONSTRAÇÃO: emitente, endereços de clientes (fictícios) e rascunhos de nota das vendas concluídas.
import { pool, tx } from '../db.js';
import { authForUser } from '../sales.js';
import { createDraft } from '../routes/fiscal.js';

const co = (await pool.query(`select id, cnpj from companies where is_demo order by created_at limit 1`)).rows[0];
if (!co) { console.log('Sem empresa demo.'); await pool.end(); process.exit(0); }
const cid = co.id as string;
if ((await pool.query('select 1 from fiscal_documents where company_id = $1 limit 1', [cid])).rowCount) { console.log('Fiscal demo já existe.'); await pool.end(); process.exit(0); }

// CNPJ fictício válido para o emitente da demo (11.222.333/0001-81) e IE fictícia
await pool.query(`update branches set cnpj = '11222333000181', ie = '102345678', crt = 1, street = 'Av. Demonstração', number = '1000', district = 'Setor Central', city = 'Goiânia', state = 'GO', zip = '74000000', city_ibge = '5208707', phone = '6232000000' where company_id = $1 and is_headquarters`, [cid]);
await pool.query(`update companies set cnpj = '11222333000181' where id = $1 and cnpj is null`, [cid]);
const custs = (await pool.query(`select id, city, state from customers where company_id = $1`, [cid])).rows;
for (const [i, c] of custs.entries())
  await pool.query(`update customers set street = $2, number = $3, district = $4, zip = $5, ie = case when type = 'PJ' then $6 else ie end where id = $1`, [c.id, `Rua Demonstração ${i + 1}`, String(10 + i), 'Centro', c.state === 'GO' ? '74000000' : c.state === 'DF' ? '70000000' : '38400000', String(100000000 + i * 7919)]);
await pool.query(`insert into company_settings (company_id, key, value) values ($1,'fiscal',$2) on conflict (company_id, key) do update set value = $2`, [cid, JSON.stringify({ provider: 'manual', environment: 'homologacao', series_nfe: 1, series_nfce: 1, use_nfce_for_counter: false, cancel_window_hours: 24, das_mode: 'manual', das_effective_pct: 6, rbt12_override: null, ibs_cbs_enabled: false })]);

const admin = (await pool.query('select id from users where company_id = $1 order by created_at limit 1', [cid])).rows[0].id; const branch = (await pool.query('select id from branches where company_id = $1 and is_headquarters', [cid])).rows[0].id;
const sales = (await pool.query(`select id from sales where company_id = $1 and status = 'concluida' order by confirmed_at limit 12`, [cid])).rows; let ok = 0, bad = 0;
for (const s of sales) { const d = await tx(async (db) => createDraft(db, await authForUser(db, admin, branch), s.id)).catch(() => null); if (d) d.validation.errors.length ? bad++ : ok++; }
console.log(`Fiscal de demonstração: emitente e endereços preenchidos; ${ok} rascunhos prontos e ${bad} com pendências.`);
await pool.end();
