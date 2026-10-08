import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { can, HttpError } from '../auth.js';
import { audit } from '../audit.js';
import { assertRefs, pageParams, registerCrud } from '../crud.js';
import { acquisitionCost, getPricingParams, priceForMargin, resolvePrice, simulate } from '../pricing.js';
import { reqText } from '../schemas.js';

const pct = z.coerce.number().min(0).max(99);
const settingsSchema = z.object({ freight_pct: pct, insurance_pct: pct, accessory_pct: pct, tax_pct: pct, commission_pct: pct, card_fee_pct: pct, variable_expenses_pct: pct });
const KINDS = ['varejo', 'oficina', 'atacado', 'revenda', 'especial', 'marketplace', 'promocao'] as const;

export async function pricingRoutes(app: FastifyInstance) {
  registerCrud(app, {
    path: '/price-tables', table: 'price_tables', entity: 'price_table', perm: 'pricing',
    schema: z.object({ name: reqText(40), kind: z.enum(KINDS), valid_from: z.string().date().nullish().transform((v) => v || null),
      valid_to: z.string().date().nullish().transform((v) => v || null), active: z.boolean().optional() }),
    searchCols: ['name'], orderBy: 't.name', hasActive: true,
  });

  // ---- Regras de preço (por produto, categoria, marca, cliente, quantidade, canal)
  const ruleSchema = z.object({
    table_id: z.string().uuid(), scope: z.enum(['all', 'category', 'brand', 'product']), scope_id: z.string().uuid().nullish().transform((v) => v ?? null),
    customer_id: z.string().uuid().nullish().transform((v) => v ?? null), channel: z.string().trim().max(30).nullish().transform((v) => v || null),
    min_qty: z.coerce.number().positive().default(1), fixed_price: z.coerce.number().min(0).nullish().transform((v) => v ?? null),
    adjust_pct: z.coerce.number().min(-99).max(1000).nullish().transform((v) => v ?? null), active: z.boolean().optional(),
  }).refine((v) => v.fixed_price != null || v.adjust_pct != null, 'Informe preço fixo ou ajuste %')
    .refine((v) => (v.scope === 'all') === (v.scope_id == null), 'Escopo e referência inconsistentes');
  const scopeTable = { category: 'categories', brand: 'brands', product: 'products' } as const;

  app.get('/price-rules', async (req) => {
    const a = can(req, 'pricing:view');
    const qs = req.query as Record<string, string>; const { page, pageSize, offset } = pageParams(qs);
    const params: unknown[] = [a.companyId]; let w = 'r.company_id = $1';
    if (qs.table_id) { params.push(qs.table_id); w += ` and r.table_id = $${params.length}`; }
    const r = await pool.query(
      `select r.*, t.name as table_name, c.legal_name as customer_name,
         case r.scope when 'product' then (select sku || ' — ' || description from products where id = r.scope_id)
                      when 'brand' then (select name from brands where id = r.scope_id)
                      when 'category' then (select name from categories where id = r.scope_id) end as scope_name
         from price_rules r join price_tables t on t.id = r.table_id left join customers c on c.id = r.customer_id
        where ${w} order by t.name, r.scope, r.min_qty limit ${pageSize} offset ${offset}`, params);
    return { items: r.rows, page, pageSize };
  });
  app.post('/price-rules', async (req, reply) => {
    const a = can(req, 'pricing:create');
    const d = ruleSchema.parse(req.body);
    const row = await tx(async (db) => {
      await assertRefs(db, a.companyId, d, { table_id: 'price_tables', customer_id: 'customers' });
      if (d.scope !== 'all') await assertRefs(db, a.companyId, d, { scope_id: scopeTable[d.scope] });
      const r = (await db.query(
        `insert into price_rules (company_id, table_id, scope, scope_id, customer_id, channel, min_qty, fixed_price, adjust_pct) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [a.companyId, d.table_id, d.scope, d.scope_id, d.customer_id, d.channel, d.min_qty, d.fixed_price, d.adjust_pct])).rows[0];
      await audit(db, a, 'price_rule', r.id, 'create', null, r);
      return r;
    });
    return reply.code(201).send(row);
  });
  app.delete('/price-rules/:id', async (req) => {
    const a = can(req, 'pricing:delete');
    const id = (req.params as { id: string }).id;
    return tx(async (db) => {
      const r = await db.query('delete from price_rules where id = $1 and company_id = $2 returning *', [id, a.companyId]);
      if (!r.rowCount) throw new HttpError(404, 'Regra não encontrada.');
      await audit(db, a, 'price_rule', id, 'delete', r.rows[0], null);
      return { deleted: true };
    });
  });

  app.get('/pricing/resolve', async (req) => {
    const a = can(req, 'pricing:view');
    const q = z.object({ product_id: z.string().uuid(), customer_id: z.string().uuid().optional(), qty: z.coerce.number().positive().default(1), channel: z.string().optional() }).parse(req.query);
    return resolvePrice(pool, a.companyId, q.product_id, { customerId: q.customer_id, qty: q.qty, channel: q.channel });
  });

  // ---- Parâmetros do motor de preço e meta mensal
  app.get('/pricing/settings', async (req) => {
    const a = can(req, 'pricing:view');
    const goal = (await pool.query(`select value from company_settings where company_id = $1 and key = 'goal'`, [a.companyId])).rows[0]?.value ?? { monthly: 0 };
    return { params: await getPricingParams(pool, a.companyId), goal };
  });
  app.put('/pricing/settings', async (req) => {
    const a = can(req, 'pricing:edit');
    const body = z.object({ params: settingsSchema.optional(), monthly_goal: z.coerce.number().min(0).optional() }).parse(req.body);
    return tx(async (db) => {
      if (body.params) {
        const before = await getPricingParams(db, a.companyId);
        await db.query(`insert into company_settings (company_id, key, value) values ($1,'pricing',$2) on conflict (company_id, key) do update set value = $2, updated_at = now()`, [a.companyId, JSON.stringify(body.params)]);
        await audit(db, a, 'settings', 'pricing', 'update', before, body.params);
      }
      if (body.monthly_goal != null) {
        await db.query(`insert into company_settings (company_id, key, value) values ($1,'goal',$2) on conflict (company_id, key) do update set value = $2, updated_at = now()`, [a.companyId, JSON.stringify({ monthly: body.monthly_goal })]);
        await audit(db, a, 'settings', 'goal', 'update', null, { monthly: body.monthly_goal });
      }
      return { ok: true };
    });
  });

  // ---- Simulador: preço → margem, e margem → preço
  app.post('/pricing/simulate', async (req) => {
    const a = can(req, 'pricing:view');
    const b = z.object({ product_id: z.string().uuid().optional(), cost: z.coerce.number().min(0).optional(), price: z.coerce.number().min(0),
      margin_pct: z.coerce.number().min(0).max(99).optional(), min_margin_pct: z.coerce.number().min(0).max(99).optional(),
      params: settingsSchema.partial().optional(), freight: z.coerce.number().min(0).optional(), insurance: z.coerce.number().min(0).optional(), accessory: z.coerce.number().min(0).optional() }).parse(req.body);
    let cost = b.cost; let margin = b.margin_pct, minMargin = b.min_margin_pct;
    if (b.product_id) {
      const p = (await pool.query('select cost_avg, cost_current, target_margin_pct, min_margin_pct from products where id = $1 and company_id = $2', [b.product_id, a.companyId])).rows[0];
      if (!p) throw new HttpError(404, 'Produto não encontrado.');
      cost = cost ?? (Number(p.cost_avg) > 0 ? Number(p.cost_avg) : Number(p.cost_current));
      margin = margin ?? Number(p.target_margin_pct); minMargin = minMargin ?? Number(p.min_margin_pct);
    }
    if (cost == null) throw new HttpError(422, 'Informe produto ou custo.');
    const params = { ...(await getPricingParams(pool, a.companyId)), ...(b.params ?? {}) };
    return { cost, params, ...simulate(cost, b.price, params, { margin_pct: margin, min_margin_pct: minMargin, freight: b.freight, insurance: b.insurance, accessory: b.accessory }) };
  });

  // ---- Sugestão de preço por produto (usa custo médio global + parâmetros + margens do cadastro)
  app.get('/pricing/products', async (req) => {
    const a = can(req, 'pricing:view');
    const qs = req.query as Record<string, string>; const { page, pageSize, offset } = pageParams(qs);
    const params: unknown[] = [a.companyId]; let w = 'p.company_id = $1 and p.active';
    if (qs.q?.trim()) { params.push(`%${qs.q.trim()}%`); w += ` and (unaccent(p.description) ilike unaccent($2) or p.sku ilike $2)`; }
    const [rows, total, pr] = await Promise.all([
      pool.query(`select p.id, p.sku, p.description, p.cost_avg, p.cost_current, p.sale_price, p.min_price, p.min_margin_pct, p.target_margin_pct from products p where ${w} order by p.description limit ${pageSize} offset ${offset}`, params),
      pool.query(`select count(*)::int n from products p where ${w}`, params), getPricingParams(pool, a.companyId)]);
    const items = rows.rows.map((p) => {
      const cost = Number(p.cost_avg) > 0 ? Number(p.cost_avg) : Number(p.cost_current);
      const acq = acquisitionCost(cost, pr);
      const cur = simulate(cost, Number(p.sale_price), pr);
      return { ...p, cost_basis: cost, acquisition_cost: cur.acquisition_cost, real_cost: cur.real_cost, current_margin_pct: cur.margin_pct, markup_pct: cur.markup_pct,
        suggested_price: priceForMargin(acq, pr, Number(p.target_margin_pct)), computed_min_price: priceForMargin(acq, pr, Number(p.min_margin_pct)) };
    });
    return { items, total: total.rows[0].n, page, pageSize, params_configured: pr.configured };
  });

  app.post('/pricing/apply', async (req) => {
    const a = can(req, 'pricing:approve');
    const { product_ids } = z.object({ product_ids: z.array(z.string().uuid()).min(1).max(500) }).parse(req.body);
    return tx(async (db) => {
      const pr = await getPricingParams(db, a.companyId); let changed = 0;
      for (const id of product_ids) {
        const p = (await db.query('select * from products where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
        if (!p) continue;
        const cost = Number(p.cost_avg) > 0 ? Number(p.cost_avg) : Number(p.cost_current);
        const acq = acquisitionCost(cost, pr);
        const price = priceForMargin(acq, pr, Number(p.target_margin_pct)), min = priceForMargin(acq, pr, Number(p.min_margin_pct));
        if (price == null || min == null || cost <= 0) continue;
        if (Number(p.sale_price) === price && Number(p.min_price) === min) continue;
        await db.query('update products set sale_price = $2, min_price = $3, updated_at = now() where id = $1', [id, price, min]);
        await audit(db, a, 'product', id, 'sale_price_change', { sale_price: p.sale_price, min_price: p.min_price }, { sale_price: price, min_price: min, source: 'motor de precificação' });
        changed++;
      }
      return { changed };
    });
  });
}
