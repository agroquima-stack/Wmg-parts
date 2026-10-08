import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db.js';
import { can, HttpError } from '../auth.js';
import { audit } from '../audit.js';
import { assertRefs, insertRow, pageParams, updateRow } from '../crud.js';
import { productSchema, text } from '../schemas.js';

const refs = { brand_id: 'brands', category_id: 'categories', subcategory_id: 'categories' };
const SENSITIVE = ['sale_price', 'cost_current', 'min_price', 'min_margin_pct'];

const listSql = `
  select t.*, b.name as brand_name, c.name as category_name,
    coalesce((select array_agg(pb.barcode order by pb.barcode) from product_barcodes pb where pb.product_id = t.id), '{}') as barcodes,
    case when t.sale_price > 0 then round((t.sale_price - t.cost_current) / t.sale_price * 100, 2) end as margin_pct
  from products t
  left join brands b on b.id = t.brand_id
  left join categories c on c.id = t.category_id`;

async function setBarcodes(db: Db, companyId: string, productId: string, codes: string[]) {
  const uniq = [...new Set(codes)];
  await db.query('delete from product_barcodes where product_id = $1', [productId]);
  for (const code of uniq) {
    const dup = await db.query('select p.sku from product_barcodes pb join products p on p.id = pb.product_id where pb.company_id = $1 and pb.barcode = $2', [companyId, code]);
    if (dup.rowCount) throw new HttpError(409, `Código de barras ${code} já pertence ao produto ${dup.rows[0].sku}.`);
    await db.query('insert into product_barcodes (company_id, product_id, barcode) values ($1,$2,$3)', [companyId, productId, code]);
  }
}

function checkPricing(r: Record<string, unknown>) {
  if (Number(r.min_price) > Number(r.sale_price) && Number(r.sale_price) > 0) return 'Preço mínimo não pode superar o preço de venda.';
  if (Number(r.max_stock) && Number(r.min_stock) > Number(r.max_stock)) return 'Estoque mínimo maior que o máximo.';
  return null;
}

export async function productRoutes(app: FastifyInstance) {
  app.get('/products', async (req) => {
    const a = can(req, 'products:view');
    const qs = req.query as Record<string, string>;
    const { page, pageSize, offset } = pageParams(qs);
    const where = ['t.company_id = $1']; const params: unknown[] = [a.companyId];
    if (qs.q?.trim()) {
      params.push(`%${qs.q.trim()}%`); const i = params.length;
      where.push(`(unaccent(t.description) ilike unaccent($${i}) or t.sku ilike $${i} or t.internal_code ilike $${i}
        or t.manufacturer_code ilike $${i} or t.original_code ilike $${i}
        or exists (select 1 from product_barcodes pb where pb.product_id = t.id and pb.barcode = $${i + 1}))`);
      params.push(qs.q.trim());
    }
    for (const f of ['brand_id', 'category_id']) if (qs[f]) { params.push(qs[f]); where.push(`t.${f} = $${params.length}`); }
    if (qs.active) { params.push(qs.active === 'true'); where.push(`t.active = $${params.length}`); }
    const w = where.join(' and ');
    const [items, total] = await Promise.all([
      pool.query(`${listSql} where ${w} order by t.description limit ${pageSize} offset ${offset}`, params),
      pool.query(`select count(*)::int n from products t where ${w}`, params),
    ]);
    return { items: items.rows, total: total.rows[0].n, page, pageSize };
  });

  app.get('/products/:id', async (req) => {
    const a = can(req, 'products:view');
    const id = (req.params as { id: string }).id;
    const p = (await pool.query(`${listSql} where t.id = $1 and t.company_id = $2`, [id, a.companyId])).rows[0];
    if (!p) throw new HttpError(404, 'Produto não encontrado.');
    const applications = (await pool.query(
      `select pa.*, vm.make, vm.model, vm.version, coalesce(pa.year_from, vm.year_from) as eff_year_from, coalesce(pa.year_to, vm.year_to) as eff_year_to
         from product_applications pa join vehicle_models vm on vm.id = pa.vehicle_model_id
        where pa.product_id = $1 and pa.company_id = $2 order by vm.make, vm.model`, [id, a.companyId])).rows;
    const equivalents = await equivalentsOf(id, a.companyId);
    return { ...p, applications, equivalents };
  });

  app.post('/products', async (req, reply) => {
    const a = can(req, 'products:create');
    const { barcodes, ...data } = productSchema.parse(req.body);
    const bad = checkPricing(data); if (bad) throw new HttpError(422, bad);
    const row = await tx(async (db) => {
      await assertRefs(db, a.companyId, data, refs);
      // custo inicial alimenta custo médio/último até o módulo de compras assumir
      const r = await insertRow(db, 'products', a.companyId, {
        ...data, created_by: a.userId, cost_avg: data.cost_current ?? 0, cost_last: data.cost_current ?? 0 });
      if (barcodes?.length) await setBarcodes(db, a.companyId, String(r.id), barcodes);
      await audit(db, a, 'product', String(r.id), 'create', null, { ...r, barcodes });
      return r;
    });
    return reply.code(201).send(row);
  });

  app.patch('/products/:id', async (req) => {
    const a = can(req, 'products:edit');
    const id = (req.params as { id: string }).id;
    const { barcodes, ...data } = productSchema.partial().parse(req.body);
    return tx(async (db) => {
      const before = (await db.query('select * from products where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
      if (!before) throw new HttpError(404, 'Produto não encontrado.');
      const bad = checkPricing({ ...before, ...data }); if (bad) throw new HttpError(422, bad);
      await assertRefs(db, a.companyId, data, refs);
      const patch = { ...data, updated_at: new Date() };
      const after = await updateRow(db, 'products', a.companyId, id, patch);
      if (barcodes) await setBarcodes(db, a.companyId, id, barcodes);
      await audit(db, a, 'product', id, 'update', before, after);
      // alterações de preço/custo geram trilha específica (item 45 do escopo)
      const changed = SENSITIVE.filter((k) => data[k as keyof typeof data] !== undefined && Number(before[k]) !== Number(after?.[k]));
      for (const k of changed) await audit(db, a, 'product', id, `${k}_change`, { [k]: before[k] }, { [k]: after?.[k] });
      return after;
    });
  });

  app.delete('/products/:id', async (req) => {
    const a = can(req, 'products:delete');
    const id = (req.params as { id: string }).id;
    return tx(async (db) => {
      const before = (await db.query('select * from products where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
      if (!before) throw new HttpError(404, 'Produto não encontrado.');
      try {
        await db.query('savepoint del');
        await db.query('delete from products where id = $1', [id]);
        await audit(db, a, 'product', id, 'delete', before, null);
        return { deleted: true };
      } catch (e) {
        if ((e as { code?: string }).code !== '23503') throw e;
        await db.query('rollback to savepoint del');
        await db.query('update products set active = false, updated_at = now() where id = $1', [id]);
        await audit(db, a, 'product', id, 'deactivate', before, { active: false });
        return { deleted: false, deactivated: true, message: 'Produto com movimentação: foi inativado.' };
      }
    });
  });

  // --- Aplicações (moto) ---
  const appSchema = z.object({
    vehicle_model_id: z.string().uuid(), system: text(80), position: text(60),
    year_from: z.coerce.number().int().min(1950).max(2100).nullish().transform((v) => v ?? null),
    year_to: z.coerce.number().int().min(1950).max(2100).nullish().transform((v) => v ?? null), notes: text(500),
  });
  app.post('/products/:id/applications', async (req, reply) => {
    const a = can(req, 'products:edit');
    const id = (req.params as { id: string }).id;
    const data = appSchema.parse(req.body);
    return tx(async (db) => {
      await assertRefs(db, a.companyId, { product_id: id }, { product_id: 'products' });
      await assertRefs(db, a.companyId, data, { vehicle_model_id: 'vehicle_models' });
      const r = await insertRow(db, 'product_applications', a.companyId, { ...data, product_id: id });
      await audit(db, a, 'product_application', String(r.id), 'create', null, r);
      return reply.code(201).send(r);
    });
  });
  app.delete('/products/:id/applications/:appId', async (req) => {
    const a = can(req, 'products:edit');
    const { id, appId } = req.params as { id: string; appId: string };
    return tx(async (db) => {
      const r = await db.query('delete from product_applications where id = $1 and product_id = $2 and company_id = $3 returning *', [appId, id, a.companyId]);
      if (!r.rowCount) throw new HttpError(404, 'Aplicação não encontrada.');
      await audit(db, a, 'product_application', appId, 'delete', r.rows[0], null);
      return { deleted: true };
    });
  });

  // --- Equivalências ---
  async function equivalentsOf(productId: string, companyId: string) {
    return (await pool.query(
      `select p.id, p.sku, p.description, p.manufacturer_code, p.original_code, b.name as brand_name,
              p.cost_current, p.sale_price, pe.is_original,
              case when p.sale_price > 0 then round((p.sale_price - p.cost_current) / p.sale_price * 100, 2) end as margin_pct
         from product_equivalences me
         join product_equivalences pe on pe.group_id = me.group_id
         join products p on p.id = pe.product_id
         left join brands b on b.id = p.brand_id
        where me.product_id = $1 and p.company_id = $2 and p.id <> $1
        order by pe.is_original desc, p.sale_price`, [productId, companyId])).rows;
  }
  app.get('/products/:id/equivalents', async (req) => {
    const a = can(req, 'equivalences:view');
    return equivalentsOf((req.params as { id: string }).id, a.companyId);
  });
  app.post('/products/:id/equivalents', async (req) => {
    const a = can(req, 'equivalences:create');
    const id = (req.params as { id: string }).id;
    const { otherProductId, isOriginal } = z.object({ otherProductId: z.string().uuid(), isOriginal: z.boolean().optional() }).parse(req.body);
    if (otherProductId === id) throw new HttpError(422, 'Produto não pode ser equivalente a si mesmo.');
    return tx(async (db) => {
      for (const pid of [id, otherProductId]) await assertRefs(db, a.companyId, { product_id: pid }, { product_id: 'products' });
      const g = (await db.query('select product_id, group_id from product_equivalences where product_id = any($1)', [[id, otherProductId]])).rows;
      const gi = g.find((x) => x.product_id === id), go = g.find((x) => x.product_id === otherProductId);
      if (gi && go && gi.group_id !== go.group_id) throw new HttpError(409, 'Os produtos já pertencem a grupos de equivalência diferentes.');
      let groupId = gi?.group_id ?? go?.group_id;
      if (!groupId) {
        groupId = (await db.query('insert into equivalence_groups (company_id, name) values ($1, $2) returning id', [a.companyId, `Grupo ${id.slice(0, 8)}`])).rows[0].id;
      }
      if (!gi) await db.query('insert into product_equivalences (group_id, product_id) values ($1,$2)', [groupId, id]);
      if (!go) await db.query('insert into product_equivalences (group_id, product_id) values ($1,$2)', [groupId, otherProductId]);
      if (isOriginal) {
        await db.query('update product_equivalences set is_original = (product_id = $2) where group_id = $1', [groupId, otherProductId]);
      }
      await audit(db, a, 'equivalence', groupId, 'link', null, { productId: id, otherProductId });
      return { groupId };
    });
  });
  app.delete('/products/:id/equivalents', async (req) => {
    const a = can(req, 'equivalences:delete');
    const id = (req.params as { id: string }).id;
    return tx(async (db) => {
      const r = await db.query(
        `delete from product_equivalences pe using products p where pe.product_id = p.id and p.id = $1 and p.company_id = $2 returning pe.group_id`, [id, a.companyId]);
      if (r.rowCount) {
        await db.query(`delete from equivalence_groups g where g.id = $1 and (select count(*) from product_equivalences where group_id = g.id) < 2`, [r.rows[0].group_id]);
        await audit(db, a, 'equivalence', r.rows[0].group_id, 'unlink', { productId: id }, null);
      }
      return { ok: true };
    });
  });
}
