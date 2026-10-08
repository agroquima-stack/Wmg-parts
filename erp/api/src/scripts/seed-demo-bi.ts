// Metas de EXEMPLO para a demonstração (valores fictícios; no ambiente real o gestor define as metas em BI → Metas).
import { pool } from '../db.js';
const co = (await pool.query(`select id from companies where is_demo order by created_at limit 1`)).rows[0];
if (!co) { console.log('Sem empresa demo.'); await pool.end(); process.exit(0); }
const cid = co.id as string; const add = (kind: string, target: number, scope = 'company', scopeId: string | null = null) =>
  pool.query(`insert into goals (company_id, kind, scope_type, scope_id, target) values ($1,$2,$3,$4,$5) on conflict do nothing`, [cid, kind, scope, scopeId, target]);
await add('faturamento', 40000); await add('margem_bruta_pct', 35); await add('ticket_medio', 450); await add('giro_estoque', 4); await add('cobertura_dias_max', 120); await add('inadimplencia_max_pct', 8);
for (const [i, s] of (await pool.query(`select id from users where company_id = $1 and is_seller order by email`, [cid])).rows.entries()) await add('faturamento', 6000 + i * 1000, 'seller', s.id);
console.log('Metas de demonstração criadas (exemplo).'); await pool.end();
