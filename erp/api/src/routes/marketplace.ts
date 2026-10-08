import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { can, HttpError } from '../auth.js';
import { audit } from '../audit.js';
import { assertRefs, registerCrud } from '../crud.js';
import { cancelSale } from '../sales.js';
import { createMarketplaceOrder, economics, loadMk, marketplaceSummary, receiveMarketplaceOrder } from '../marketplace.js';

const uuid = z.string().uuid(); const date = z.string().date(); const money = z.coerce.number().min(0).max(1e9);
const mkSchema = z.object({
  name: z.string().trim().min(2).max(80), commission_pct: z.coerce.number().min(0).lt(100).default(0), fixed_fee: money.default(0), shipping_cost: money.default(0),
  payout_days: z.coerce.number().int().min(0).max(120).default(14), notes: z.string().trim().max(500).nullish().transform((v) => v || null), active: z.boolean().default(true),
});

export async function marketplaceRoutes(app: FastifyInstance) {
  registerCrud(app, { path: '/marketplaces', table: 'marketplaces', entity: 'marketplace', perm: 'marketplace', schema: mkSchema, searchCols: ['name'], orderBy: 't.name', hasActive: true });

  // ---- Anúncios: preço por marketplace, com margem real e quantidade publicável
  app.get('/marketplaces/:id/listings', async (req) => {
    const a = can(req, 'marketplace:view'); const id = (req.params as { id: string }).id; const mk = await loadMk(pool, a.companyId, id);
    const rows = (await pool.query(`select l.*, p.sku, p.description, coalesce((select sum(qty) from stock_balances b where b.product_id = p.id and b.status = 'disponivel'),0) as available
      from marketplace_listings l join products p on p.id = l.product_id where l.marketplace_id = $1 and l.company_id = $2 order by p.sku limit 500`, [id, a.companyId])).rows;
    const items = [];
    for (const l of rows) { const e = await economics(pool, a.companyId, mk, l.product_id, Number(l.price)); items.push({ id: l.id, product_id: l.product_id, sku: l.sku, description: l.description, external_sku: l.external_sku, price: Number(l.price), active: l.active, stock_buffer: Number(l.stock_buffer), available: Number(l.available),
      publish_qty: Math.max(0, Number(l.available) - Number(l.stock_buffer)), margin: e.margin, margin_pct: e.margin_pct, below_min: e.below_min, losing_money: e.losing_money, price_for_target_margin: e.price_for_target_margin }); }
    return { marketplace: { id: mk.id, name: mk.name, commission_pct: mk.commission_pct, fixed_fee: mk.fixed_fee, shipping_cost: mk.shipping_cost }, items };
  });
  app.get('/marketplaces/:id/economics', async (req) => {
    const a = can(req, 'marketplace:view'); const id = (req.params as { id: string }).id; const q = z.object({ product_id: uuid, price: z.coerce.number().positive() }).parse(req.query);
    return economics(pool, a.companyId, await loadMk(pool, a.companyId, id), q.product_id, q.price);
  });
  app.put('/marketplaces/:id/listings', async (req) => {
    const a = can(req, 'marketplace:edit'); const id = (req.params as { id: string }).id; await loadMk(pool, a.companyId, id);
    const b = z.object({ product_id: uuid, price: z.coerce.number().positive().max(1e8), external_sku: z.string().trim().max(60).nullish().transform((v) => v || null), stock_buffer: z.coerce.number().min(0).max(1e9).default(0), active: z.boolean().default(true) }).parse(req.body);
    await assertRefs(pool, a.companyId, { product_id: b.product_id }, { product_id: 'products' });
    const r = await pool.query(`insert into marketplace_listings (company_id, marketplace_id, product_id, external_sku, price, stock_buffer, active) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (marketplace_id, product_id) do update set external_sku = excluded.external_sku, price = excluded.price, stock_buffer = excluded.stock_buffer, active = excluded.active, updated_at = now() returning *`,
      [a.companyId, id, b.product_id, b.external_sku, b.price, b.stock_buffer, b.active]);
    await audit(pool, a, 'marketplace_listing', r.rows[0].id, 'upsert', null, b); return r.rows[0];
  });
  app.delete('/marketplaces/:id/listings/:productId', async (req) => {
    const a = can(req, 'marketplace:delete'); const p = req.params as { id: string; productId: string };
    const r = await pool.query('delete from marketplace_listings where marketplace_id = $1 and product_id = $2 and company_id = $3 returning id', [p.id, p.productId, a.companyId]); if (!r.rowCount) throw new HttpError(404, 'Anúncio não encontrado.');
    await audit(pool, a, 'marketplace_listing', r.rows[0].id, 'delete'); return { deleted: true };
  });
  /** Planilha para subir no painel do marketplace (a publicação em si é manual enquanto não houver integração). */
  app.get('/marketplaces/:id/listings/export', async (req, reply) => {
    const a = can(req, 'marketplace:view'); const id = (req.params as { id: string }).id; await loadMk(pool, a.companyId, id);
    const rows = (await pool.query(`select p.sku, l.external_sku, p.description, l.price, greatest(0, coalesce((select sum(qty) from stock_balances b where b.product_id = p.id and b.status = 'disponivel'),0) - l.stock_buffer) as qty
      from marketplace_listings l join products p on p.id = l.product_id where l.marketplace_id = $1 and l.company_id = $2 and l.active order by p.sku`, [id, a.companyId])).rows;
    const cell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const csv = ['sku;sku_marketplace;descricao;preco;quantidade', ...rows.map((r) => [r.sku, r.external_sku ?? '', r.description, Number(r.price).toFixed(2).replace('.', ','), Number(r.qty)].map(cell).join(';'))].join('\r\n');
    await audit(pool, a, 'marketplace', id, 'export_listings', null, { rows: rows.length });
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="anuncios.csv"').send('﻿' + csv);
  });

  // ---- Pedidos do marketplace
  app.get('/marketplace-orders', async (req) => {
    const a = can(req, 'marketplace:view'); const q = z.object({ marketplace_id: uuid.optional(), status: z.enum(['a_receber', 'recebido', 'cancelado']).optional(), late: z.coerce.boolean().optional() }).parse(req.query);
    const w = ['o.company_id = $1']; const p: unknown[] = [a.companyId];
    if (q.marketplace_id) { p.push(q.marketplace_id); w.push(`o.marketplace_id = $${p.length}`); } if (q.status) { p.push(q.status); w.push(`o.status = $${p.length}`); } if (q.late) w.push(`o.status = 'a_receber' and o.payout_date < current_date`);
    const items = (await pool.query(`select o.*, o.payout_date::text as payout_txt, m.name as marketplace_name, s.number as sale_number, s.status as sale_status, (o.status = 'a_receber' and o.payout_date < current_date) as late
      from marketplace_orders o join marketplaces m on m.id = o.marketplace_id join sales s on s.id = o.sale_id where ${w.join(' and ')} order by o.created_at desc limit 300`, p)).rows.map(({ payout_date, ...x }) => ({ ...x, payout_date: x.payout_txt, payout_txt: undefined }));
    return { items };
  });
  app.post('/marketplace-orders', async (req, reply) => {
    const a = can(req, 'marketplace:create'); can(req, 'sales:create');
    const b = z.object({ marketplace_id: uuid, external_order_id: z.string().trim().min(1).max(80), branch_id: uuid.optional(), buyer: z.string().trim().max(120).nullish().transform((v) => v || null), sold_at: date.optional(),
      shipping_cost: money.optional(), commission: money.optional(), fixed_fee: money.optional(),
      items: z.array(z.object({ product_id: uuid, qty: z.coerce.number().positive().max(1e6), unit_price: z.coerce.number().positive().max(1e8).optional() })).min(1).max(100) }).parse(req.body);
    const out = await tx((db) => createMarketplaceOrder(db, a, { ...b, branch_id: b.branch_id ?? a.branchId! }));
    return reply.code(201).send(out);
  });
  app.post('/marketplace-orders/:id/receive', async (req) => {
    const a = can(req, 'finance:edit'); can(req, 'marketplace:edit'); const id = (req.params as { id: string }).id;
    const b = z.object({ account_id: uuid, date: date.optional(), commission: money.optional(), fixed_fee: money.optional(), shipping_cost: money.optional() }).parse(req.body);
    return tx((db) => receiveMarketplaceOrder(db, a, id, b));
  });
  app.post('/marketplace-orders/:id/cancel', async (req) => {
    const a = can(req, 'marketplace:approve'); can(req, 'sales:approve'); const id = (req.params as { id: string }).id; const { reason } = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
    return tx(async (db) => {
      const o = (await db.query('select * from marketplace_orders where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0]; if (!o) throw new HttpError(404, 'Pedido não encontrado.');
      if (o.status !== 'a_receber') throw new HttpError(409, o.status === 'recebido' ? 'Pedido já recebido: trate como devolução/estorno manual.' : 'Pedido já cancelado.');
      await cancelSale(db, a, o.sale_id, reason); await db.query(`update marketplace_orders set status = 'cancelado' where id = $1`, [id]);
      await audit(db, a, 'marketplace_order', id, 'cancel', { status: 'a_receber' }, { status: 'cancelado', reason }); return { id, status: 'cancelado' };
    });
  });
  app.get('/marketplaces/:id/summary', async (req) => {
    const a = can(req, 'marketplace:view'); const id = (req.params as { id: string }).id; await loadMk(pool, a.companyId, id);
    const q = z.object({ from: date.default(new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)), to: date.default(new Date().toISOString().slice(0, 10)) }).parse(req.query);
    return { from: q.from, to: q.to, ...(await marketplaceSummary(pool, a.companyId, id, q.from, q.to)) };
  });
}
