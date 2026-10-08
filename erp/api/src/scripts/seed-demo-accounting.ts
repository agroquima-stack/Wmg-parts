// Razão contábil da DEMONSTRAÇÃO: complementa com os lançamentos de dados criados diretamente por SQL nos seeds (idempotente).
import { pool, tx } from '../db.js';
import { syncLedger } from '../accounting.js';
const co = (await pool.query(`select id from companies where is_demo order by created_at limit 1`)).rows[0];
if (!co) { console.log('Sem empresa demo.'); await pool.end(); process.exit(0); }
const r = await tx((db) => syncLedger(db, co.id));
console.log(`Contabilidade de demonstração: ${r.created} lançamento(s) complementar(es) gerado(s) pela sincronização.`);
await pool.end();
