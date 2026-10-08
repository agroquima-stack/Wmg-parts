import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db.js';
import { can, HttpError, type Auth } from '../auth.js';
import { audit } from '../audit.js';
import { assertRefs, insertRow, pageParams } from '../crud.js';
import { parseNFe } from '../lib/nfe.js';
import { applyMovement } from '../stock.js';
import { nextNumber } from '../sales.js';
import { categoryId } from '../finance.js';
import { createReceiving, finishReceiving, getPurchasingSettings, itemFlags, loadReceivingItems, recordSupplierPrice, suggestions } from '../purchasing.js';
import { text } from '../schemas.js';
import { branchOf } from './sales.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const poItems = z.array(z.object({ product_id: z.string().uuid(), qty: z.coerce.number().positive().max(1e7), unit_price: z.coerce.number().min(0) })).min(1).max(300);
const money = z.coerce.number().min(0).max(1e9);

interface PoInput { branchId: string; supplierId: string; items: { product_id: string; qty: number; unit_price: number }[]; expectedDate?: string | null; paymentTerms?: number; freight?: number; discount?: number; notes?: string | null; quotationId?: string | null; submit?: boolean }

/** Cria o pedido. Sem limite de aprovação configurado (padrão), "emitir" já aprova; com limite, pedidos acima dele aguardam quem tem purchases:approve. */
export async function createPO(db: import('pg').PoolClient, a: Auth, i: PoInput) {
  const sup = (await db.query('select id, payment_terms_days from suppliers where id = $1 and company_id = $2 and active', [i.supplierId, a.companyId])).rows[0];
  if (!sup) throw new HttpError(422, 'Fornecedor inválido ou inativo.');
  if (new Set(i.items.map((x) => x.product_id)).size !== i.items.length) throw new HttpError(422, 'Produto repetido no pedido.');
  for (const it of i.items) await assertRefs(db, a.companyId, it, { product_id: 'products' });
  const itemsTotal = r2(i.items.reduce((s, x) => s + x.qty * x.unit_price, 0)); const total = r2(itemsTotal + (i.freight ?? 0) - (i.discount ?? 0));
  if (total < 0) throw new HttpError(422, 'Desconto maior que o total do pedido.');
  const settings = await getPurchasingSettings(db, a.companyId);
  const needsApproval = settings.approval_threshold != null && total > settings.approval_threshold && !a.permissions.has('purchases:approve');
  const status = !i.submit ? 'rascunho' : needsApproval ? 'aguardando_aprovacao' : 'aprovado';
  const number = await nextNumber(db, a.companyId, 'purchase_order');
  const po = (await db.query(
    `insert into purchase_orders (company_id, branch_id, number, supplier_id, status, expected_date, payment_terms_days, freight, discount, total, notes, quotation_id, created_by, approved_by, approved_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
    [a.companyId, i.branchId, number, i.supplierId, status, i.expectedDate ?? null, i.paymentTerms ?? sup.payment_terms_days, i.freight ?? 0, i.discount ?? 0, total, i.notes ?? null, i.quotationId ?? null, a.userId,
     status === 'aprovado' ? a.userId : null, status === 'aprovado' ? new Date() : null])).rows[0];
  for (const it of i.items) await db.query('insert into purchase_order_items (po_id, product_id, qty, unit_price) values ($1,$2,$3,$4)', [po.id, it.product_id, it.qty, it.unit_price]);
  await audit(db, a, 'purchase_order', po.id, 'create', null, { number, status, total, items: i.items.length });
  return po;
}

const loadPO = async (db: Db, a: Auth, id: string) => {
  const po = (await db.query(`select po.*, s.legal_name as supplier_name, b.name as branch_name, u.name as created_by_name from purchase_orders po join suppliers s on s.id = po.supplier_id
    join branches b on b.id = po.branch_id join users u on u.id = po.created_by where po.id = $1 and po.company_id = $2`, [id, a.companyId])).rows[0];
  if (!po) throw new HttpError(404, 'Pedido de compra não encontrado.');
  return po;
};

export async function purchasingRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Configuração
  app.get('/purchasing/settings', async (req) => { const a = can(req, 'purchases:view'); return getPurchasingSettings(pool, a.companyId); });
  app.put('/purchasing/settings', async (req) => {
    const a = can(req, 'purchases:approve');
    const b = z.object({ approval_threshold: z.coerce.number().min(0).nullable(), review_days: z.coerce.number().int().min(0).max(60).default(7) }).parse(req.body);
    await pool.query(`insert into company_settings (company_id, key, value) values ($1,'purchasing',$2) on conflict (company_id, key) do update set value = $2, updated_at = now()`, [a.companyId, JSON.stringify(b)]);
    await audit(pool, a, 'settings', 'purchasing', 'update', null, b); return b;
  });

  // ---------------------------------------------------------------- Fornecedor × produto, preços e comparação
  app.get('/suppliers/:id/products', async (req) => {
    const a = can(req, 'suppliers:view'); const id = (req.params as { id: string }).id;
    const r = await pool.query(
      `select sp.product_id, p.sku, p.description, sp.supplier_code, sp.lead_time_days, sp.preferred,
         (select price from supplier_prices where supplier_id = sp.supplier_id and product_id = sp.product_id order by created_at desc, id desc limit 1) as last_price,
         (select round(avg(price),4) from supplier_prices where supplier_id = sp.supplier_id and product_id = sp.product_id) as avg_price
       from supplier_products sp join products p on p.id = sp.product_id where sp.supplier_id = $1 and sp.company_id = $2 order by p.description`, [id, a.companyId]);
    return { items: r.rows };
  });
  app.put('/suppliers/:id/products/:productId', async (req) => {
    const a = can(req, 'suppliers:edit'); const { id, productId } = req.params as { id: string; productId: string };
    const b = z.object({ supplier_code: text(60), lead_time_days: z.coerce.number().int().min(0).max(365).nullish().transform((v) => v ?? null), preferred: z.boolean().default(false), price: money.optional() }).parse(req.body);
    return tx(async (db) => {
      await assertRefs(db, a.companyId, { supplier_id: id, product_id: productId }, { supplier_id: 'suppliers', product_id: 'products' });
      if (b.preferred) await db.query('update supplier_products set preferred = false where product_id = $1', [productId]);
      await db.query(`insert into supplier_products (company_id, supplier_id, product_id, supplier_code, lead_time_days, preferred) values ($1,$2,$3,$4,$5,$6)
        on conflict (supplier_id, product_id) do update set supplier_code = $4, lead_time_days = $5, preferred = $6`, [a.companyId, id, productId, b.supplier_code, b.lead_time_days, b.preferred]);
      if (b.price != null) await recordSupplierPrice(db, a.companyId, id, productId, b.price, 'manual');
      await audit(db, a, 'supplier_product', `${id}:${productId}`, 'upsert', null, b); return { ok: true };
    });
  });
  app.delete('/suppliers/:id/products/:productId', async (req) => {
    const a = can(req, 'suppliers:edit'); const { id, productId } = req.params as { id: string; productId: string };
    await pool.query('delete from supplier_products where supplier_id = $1 and product_id = $2 and company_id = $3', [id, productId, a.companyId]);
    await audit(pool, a, 'supplier_product', `${id}:${productId}`, 'delete'); return { deleted: true };
  });

  /** Comparação de fornecedores para um produto: último preço, variação, média, menor/maior, prazo. */
  app.get('/purchasing/compare', async (req) => {
    const a = can(req, 'purchases:view'); const { product_id } = z.object({ product_id: z.string().uuid() }).parse(req.query);
    const r = await pool.query(
      `with ranked as (select sp.*, row_number() over (partition by sp.supplier_id order by sp.created_at desc, sp.id desc) as rn from supplier_prices sp where sp.company_id = $1 and sp.product_id = $2)
       select s.id as supplier_id, s.legal_name, coalesce(sup.lead_time_days, s.lead_time_days) as lead_time_days, s.payment_terms_days, s.freight_type,
         max(case when ranked.rn = 1 then ranked.price end) as last_price, max(case when ranked.rn = 1 then ranked.created_at end) as last_at, max(case when ranked.rn = 2 then ranked.price end) as previous_price,
         round(avg(ranked.price),4) as avg_price, min(ranked.price) as min_price, max(ranked.price) as max_price, count(*)::int as quotes
       from ranked join suppliers s on s.id = ranked.supplier_id left join supplier_products sup on sup.supplier_id = s.id and sup.product_id = $2 group by s.id, sup.lead_time_days order by last_price`, [a.companyId, product_id]);
    const items = r.rows.map((x) => ({ ...x, variation_pct: x.previous_price && Number(x.previous_price) > 0 ? r2((Number(x.last_price) - Number(x.previous_price)) / Number(x.previous_price) * 100) : null }));
    const history = (await pool.query(`select sp.price, sp.source, sp.ref, sp.created_at, s.legal_name from supplier_prices sp join suppliers s on s.id = sp.supplier_id where sp.company_id = $1 and sp.product_id = $2 order by sp.created_at desc, sp.id desc limit 100`, [a.companyId, product_id])).rows;
    return { suppliers: items, cheapest_supplier_id: items[0]?.supplier_id ?? null, history };
  });

  // ---------------------------------------------------------------- Sugestão de compra
  app.get('/purchasing/suggestions', async (req) => {
    const a = can(req, 'purchases:view'); const q = req.query as Record<string, string>;
    const branchId = q.branch_id === 'all' ? null : await branchOf(pool, a, q.branch_id);
    const items = await suggestions(a.companyId, branchId, q.supplier_id || null);
    return { items, total_estimated: r2(items.reduce((s, i) => s + (i.est_cost ?? 0), 0)), branch_id: branchId,
      note: 'Estimativa baseada no histórico real da empresa; confira a confiança de cada item antes de comprar.' };
  });

  app.post('/purchase-orders/from-suggestions', async (req, reply) => {
    const a = can(req, 'purchases:create');
    const b = z.object({ branch_id: z.string().uuid().nullish(), submit: z.boolean().default(true),
      items: z.array(z.object({ product_id: z.string().uuid(), supplier_id: z.string().uuid(), qty: z.coerce.number().positive(), unit_price: money })).min(1) }).parse(req.body);
    const pos = await tx(async (db) => {
      const branchId = await branchOf(db, a, b.branch_id); const bySupplier = new Map<string, typeof b.items>();
      for (const it of b.items) bySupplier.set(it.supplier_id, [...(bySupplier.get(it.supplier_id) ?? []), it]);
      const out = [];
      for (const [supplierId, items] of bySupplier) out.push(await createPO(db, a, { branchId, supplierId, items, submit: b.submit, notes: 'Gerado pela sugestão de compra' }));
      return out;
    });
    return reply.code(201).send({ orders: pos });
  });

  // ---------------------------------------------------------------- Cotações
  app.post('/quotations', async (req, reply) => {
    const a = can(req, 'purchases:create');
    const b = z.object({ note: text(300), items: z.array(z.object({ product_id: z.string().uuid(), qty: z.coerce.number().positive() })).min(1).max(200) }).parse(req.body);
    const q = await tx(async (db) => {
      for (const it of b.items) await assertRefs(db, a.companyId, it, { product_id: 'products' });
      const number = await nextNumber(db, a.companyId, 'quotation');
      const q = (await db.query('insert into quotations (company_id, number, note, created_by) values ($1,$2,$3,$4) returning *', [a.companyId, number, b.note, a.userId])).rows[0];
      for (const it of b.items) await db.query('insert into quotation_items values ($1,$2,$3) on conflict (quotation_id, product_id) do update set qty = excluded.qty', [q.id, it.product_id, it.qty]);
      await audit(db, a, 'quotation', q.id, 'create', null, { number, items: b.items.length }); return q;
    });
    return reply.code(201).send(q);
  });
  app.get('/quotations', async (req) => {
    const a = can(req, 'purchases:view');
    const r = await pool.query(`select q.*, (select count(*)::int from quotation_items where quotation_id = q.id) as items, (select count(*)::int from quotation_offers where quotation_id = q.id) as offers from quotations q where q.company_id = $1 order by q.number desc limit 100`, [a.companyId]);
    return { items: r.rows };
  });
  app.get('/quotations/:id', async (req) => {
    const a = can(req, 'purchases:view'); const id = (req.params as { id: string }).id;
    const q = (await pool.query('select * from quotations where id = $1 and company_id = $2', [id, a.companyId])).rows[0];
    if (!q) throw new HttpError(404, 'Cotação não encontrada.');
    const items = (await pool.query(`select qi.*, p.sku, p.description, p.cost_avg from quotation_items qi join products p on p.id = qi.product_id where qi.quotation_id = $1 order by p.description`, [id])).rows;
    const offers = (await pool.query(`select o.*, s.legal_name as supplier_name from quotation_offers o join suppliers s on s.id = o.supplier_id where o.quotation_id = $1 order by o.unit_price`, [id])).rows;
    // comparação: melhor preço por item; empate decide por menor prazo de entrega
    const compared = items.map((it) => {
      const os = offers.filter((o) => o.product_id === it.product_id);
      const best = [...os].sort((x, y) => Number(x.unit_price) - Number(y.unit_price) || (x.lead_time_days ?? 999) - (y.lead_time_days ?? 999))[0];
      return { ...it, offers: os, best_offer_id: best?.id ?? null };
    });
    return { ...q, items: compared };
  });
  app.post('/quotations/:id/offers', async (req, reply) => {
    const a = can(req, 'purchases:edit'); const id = (req.params as { id: string }).id;
    const b = z.object({ product_id: z.string().uuid(), supplier_id: z.string().uuid(), unit_price: money, lead_time_days: z.coerce.number().int().min(0).nullish().transform((v) => v ?? null),
      payment_terms_days: z.coerce.number().int().min(0).nullish().transform((v) => v ?? null), note: text(200) }).parse(req.body);
    return tx(async (db) => {
      const q = (await db.query('select status from quotations where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
      if (!q) throw new HttpError(404, 'Cotação não encontrada.'); if (q.status !== 'aberta') throw new HttpError(409, `Cotação ${q.status}.`);
      const inQ = await db.query('select 1 from quotation_items where quotation_id = $1 and product_id = $2', [id, b.product_id]);
      if (!inQ.rowCount) throw new HttpError(422, 'Produto não faz parte da cotação.');
      await assertRefs(db, a.companyId, b, { supplier_id: 'suppliers' });
      await db.query(`insert into quotation_offers (quotation_id, company_id, product_id, supplier_id, unit_price, lead_time_days, payment_terms_days, note) values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (quotation_id, product_id, supplier_id) do update set unit_price = $5, lead_time_days = $6, payment_terms_days = $7, note = $8`, [id, a.companyId, b.product_id, b.supplier_id, b.unit_price, b.lead_time_days, b.payment_terms_days, b.note]);
      await recordSupplierPrice(db, a.companyId, b.supplier_id, b.product_id, b.unit_price, 'cotacao', `cotação ${id.slice(0, 8)}`);
      return reply.code(201).send({ ok: true });
    });
  });
  /** Fecha a cotação gerando um pedido por fornecedor vencedor (preço, prazo e condição da oferta escolhida). */
  app.post('/quotations/:id/award', async (req, reply) => {
    const a = can(req, 'purchases:create'); const id = (req.params as { id: string }).id;
    const b = z.object({ branch_id: z.string().uuid().nullish(), awards: z.array(z.object({ product_id: z.string().uuid(), supplier_id: z.string().uuid() })).min(1) }).parse(req.body);
    const pos = await tx(async (db) => {
      const q = (await db.query('select * from quotations where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
      if (!q) throw new HttpError(404, 'Cotação não encontrada.'); if (q.status !== 'aberta') throw new HttpError(409, `Cotação ${q.status}.`);
      const branchId = await branchOf(db, a, b.branch_id); const bySupplier = new Map<string, { product_id: string; qty: number; unit_price: number; lead: number | null; terms: number | null }[]>();
      for (const aw of b.awards) {
        const o = (await db.query(`select o.*, qi.qty from quotation_offers o join quotation_items qi on qi.quotation_id = o.quotation_id and qi.product_id = o.product_id where o.quotation_id = $1 and o.product_id = $2 and o.supplier_id = $3`, [id, aw.product_id, aw.supplier_id])).rows[0];
        if (!o) throw new HttpError(422, 'Oferta inexistente para o item escolhido.');
        await db.query('update quotation_offers set selected = true where id = $1', [o.id]);
        bySupplier.set(aw.supplier_id, [...(bySupplier.get(aw.supplier_id) ?? []), { product_id: aw.product_id, qty: Number(o.qty), unit_price: Number(o.unit_price), lead: o.lead_time_days, terms: o.payment_terms_days }]);
      }
      const out = [];
      for (const [supplierId, items] of bySupplier) {
        const lead = Math.max(...items.map((i) => i.lead ?? 0)); const terms = items.find((i) => i.terms != null)?.terms ?? undefined;
        out.push(await createPO(db, a, { branchId, supplierId, items, quotationId: id, submit: true, paymentTerms: terms, expectedDate: new Date(Date.now() + lead * 86400000).toISOString().slice(0, 10), notes: `Cotação nº ${q.number}` }));
      }
      await db.query(`update quotations set status = 'fechada' where id = $1`, [id]);
      await audit(db, a, 'quotation', id, 'award', { status: 'aberta' }, { status: 'fechada', orders: out.map((o) => o.number) }); return out;
    });
    return reply.code(201).send({ orders: pos });
  });
  app.post('/quotations/:id/cancel', async (req) => {
    const a = can(req, 'purchases:edit'); const id = (req.params as { id: string }).id;
    const r = await pool.query(`update quotations set status = 'cancelada' where id = $1 and company_id = $2 and status = 'aberta' returning id`, [id, a.companyId]);
    if (!r.rowCount) throw new HttpError(409, 'Cotação não encontrada ou já finalizada.'); await audit(pool, a, 'quotation', id, 'cancel'); return { status: 'cancelada' };
  });

  // ---------------------------------------------------------------- Pedidos de compra
  const poBody = z.object({ branch_id: z.string().uuid().nullish(), supplier_id: z.string().uuid(), items: poItems, expected_date: z.string().date().nullish().transform((v) => v || null),
    payment_terms_days: z.coerce.number().int().min(0).max(365).optional(), freight: money.optional(), discount: money.optional(), notes: text(500), submit: z.boolean().default(false) });
  app.post('/purchase-orders', async (req, reply) => {
    const a = can(req, 'purchases:create'); const b = poBody.parse(req.body);
    const po = await tx(async (db) => createPO(db, a, { branchId: await branchOf(db, a, b.branch_id), supplierId: b.supplier_id, items: b.items, expectedDate: b.expected_date, paymentTerms: b.payment_terms_days, freight: b.freight, discount: b.discount, notes: b.notes, submit: b.submit }));
    return reply.code(201).send(po);
  });
  app.get('/purchase-orders', async (req) => {
    const a = can(req, 'purchases:view'); const qs = req.query as Record<string, string>; const { page, pageSize, offset } = pageParams(qs);
    const params: unknown[] = [a.companyId]; let w = 'po.company_id = $1';
    if (qs.status) { params.push(qs.status); w += ` and po.status = $${params.length}`; }
    if (qs.supplier_id) { params.push(qs.supplier_id); w += ` and po.supplier_id = $${params.length}`; }
    if (qs.q?.trim()) { params.push(qs.q.trim()); w += ` and (po.number::text = $${params.length} or unaccent(s.legal_name) ilike unaccent('%' || $${params.length} || '%'))`; }
    const from = `from purchase_orders po join suppliers s on s.id = po.supplier_id where ${w}`;
    const [items, total] = await Promise.all([pool.query(`select po.*, s.legal_name as supplier_name, (po.expected_date < current_date and po.status in ('aprovado','enviado','parcial')) as late ${from} order by po.number desc limit ${pageSize} offset ${offset}`, params),
      pool.query(`select count(*)::int n ${from}`, params)]);
    return { items: items.rows, total: total.rows[0].n, page, pageSize };
  });
  app.get('/purchase-orders/:id', async (req) => {
    const a = can(req, 'purchases:view'); const id = (req.params as { id: string }).id; const po = await loadPO(pool, a, id);
    const items = (await pool.query(`select i.*, p.sku, p.description, (i.qty - i.received_qty) as pending from purchase_order_items i join products p on p.id = i.product_id where i.po_id = $1 order by p.description`, [id])).rows;
    const receivings = (await pool.query('select id, number, nf_number, status, total_nf, created_at from receivings where po_id = $1 order by number', [id])).rows;
    return { ...po, items, receivings };
  });
  app.patch('/purchase-orders/:id', async (req) => {
    const a = can(req, 'purchases:edit'); const id = (req.params as { id: string }).id; const b = poBody.partial().parse(req.body);
    return tx(async (db) => {
      const po = (await db.query('select * from purchase_orders where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
      if (!po) throw new HttpError(404, 'Pedido não encontrado.'); if (po.status !== 'rascunho') throw new HttpError(409, 'Somente rascunhos podem ser editados.');
      const freight = b.freight ?? Number(po.freight), discount = b.discount ?? Number(po.discount);
      let itemsTotal = Number((await db.query('select coalesce(sum(qty*unit_price),0) s from purchase_order_items where po_id = $1', [id])).rows[0].s);
      if (b.items) {
        for (const it of b.items) await assertRefs(db, a.companyId, it, { product_id: 'products' });
        await db.query('delete from purchase_order_items where po_id = $1', [id]);
        for (const it of b.items) await db.query('insert into purchase_order_items (po_id, product_id, qty, unit_price) values ($1,$2,$3,$4)', [id, it.product_id, it.qty, it.unit_price]);
        itemsTotal = b.items.reduce((s, x) => s + x.qty * x.unit_price, 0);
      }
      await db.query(`update purchase_orders set expected_date = coalesce($2, expected_date), payment_terms_days = coalesce($3, payment_terms_days), freight = $4, discount = $5, notes = coalesce($6, notes), total = $7 where id = $1`,
        [id, b.expected_date ?? null, b.payment_terms_days ?? null, freight, discount, b.notes ?? null, r2(itemsTotal + freight - discount)]);
      await audit(db, a, 'purchase_order', id, 'update', null, b); return { ok: true };
    });
  });
  const poAction = (action: 'submit' | 'approve' | 'send' | 'cancel') => async (req: FastifyRequest) => {
    const a = can(req, action === 'approve' ? 'purchases:approve' : action === 'cancel' ? 'purchases:edit' : 'purchases:create'); const id = (req.params as { id: string }).id;
    return tx(async (db) => {
      const po = (await db.query('select * from purchase_orders where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
      if (!po) throw new HttpError(404, 'Pedido não encontrado.');
      const from = po.status; let to: string;
      if (action === 'submit') {
        if (from !== 'rascunho') throw new HttpError(409, `Pedido ${from}.`);
        const s = await getPurchasingSettings(db, a.companyId);
        to = s.approval_threshold != null && Number(po.total) > s.approval_threshold && !a.permissions.has('purchases:approve') ? 'aguardando_aprovacao' : 'aprovado';
      } else if (action === 'approve') {
        if (from !== 'aguardando_aprovacao') throw new HttpError(409, `Pedido ${from}.`);
        if (po.created_by === a.userId) throw new HttpError(403, 'A aprovação deve ser feita por outra pessoa (segregação de funções).');
        to = 'aprovado';
      } else if (action === 'send') {
        if (!['aprovado', 'enviado'].includes(from)) throw new HttpError(409, `Pedido ${from}.`); to = 'enviado';
      } else {
        if (['parcial', 'recebido', 'cancelado'].includes(from)) throw new HttpError(409, `Pedido ${from} não pode ser cancelado.`);
        const rc = await db.query(`select 1 from receivings where po_id = $1 and status = 'em_conferencia'`, [id]);
        if (rc.rowCount) throw new HttpError(409, 'Há recebimento em conferência para este pedido.'); to = 'cancelado';
      }
      await db.query('update purchase_orders set status = $2, approved_by = case when $2 = \'aprovado\' then $3::uuid else approved_by end, approved_at = case when $2 = \'aprovado\' then now() else approved_at end where id = $1', [id, to, a.userId]);
      await audit(db, a, 'purchase_order', id, action, { status: from }, { status: to }); return { status: to };
    });
  };
  for (const act of ['submit', 'approve', 'send', 'cancel'] as const) app.post(`/purchase-orders/:id/${act}`, poAction(act));

  // ---------------------------------------------------------------- Recebimento (XML / manual) e conferência
  app.post('/receivings/import-xml', { bodyLimit: 4_000_000 }, async (req, reply) => {
    const a = can(req, 'receiving:create');
    const b = z.object({ xml: z.string().min(50), branch_id: z.string().uuid().nullish(), po_id: z.string().uuid().nullish(), create_supplier: z.boolean().default(false) }).parse(req.body);
    let nfe; try { nfe = parseNFe(b.xml); } catch (e) { throw new HttpError(422, (e as Error).message, 'invalid_xml'); }
    const rec = await tx(async (db) => {
      let sup = (await db.query(`select id from suppliers where company_id = $1 and cnpj = $2`, [a.companyId, nfe.supplier.cnpj])).rows[0];
      if (!sup) {
        if (!b.create_supplier) throw new HttpError(422, `Fornecedor ${nfe.supplier.name} (${nfe.supplier.cnpj}) não está cadastrado.`, 'supplier_not_found', { cnpj: nfe.supplier.cnpj, name: nfe.supplier.name });
        if (!a.permissions.has('suppliers:create')) throw new HttpError(403, 'Sem permissão para cadastrar fornecedor (suppliers:create).');
        sup = await insertRow(db, 'suppliers', a.companyId, { legal_name: nfe.supplier.name || nfe.supplier.cnpj, cnpj: nfe.supplier.cnpj });
        await audit(db, a, 'supplier', String(sup.id), 'create', null, { via: 'importação de XML' });
      }
      return createReceiving(db, a, { branchId: await branchOf(db, a, b.branch_id), poId: b.po_id, supplierId: sup.id, source: 'xml', nfNumber: nfe.number, nfSeries: nfe.series, nfKey: nfe.key, issueDate: nfe.issue_date,
        freight: nfe.totals.freight, insurance: nfe.totals.insurance, other: nfe.totals.other, discount: nfe.totals.discount, ipiTotal: nfe.totals.ipi, totalNf: nfe.totals.nf || undefined, installments: nfe.installments, xml: b.xml,
        items: nfe.items.map((i) => ({ supplier_code: i.supplier_code, ean: i.ean, description: i.description, ncm: i.ncm, cfop: i.cfop, unit: i.unit, qty: i.qty, unit_price: i.unit_price, ipi: i.ipi })) });
    });
    return reply.code(201).send(rec);
  });
  app.post('/receivings', async (req, reply) => {
    const a = can(req, 'receiving:create');
    const b = z.object({ branch_id: z.string().uuid().nullish(), supplier_id: z.string().uuid(), po_id: z.string().uuid().nullish(), nf_number: z.string().trim().min(1).max(20), nf_series: text(5), issue_date: z.string().date().nullish().transform((v) => v || null),
      freight: money.optional(), insurance: money.optional(), other: money.optional(), discount: money.optional(),
      items: z.array(z.object({ product_id: z.string().uuid(), qty: z.coerce.number().positive(), unit_price: money, ipi: money.optional() })).min(1).max(500) }).parse(req.body);
    const rec = await tx(async (db) => {
      const prods = await db.query('select id, sku, description from products where company_id = $1 and id = any($2)', [a.companyId, b.items.map((i) => i.product_id)]);
      const names = new Map(prods.rows.map((p) => [p.id, p]));
      return createReceiving(db, a, { branchId: await branchOf(db, a, b.branch_id), poId: b.po_id, supplierId: b.supplier_id, source: 'manual', nfNumber: b.nf_number, nfSeries: b.nf_series, issueDate: b.issue_date,
        freight: b.freight, insurance: b.insurance, other: b.other, discount: b.discount,
        items: b.items.map((i) => ({ product_id: i.product_id, description: names.get(i.product_id)?.description ?? '', supplier_code: names.get(i.product_id)?.sku, qty: i.qty, unit_price: i.unit_price, ipi: i.ipi })) });
    });
    return reply.code(201).send(rec);
  });
  app.get('/receivings', async (req) => {
    const a = can(req, 'receiving:view'); const qs = req.query as Record<string, string>; const { page, pageSize, offset } = pageParams(qs);
    const params: unknown[] = [a.companyId]; let w = 'r.company_id = $1';
    if (qs.status) { params.push(qs.status); w += ` and r.status = $${params.length}`; }
    const from = `from receivings r join suppliers s on s.id = r.supplier_id left join purchase_orders po on po.id = r.po_id where ${w}`;
    const [items, total] = await Promise.all([pool.query(`select r.*, s.legal_name as supplier_name, po.number as po_number ${from} order by r.number desc limit ${pageSize} offset ${offset}`, params), pool.query(`select count(*)::int n ${from}`, params)]);
    return { items: items.rows, total: total.rows[0].n, page, pageSize };
  });
  app.get('/receivings/:id', async (req) => {
    const a = can(req, 'receiving:view'); const id = (req.params as { id: string }).id;
    const r = (await pool.query(`select r.*, s.legal_name as supplier_name, po.number as po_number from receivings r join suppliers s on s.id = r.supplier_id left join purchase_orders po on po.id = r.po_id where r.id = $1 and r.company_id = $2`, [id, a.companyId])).rows[0];
    if (!r) throw new HttpError(404, 'Recebimento não encontrado.');
    return { ...r, items: await loadReceivingItems(pool, id, !!r.po_id) };
  });
  /** Conferência: vincula item do XML a produto (aprendendo o código do fornecedor) e registra a quantidade contada. */
  app.patch('/receivings/:id/items/:itemId', async (req) => {
    const a = can(req, 'receiving:edit'); const { id, itemId } = req.params as { id: string; itemId: string };
    const b = z.object({ product_id: z.string().uuid().optional(), qty_received: z.coerce.number().min(0).nullable().optional() }).parse(req.body);
    return tx(async (db) => {
      const rec = (await db.query('select * from receivings where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
      if (!rec) throw new HttpError(404, 'Recebimento não encontrado.'); if (rec.status !== 'em_conferencia') throw new HttpError(409, 'Recebimento já finalizado.');
      const it = (await db.query('select * from receiving_items where id = $1 and receiving_id = $2', [itemId, id])).rows[0];
      if (!it) throw new HttpError(404, 'Item não encontrado.');
      if (b.product_id) {
        await assertRefs(db, a.companyId, b, { product_id: 'products' });
        const poItem = rec.po_id ? (await db.query('select id from purchase_order_items where po_id = $1 and product_id = $2', [rec.po_id, b.product_id])).rows[0] : null;
        await db.query('update receiving_items set product_id = $2, po_item_id = $3 where id = $1', [itemId, b.product_id, poItem?.id ?? null]);
        if (it.supplier_code) await db.query(`insert into supplier_products (company_id, supplier_id, product_id, supplier_code) values ($1,$2,$3,$4) on conflict (supplier_id, product_id) do update set supplier_code = excluded.supplier_code`, [a.companyId, rec.supplier_id, b.product_id, it.supplier_code]);
      }
      if (b.qty_received !== undefined) await db.query('update receiving_items set qty_received = $2 where id = $1', [itemId, b.qty_received]);
      await audit(db, a, 'receiving', id, 'conference', null, { itemId, ...b }); return { ok: true };
    });
  });
  app.post('/receivings/:id/check-all', async (req) => {
    const a = can(req, 'receiving:edit'); const id = (req.params as { id: string }).id;
    const r = await pool.query(`update receiving_items ri set qty_received = ri.qty_nf from receivings r where ri.receiving_id = r.id and r.id = $1 and r.company_id = $2 and r.status = 'em_conferencia' and ri.qty_received is null`, [id, a.companyId]);
    return { updated: r.rowCount };
  });
  app.post('/receivings/:id/finish', async (req) => {
    const a = can(req, 'receiving:create'); const b = z.object({ accept_divergences: z.boolean().default(false) }).parse(req.body ?? {});
    return tx((db) => finishReceiving(db, a, (req.params as { id: string }).id, b.accept_divergences));
  });
  app.post('/receivings/:id/cancel', async (req) => {
    const a = can(req, 'receiving:edit'); const id = (req.params as { id: string }).id;
    const r = await pool.query(`update receivings set status = 'cancelado' where id = $1 and company_id = $2 and status = 'em_conferencia' returning id`, [id, a.companyId]);
    if (!r.rowCount) throw new HttpError(409, 'Recebimento não encontrado ou já finalizado.'); await audit(pool, a, 'receiving', id, 'cancel'); return { status: 'cancelado' };
  });

  // ---------------------------------------------------------------- Devolução ao fornecedor
  app.post('/supplier-returns', async (req, reply) => {
    const a = can(req, 'purchases:create');
    const b = z.object({ branch_id: z.string().uuid().nullish(), supplier_id: z.string().uuid(), receiving_id: z.string().uuid().nullish(), reason: z.string().trim().min(3).max(300),
      items: z.array(z.object({ product_id: z.string().uuid(), qty: z.coerce.number().positive(), unit_cost: money.optional() })).min(1).max(200) }).parse(req.body);
    const out = await tx(async (db) => {
      await assertRefs(db, a.companyId, b, { supplier_id: 'suppliers', receiving_id: 'receivings' });
      const branchId = await branchOf(db, a, b.branch_id); const number = await nextNumber(db, a.companyId, 'supplier_return'); let total = 0;
      const ret = (await db.query('insert into supplier_returns (company_id, branch_id, number, supplier_id, receiving_id, reason, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning *', [a.companyId, branchId, number, b.supplier_id, b.receiving_id ?? null, b.reason, a.userId])).rows[0];
      for (const it of b.items) {
        const p = (await db.query('select cost_avg, cost_current from products where id = $1 and company_id = $2', [it.product_id, a.companyId])).rows[0]; if (!p) throw new HttpError(422, 'Produto inválido.');
        const cost = it.unit_cost ?? (Number(p.cost_avg) > 0 ? Number(p.cost_avg) : Number(p.cost_current)); total += it.qty * cost;
        await applyMovement(db, a, { branchId, productId: it.product_id, type: 'devolucao_fornecedor', qty: it.qty, from: 'disponivel', to: null, unitCost: cost, documentType: 'devolucao_fornecedor', documentRef: String(number), reason: b.reason });
        await db.query('insert into supplier_return_items values ($1,$2,$3,$4)', [ret.id, it.product_id, it.qty, cost]);
      }
      total = r2(total);
      await db.query('update supplier_returns set total = $2 where id = $1', [ret.id, total]);
      if (total > 0) await db.query(`insert into payables (company_id, supplier_id, receiving_id, kind, due_date, amount, description, category_id, competence) values ($1,$2,$3,'credito', current_date, $4, $5, $6, date_trunc('month', current_date)::date)`, [a.companyId, b.supplier_id, b.receiving_id ?? null, total, `Crédito — devolução nº ${number}`, await categoryId(db, a.companyId, 'Compra de mercadorias')]);
      await audit(db, a, 'supplier_return', ret.id, 'create', null, { number, total, items: b.items.length }); return { ...ret, total };
    });
    return reply.code(201).send(out);
  });
  app.get('/supplier-returns', async (req) => {
    const a = can(req, 'purchases:view');
    const r = await pool.query(`select sr.*, s.legal_name as supplier_name from supplier_returns sr join suppliers s on s.id = sr.supplier_id where sr.company_id = $1 order by sr.number desc limit 100`, [a.companyId]);
    return { items: r.rows };
  });

  // exposto para testes/relatórios
  void itemFlags;
}
