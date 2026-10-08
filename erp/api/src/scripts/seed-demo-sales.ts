// Parâmetros de preço, tabelas, vendas, orçamentos e recorrência de DEMONSTRAÇÃO (usa os serviços reais; datas retroativas só aqui).
import { pool, tx } from '../db.js';
import { authForUser, confirmSale, createSale } from '../sales.js';

const co = (await pool.query(`select id from companies where is_demo order by created_at limit 1`)).rows[0];
if (!co) { console.log('Sem empresa demo.'); await pool.end(); process.exit(0); }
if ((await pool.query('select 1 from sales where company_id = $1 limit 1', [co.id])).rowCount) { console.log('Vendas demo já existem.'); await pool.end(); process.exit(0); }

const cid = co.id as string;
await pool.query(`insert into company_settings (company_id, key, value) values ($1,'pricing',$2),($1,'goal',$3) on conflict do nothing`,
  [cid, JSON.stringify({ freight_pct: 2, insurance_pct: 0.5, accessory_pct: 0, tax_pct: 6, commission_pct: 3, card_fee_pct: 2.5, variable_expenses_pct: 2 }), JSON.stringify({ monthly: 40000 })]);
for (const [name, adj, qty] of [['oficina', -8, 1], ['atacado', -15, 10], ['revenda', -20, 5]] as const) {
  const t = (await pool.query('select id from price_tables where company_id = $1 and name = $2', [cid, name])).rows[0];
  await pool.query(`insert into price_rules (company_id, table_id, scope, adjust_pct, min_qty) values ($1,$2,'all',$3,$4)`, [cid, t.id, adj, qty]);
}
const branch = (await pool.query('select id from branches where company_id = $1 order by is_headquarters desc limit 1', [cid])).rows[0].id;
const sellers = (await pool.query(`select id from users where company_id = $1 and is_seller order by email`, [cid])).rows.map((r) => r.id);
const manager = (await pool.query(`select id from users where company_id = $1 order by created_at limit 1`, [cid])).rows[0].id;
const customers = (await pool.query(`select id, type from customers where company_id = $1 and status = 'ativo' order by legal_name`, [cid])).rows;
const products = (await pool.query(`select id from products where company_id = $1 and active and sale_price > 0 order by sku`, [cid])).rows.map((r) => r.id);
const methods = ['pix', 'dinheiro', 'cartao_debito', 'cartao_credito', 'pix', 'cartao_credito'] as const;

let made = 0; const nums: number[] = [];
for (let i = 0; i < 36; i++) {
  const seller = sellers[i % sellers.length]; const cust = customers[i % customers.length]; const pj = cust.type === 'PJ';
  const items = [0, 1, 2].slice(0, 1 + (i % 3)).map((k) => ({ product_id: products[(i * 5 + k * 7) % products.length], qty: 1 + (i % 3), discount_pct: i % 4 === 0 ? 3 : 0 }));
  try {
    await tx(async (db) => {
      const a = await authForUser(db, seller, branch);
      const s = await createSale(db, a, { branchId: branch, customerId: cust.id, type: pj ? 'b2b' : 'balcao', items, sellerId: seller });
      const m = methods[i % methods.length];
      await confirmSale(db, a, s.id, [{ method: pj && i % 2 ? 'boleto' : m, amount: Number(s.total), installments: m === 'cartao_credito' ? 2 : 1 }]);
      nums.push(s.number); made++;
    });
  } catch { /* sem estoque nesse item da demo: ignora */ }
}
// uma venda aguardando aprovação (desconto de 12% > 5%)
await tx(async (db) => {
  const a = await authForUser(db, sellers[0], branch);
  await createSale(db, a, { branchId: branch, customerId: customers[1].id, type: 'b2b', items: [{ product_id: products[3], qty: 2, discount_pct: 12 }], sellerId: sellers[0] });
});
// orçamento enviado e pedido recorrente
await tx(async (db) => {
  const a = await authForUser(db, sellers[1], branch);
  const q = (await db.query(`insert into quotes (company_id, branch_id, number, customer_id, seller_id, status, valid_until, payment_condition, sent_at) values ($1,$2,9001,$3,$4,'enviado', current_date + 5,'28 dias', now()) returning id`, [cid, branch, customers[0].id, sellers[1]])).rows[0];
  const p = (await db.query('select id, sale_price from products where id = $1', [products[0]])).rows[0];
  await db.query('insert into quote_items (quote_id, company_id, product_id, qty, list_price, unit_price, total) values ($1,$2,$3,5,$4,$4,$5)', [q.id, cid, p.id, p.sale_price, Number(p.sale_price) * 5]);
  await db.query('update quotes set subtotal = $2, total = $2 where id = $1', [q.id, Number(p.sale_price) * 5]);
  await db.query(`insert into doc_counters (company_id, kind, last) values ($1,'quote',9001) on conflict (company_id, kind) do update set last = greatest(doc_counters.last, 9001)`, [cid]);
  await db.query(`insert into recurring_orders (company_id, branch_id, customer_id, seller_id, interval_days, next_run, items) values ($1,$2,$3,$4,30,current_date,$5)`,
    [cid, branch, customers[2].id, sellers[2], JSON.stringify([{ product_id: products[6], qty: 4 }, { product_id: products[8], qty: 2 }])]);
  void a; void manager;
});
// distribui as vendas concluídas nos últimos ~60 dias (retroativo só na demo)
await pool.query('alter table stock_movements disable trigger stock_movements_no_change');
for (const [i, n] of nums.entries()) {
  const days = (i * 11) % 58;
  await pool.query(`update sales set confirmed_at = now() - ($3 || ' days')::interval, created_at = now() - ($3 || ' days')::interval where company_id = $1 and number = $2`, [cid, n, String(days)]);
  await pool.query(`update receivables set due_date = due_date - $3::int, created_at = now() - ($3 || ' days')::interval where sale_id = (select id from sales where company_id = $1 and number = $2)`, [cid, n, days]);
  await pool.query(`update stock_movements set created_at = now() - ($3 || ' days')::interval where company_id = $1 and document_type = 'venda' and document_ref = $2`, [cid, String(n), String(days)]);
}
await pool.query('alter table stock_movements enable trigger stock_movements_no_change');
console.log(`Vendas de demonstração: ${made} concluídas, 1 aguardando aprovação, 1 orçamento, 1 pedido recorrente.`);
await pool.end();
