// Estoque de DEMONSTRAÇÃO para a empresa demo (entradas/saídas via serviço real + datas retroativas só aqui).
import { pool, tx } from '../db.js';
import { applyMovement } from '../stock.js';
import type { Auth } from '../auth.js';

const co = (await pool.query(`select id from companies where is_demo order by created_at limit 1`)).rows[0];
if (!co) { console.log('Sem empresa demo.'); await pool.end(); process.exit(0); }
const has = await pool.query('select 1 from stock_movements where company_id = $1 limit 1', [co.id]);
if (has.rowCount) { console.log('Estoque demo já existe.'); await pool.end(); process.exit(0); }

await tx(async (db) => {
  const u = (await db.query(`select id, name from users where company_id = $1 order by created_at limit 1`, [co.id])).rows[0];
  const branches = (await db.query('select id from branches where company_id = $1 order by is_headquarters desc', [co.id])).rows;
  const products = (await db.query('select id, cost_current, min_stock, max_stock from products where company_id = $1 order by sku', [co.id])).rows;
  const a: Auth = { userId: u.id, userName: u.name, companyId: co.id, branchId: branches[0].id, roleName: 'administrador', permissions: new Set(), sessionId: '', ip: '', mustChangePassword: false };
  const demo = { documentType: 'DEMO', documentRef: 'DEMONSTRAÇÃO', reason: 'DEMONSTRAÇÃO — estoque fictício' };
  for (const [i, p] of products.entries()) {
    const min = Number(p.min_stock), max = Number(p.max_stock);
    const qty = [0, Math.max(1, Math.floor(min / 2)), min * 2, min * 3, max + min, min * 2][i % 6];   // zerado, abaixo do mínimo, normal, excesso
    if (qty > 0) await applyMovement(db, a, { ...demo, branchId: branches[0].id, productId: p.id, type: 'entrada', qty, from: null, to: 'disponivel', unitCost: Number(p.cost_current), updateCost: true });
    if (branches[1] && i % 3 === 0) await applyMovement(db, a, { ...demo, branchId: branches[1].id, productId: p.id, type: 'entrada', qty: min, from: null, to: 'disponivel', unitCost: Number(p.cost_current), updateCost: true });
    if (qty > 4 && i % 2 === 0) await applyMovement(db, a, { ...demo, branchId: branches[0].id, productId: p.id, type: 'saida', qty: Math.floor(qty / 4), from: 'disponivel', to: null });
  }
  // datas retroativas para exercitar a análise de produtos parados (trigger de imutabilidade desligado só na demo)
  await db.query('alter table stock_movements disable trigger stock_movements_no_change');
  const days = [10, 40, 75, 130, 250, 420];
  for (const [i, p] of products.entries())
    await db.query(`update stock_movements set created_at = now() - ($3 || ' days')::interval where company_id = $1 and product_id = $2`, [co.id, p.id, String(days[i % 6])]);
  await db.query('alter table stock_movements enable trigger stock_movements_no_change');
});
console.log('Estoque de demonstração criado.');
await pool.end();
