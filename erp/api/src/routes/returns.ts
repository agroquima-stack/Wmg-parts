import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { can, HttpError } from '../auth.js';
import { audit } from '../audit.js';
import { createSaleReturn, openClaim, resolveClaim, returnable, supplierOutcome, warrantyDefault } from '../returns.js';

const uuid = z.string().uuid();

export async function returnsRoutes(app: FastifyInstance) {
  // ---- Devoluções de venda
  app.get('/sales/:id/returnable', async (req) => {
    const a = can(req, 'returns:view'); const id = (req.params as { id: string }).id;
    const s = (await pool.query(`select s.id, s.number, s.status, s.total, c.legal_name as customer_name from sales s left join customers c on c.id = s.customer_id where s.id = $1 and s.company_id = $2`, [id, a.companyId])).rows[0]; if (!s) throw new HttpError(404, 'Venda não encontrada.');
    return { sale: s, items: await returnable(pool, a.companyId, id) };
  });
  app.post('/sale-returns', async (req, reply) => {
    const a = can(req, 'returns:approve'); can(req, 'returns:create');
    const b = z.object({ sale_id: uuid, reason: z.string().trim().min(3).max(300), notes: z.string().trim().max(500).nullish().transform((v) => v || null),
      items: z.array(z.object({ sale_item_id: uuid, qty: z.coerce.number().positive().max(1e6), condition: z.enum(['revenda', 'avariado']).default('revenda') })).min(1).max(200) }).parse(req.body);
    return reply.code(201).send(await tx((db) => createSaleReturn(db, a, b)));
  });
  app.get('/sale-returns', async (req) => {
    const a = can(req, 'returns:view'); const q = z.object({ q: z.string().optional(), sale_id: uuid.optional() }).parse(req.query); const p: unknown[] = [a.companyId]; let w = 'r.company_id = $1';
    if (q.sale_id) { p.push(q.sale_id); w += ` and r.sale_id = $${p.length}`; } if (q.q) { p.push(`%${q.q}%`); w += ` and (cast(r.number as text) like $${p.length} or cast(s.number as text) like $${p.length} or c.legal_name ilike $${p.length})`; }
    const items = (await pool.query(`select r.*, s.number as sale_number, c.legal_name as customer_name, u.name as created_by_name from sale_returns r join sales s on s.id = r.sale_id left join customers c on c.id = r.customer_id join users u on u.id = r.created_by where ${w} order by r.created_at desc limit 200`, p)).rows;
    return { items };
  });
  app.get('/sale-returns/:id', async (req) => {
    const a = can(req, 'returns:view'); const id = (req.params as { id: string }).id;
    const r = (await pool.query(`select r.*, s.number as sale_number, c.legal_name as customer_name from sale_returns r join sales s on s.id = r.sale_id left join customers c on c.id = r.customer_id where r.id = $1 and r.company_id = $2`, [id, a.companyId])).rows[0]; if (!r) throw new HttpError(404, 'Devolução não encontrada.');
    const items = (await pool.query(`select i.*, p.sku, p.description from sale_return_items i join products p on p.id = i.product_id where i.return_id = $1 order by p.sku`, [id])).rows;
    return { ...r, items };
  });

  // ---- Garantias
  app.get('/warranty/settings', async (req) => { const a = can(req, 'returns:view'); return { default_warranty_days: await warrantyDefault(pool, a.companyId) }; });
  app.put('/warranty/settings', async (req) => {
    const a = can(req, 'returns:approve'); const b = z.object({ default_warranty_days: z.coerce.number().int().min(0).max(3650) }).parse(req.body);
    await pool.query(`insert into company_settings (company_id, key, value) values ($1,'returns',$2) on conflict (company_id, key) do update set value = excluded.value`, [a.companyId, JSON.stringify(b)]);
    await audit(pool, a, 'settings', 'returns', 'update', null, b); return b;
  });
  app.post('/warranty', async (req, reply) => {
    const a = can(req, 'returns:create');
    const b = z.object({ sale_item_id: uuid.nullish().transform((v) => v ?? null), product_id: uuid.nullish().transform((v) => v ?? null), customer_id: uuid.nullish().transform((v) => v ?? null), qty: z.coerce.number().positive().max(1e6), defect: z.string().trim().min(5).max(500) }).parse(req.body);
    return reply.code(201).send(await tx((db) => openClaim(db, a, b)));
  });
  app.get('/warranty', async (req) => {
    const a = can(req, 'returns:view'); const q = z.object({ status: z.string().optional(), pending_supplier: z.coerce.boolean().optional() }).parse(req.query); const p: unknown[] = [a.companyId]; let w = 'w.company_id = $1';
    if (q.status) { p.push(q.status); w += ` and w.status = $${p.length}`; } if (q.pending_supplier) w += ' and w.defective_pending > 0';
    const items = (await pool.query(`select w.*, w.purchased_at::text as purchased_txt, pr.sku, pr.description, c.legal_name as customer_name, s.number as sale_number, sp.legal_name as supplier_name
      from warranty_claims w join products pr on pr.id = w.product_id left join customers c on c.id = w.customer_id left join sales s on s.id = w.sale_id left join suppliers sp on sp.id = w.supplier_id where ${w} order by w.created_at desc limit 200`, p)).rows;
    return { items };
  });
  app.post('/warranty/:id/analysis', async (req) => {
    const a = can(req, 'returns:edit'); const id = (req.params as { id: string }).id; const b = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    const r = await pool.query(`update warranty_claims set status = 'em_analise', decision_note = coalesce($3, decision_note) where id = $1 and company_id = $2 and status = 'aberta' returning *`, [id, a.companyId, b.note ?? null]);
    if (!r.rowCount) throw new HttpError(409, 'Solicitação não encontrada ou já em análise.'); await audit(pool, a, 'warranty_claim', id, 'analysis'); return r.rows[0];
  });
  app.post('/warranty/:id/resolve', async (req) => {
    const a = can(req, 'returns:approve'); const id = (req.params as { id: string }).id;
    const b = z.object({ resolution: z.enum(['troca', 'reembolso', 'reparo', 'recusa']), note: z.string().trim().min(3).max(500), goodwill: z.boolean().optional() }).parse(req.body);
    return tx((db) => resolveClaim(db, a, id, b));
  });
  app.post('/warranty/:id/supplier', async (req) => {
    const a = can(req, 'returns:approve'); const id = (req.params as { id: string }).id;
    const b = z.object({ outcome: z.enum(['credito', 'recusado']), supplier_id: uuid.nullish().transform((v) => v ?? null), amount: z.coerce.number().positive().max(1e9).optional() }).parse(req.body);
    return tx((db) => supplierOutcome(db, a, id, b));
  });
}
