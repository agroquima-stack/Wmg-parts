// Marketplace de EXEMPLO (fictício) para a demonstração: canal, anúncios e alguns pedidos (um já repassado).
import { pool, tx } from '../db.js';
import { authForUser } from '../sales.js';
import { createMarketplaceOrder, receiveMarketplaceOrder } from '../marketplace.js';
const co = (await pool.query(`select id from companies where is_demo order by created_at limit 1`)).rows[0];
if (!co) { console.log('Sem empresa demo.'); await pool.end(); process.exit(0); }
const cid = co.id as string;
if ((await pool.query(`select 1 from marketplaces where company_id = $1`, [cid])).rowCount) { console.log('Marketplace demo já existe.'); await pool.end(); process.exit(0); }
const admin = (await pool.query(`select id from users where company_id = $1 and email = 'admin@demo.local'`, [cid])).rows[0];
const branch = (await pool.query(`select id from branches where company_id = $1 order by created_at limit 1`, [cid])).rows[0];
const bank = (await pool.query(`select id from bank_accounts where company_id = $1 and kind = 'banco' and active order by created_at limit 1`, [cid])).rows[0];
const mk = (await pool.query(`insert into marketplaces (company_id, name, commission_pct, fixed_fee, shipping_cost, payout_days, notes) values ($1,'Marketplace Exemplo (DEMO)',16,6,12,14,'Canal fictício de demonstração') returning id`, [cid])).rows[0].id;
const prods = (await pool.query(`select p.id, p.sale_price from products p where p.company_id = $1 and p.active and p.sale_price > 0 and exists (select 1 from stock_balances b where b.product_id = p.id and b.status = 'disponivel' and b.qty >= 10 and b.branch_id = $2) order by p.sale_price desc limit 8`, [cid, branch?.id])).rows;
for (const p of prods) await pool.query(`insert into marketplace_listings (company_id, marketplace_id, product_id, price, stock_buffer, external_sku) values ($1,$2,$3,$4,3,$5)`, [cid, mk, p.id, (Number(p.sale_price) * 1.2).toFixed(2), 'DEMO-' + p.id.slice(0, 6)]);
if (admin && branch && prods.length >= 3) {
  const a = await authForUser(pool, admin.id, branch.id);
  const orders: { id: string }[] = [];
  for (const [i, p] of prods.slice(0, 3).entries()) orders.push(await tx((db) => createMarketplaceOrder(db, a, { marketplace_id: mk, branch_id: branch.id, external_order_id: `DEMO-MKT-${1001 + i}`, buyer: `Comprador demo ${i + 1}`, items: [{ product_id: p.id, qty: i + 1 }] })));
  if (bank) await tx((db) => receiveMarketplaceOrder(db, a, orders[0].id, { account_id: bank.id }));
}
console.log('Marketplace de demonstração criado (exemplo).'); await pool.end();
