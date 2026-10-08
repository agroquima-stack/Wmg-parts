// Devolução e garantias de EXEMPLO (fictícias) para a demonstração.
import { pool, tx } from '../db.js';
import { authForUser } from '../sales.js';
import { createSaleReturn, openClaim, resolveClaim } from '../returns.js';
const co = (await pool.query(`select id from companies where is_demo order by created_at limit 1`)).rows[0];
if (!co) { console.log('Sem empresa demo.'); await pool.end(); process.exit(0); }
const cid = co.id as string;
if ((await pool.query(`select 1 from sale_returns where company_id = $1`, [cid])).rowCount) { console.log('Devoluções demo já existem.'); await pool.end(); process.exit(0); }
const admin = (await pool.query(`select id from users where company_id = $1 and email = 'admin@demo.local'`, [cid])).rows[0];
const items = (await pool.query(`select i.id, i.qty, s.id as sale_id, s.branch_id from sale_items i join sales s on s.id = i.sale_id where s.company_id = $1 and s.status = 'concluida' and s.channel <> 'marketplace' and i.qty >= 1
  and exists (select 1 from stock_balances b where b.product_id = i.product_id and b.branch_id = s.branch_id and b.status = 'disponivel' and b.qty >= 1) order by s.confirmed_at desc limit 3`, [cid])).rows;
if (!admin || items.length < 3) { console.log('Sem vendas elegíveis para criar devoluções de demonstração.'); await pool.end(); process.exit(0); }
{
  const a = await authForUser(pool, admin.id, items[0].branch_id); const as = (k: number) => ({ ...a, branchId: items[k].branch_id as string });
  await tx((db) => createSaleReturn(db, as(0), { sale_id: items[0].sale_id, items: [{ sale_item_id: items[0].id, qty: 1, condition: 'revenda' }], reason: 'Cliente pediu o cancelamento de 1 unidade (DEMO)' }));
  const c1 = await tx((db) => openClaim(db, as(1), { sale_item_id: items[1].id, qty: 1, defect: 'Peça com folga excessiva logo na instalação (DEMO)' }));
  await tx((db) => resolveClaim(db, as(1), c1.id, { resolution: 'troca', note: 'Defeito confirmado; troca imediata (DEMO)' }));
  await tx((db) => openClaim(db, as(2), { sale_item_id: items[2].id, qty: 1, defect: 'Cliente relata ruído após 15 dias de uso (DEMO)' }));
}
console.log('Devoluções e garantias de demonstração criadas (exemplo).'); await pool.end();
