import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db.js';
import { can, HttpError, type Auth } from '../auth.js';
import { audit } from '../audit.js';
import { pageParams } from '../crud.js';
import { resolvePrice } from '../pricing.js';
import { cancelSale, confirmSale, createSale, equivalentsWithStock, evaluate, METHODS, SALE_TYPES } from '../sales.js';
import { text } from '../schemas.js';
import { searchApplications } from './search.js';

export const itemSchema = z.object({ product_id: z.string().uuid(), qty: z.coerce.number().positive().max(1e6), discount_pct: z.coerce.number().min(0).lt(100).optional() });
const paymentSchema = z.object({ method: z.enum(METHODS), amount: z.coerce.number().positive(), installments: z.coerce.number().int().min(1).max(24).optional() });

export async function branchOf(db: Db, a: Auth, id?: string | null) {
  const b = id || a.branchId;
  if (!b) throw new HttpError(422, 'Selecione uma filial.');
  const ok = await db.query(
    `select 1 from branches b where b.id = $1 and b.company_id = $2 and b.active and (exists (select 1 from user_branches where user_id = $3 and branch_id = b.id) or not exists (select 1 from user_branches where user_id = $3))`, [b, a.companyId, a.userId]);
  if (!ok.rowCount) throw new HttpError(403, 'Filial não permitida.');
  return b;
}

/** Vendedores só enxergam as próprias vendas; quem aprova (gestão) vê todas. */
const scope = (a: Auth, params: unknown[]) => { if (a.permissions.has('sales:approve')) return ''; params.push(a.userId); return ` and s.seller_id = $${params.length}`; };

/** Ao faltar estoque, anexa à resposta os equivalentes disponíveis. */
async function withSuggestions<T>(a: Auth, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof HttpError && e.code === 'insufficient_stock' && e.extra?.product_id) {
      const suggestions = await equivalentsWithStock(a.companyId, String(e.extra.product_id), (e.extra.branch_id as string) ?? null);
      throw new HttpError(409, e.message, e.code, { ...e.extra, suggestions });
    }
    throw e;
  }
}

export async function salesRoutes(app: FastifyInstance) {
  // Prévia exibida antes de concluir: margem atual × após desconto × mínima, impacto financeiro e violações.
  app.post('/sales/preview', async (req) => {
    const a = can(req, 'sales:view');
    const b = z.object({ customer_id: z.string().uuid().nullish(), channel: z.string().default('balcao'), items: z.array(itemSchema).min(1) }).parse(req.body);
    return evaluate(pool, a, { customerId: b.customer_id, channel: b.channel, items: b.items });
  });

  app.post('/sales', async (req, reply) => {
    const a = can(req, 'sales:create');
    const b = z.object({ branch_id: z.string().uuid().nullish(), customer_id: z.string().uuid().nullish(), type: z.enum(SALE_TYPES), channel: z.string().max(30).optional(),
      items: z.array(itemSchema).min(1).max(300), notes: text(500), confirm: z.boolean().optional(), payments: z.array(paymentSchema).optional() }).parse(req.body);
    const out = await withSuggestions(a, () => tx(async (db) => {
      const branchId = await branchOf(db, a, b.branch_id);
      if (b.type !== 'balcao' && !b.customer_id) throw new HttpError(422, 'Este tipo de venda exige cliente.');
      const sale = await createSale(db, a, { branchId, customerId: b.customer_id, type: b.type, channel: b.channel, items: b.items, notes: b.notes });
      if (b.confirm) {
        if (sale.status === 'aguardando_aprovacao') return { ...sale, confirmed: false };
        const c = await confirmSale(db, a, sale.id, b.payments ?? []);
        return { ...sale, status: c.status, commission_amount: c.commission_amount, confirmed: true };
      }
      return { ...sale, confirmed: false };
    }));
    return reply.code(201).send(out);
  });

  app.get('/sales', async (req) => {
    const a = can(req, 'sales:view');
    const qs = req.query as Record<string, string>; const { page, pageSize, offset } = pageParams(qs);
    const params: unknown[] = [a.companyId]; let w = 's.company_id = $1' + scope(a, params);
    for (const f of ['status', 'customer_id', 'seller_id', 'type']) if (qs[f]) { params.push(qs[f]); w += ` and s.${f} = $${params.length}`; }
    if (qs.q?.trim()) { params.push(qs.q.trim()); w += ` and (s.number::text = $${params.length} or unaccent(coalesce(c.legal_name,'')) ilike unaccent('%' || $${params.length} || '%'))`; }
    if (qs.from) { params.push(qs.from); w += ` and s.created_at >= $${params.length}`; }
    if (qs.to) { params.push(qs.to); w += ` and s.created_at < ($${params.length}::date + 1)`; }
    const from = `from sales s left join customers c on c.id = s.customer_id join users u on u.id = s.seller_id where ${w}`;
    const [items, total] = await Promise.all([
      pool.query(`select s.*, c.legal_name as customer_name, u.name as seller_name ${from} order by s.number desc limit ${pageSize} offset ${offset}`, params),
      pool.query(`select count(*)::int n ${from}`, params)]);
    return { items: items.rows, total: total.rows[0].n, page, pageSize };
  });

  app.get('/sales/:id', async (req) => {
    const a = can(req, 'sales:view');
    const id = (req.params as { id: string }).id; const params: unknown[] = [id, a.companyId];
    const s = (await pool.query(`select s.*, c.legal_name as customer_name, u.name as seller_name, b.name as branch_name from sales s left join customers c on c.id = s.customer_id
      join users u on u.id = s.seller_id join branches b on b.id = s.branch_id where s.id = $1 and s.company_id = $2${scope(a, params)}`, params)).rows[0];
    if (!s) throw new HttpError(404, 'Venda não encontrada.');
    const [items, payments, receivables, approvals] = await Promise.all([
      pool.query(`select i.*, p.sku, p.description, round((i.unit_price - i.unit_cost) / nullif(i.unit_price,0) * 100, 2) as margin_pct from sale_items i join products p on p.id = i.product_id where i.sale_id = $1 order by p.description`, [id]),
      pool.query('select * from sale_payments where sale_id = $1', [id]), pool.query('select * from receivables where sale_id = $1 order by installment_no, due_date', [id]),
      pool.query(`select ap.*, r.name as requested_by_name, d.name as decided_by_name from sale_approvals ap join users r on r.id = ap.requested_by left join users d on d.id = ap.decided_by where ap.sale_id = $1 order by ap.requested_at`, [id])]);
    return { ...s, items: items.rows, payments: payments.rows, receivables: receivables.rows, approvals: approvals.rows };
  });

  app.post('/sales/:id/confirm', async (req) => {
    const a = can(req, 'sales:edit');
    const { payments } = z.object({ payments: z.array(paymentSchema).min(1) }).parse(req.body);
    return tx((db) => confirmSale(db, a, (req.params as { id: string }).id, payments));
  });

  app.post('/sales/:id/cancel', async (req) => {
    const a = can(req, 'sales:edit');
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    return tx((db) => cancelSale(db, a, (req.params as { id: string }).id, reason));
  });

  /** Repetir pedido em 1 clique: nova venda aberta com os mesmos itens, a preços e custos atuais. */
  app.post('/sales/:id/repeat', async (req, reply) => {
    const a = can(req, 'sales:create');
    const id = (req.params as { id: string }).id;
    const out = await withSuggestions(a, () => tx(async (db) => {
      const s = (await db.query('select * from sales where id = $1 and company_id = $2', [id, a.companyId])).rows[0];
      if (!s) throw new HttpError(404, 'Venda não encontrada.');
      const items = (await db.query('select product_id, qty from sale_items where sale_id = $1', [id])).rows.map((i) => ({ product_id: i.product_id, qty: Number(i.qty), discount_pct: 0 }));
      return createSale(db, a, { branchId: await branchOf(db, a, s.branch_id), customerId: s.customer_id, type: s.type === 'recorrente' ? 'b2b' : s.type, channel: s.channel, items, notes: `Repetição do pedido ${s.number}` });
    }));
    return reply.code(201).send(out);
  });

  // ---- Aprovações de alçada (gestor)
  app.get('/approvals', async (req) => {
    const a = can(req, 'sales:approve');
    const status = (req.query as Record<string, string>).status ?? 'pendente';
    const r = await pool.query(
      `select ap.*, s.number, s.total, s.margin_total, s.discount_total, c.legal_name as customer_name, u.name as requested_by_name, d.name as decided_by_name
         from sale_approvals ap join sales s on s.id = ap.sale_id left join customers c on c.id = s.customer_id join users u on u.id = ap.requested_by left join users d on d.id = ap.decided_by
        where ap.company_id = $1 and ap.status = $2 order by ap.requested_at desc limit 200`, [a.companyId, status]);
    return { items: r.rows };
  });

  const decide = (approve: boolean) => async (req: import('fastify').FastifyRequest) => {
    const a = can(req, 'sales:approve');
    const id = (req.params as { id: string }).id;
    const { note } = z.object({ note: text(300) }).parse(req.body ?? {});
    return tx(async (db) => {
      const ap = (await db.query('select * from sale_approvals where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
      if (!ap) throw new HttpError(404, 'Solicitação não encontrada.');
      if (ap.status !== 'pendente') throw new HttpError(409, 'Solicitação já decidida.');
      if (ap.requested_by === a.userId) throw new HttpError(403, 'A aprovação deve ser feita por outra pessoa (segregação de funções).');
      await db.query('update sale_approvals set status = $2, decided_by = $3, decided_at = now(), note = $4 where id = $1', [id, approve ? 'aprovado' : 'recusado', a.userId, note]);
      if (approve) await db.query(`update sales set status = 'aberto' where id = $1 and status = 'aguardando_aprovacao'`, [ap.sale_id]);
      else await cancelSale(db, a, ap.sale_id, `Aprovação recusada${note ? ': ' + note : ''}`);
      await audit(db, a, 'sale', ap.sale_id, approve ? 'approval_granted' : 'approval_denied', { violations: ap.violations }, { note });
      return { status: approve ? 'aprovado' : 'recusado' };
    });
  };
  app.post('/approvals/:id/approve', decide(true));
  app.post('/approvals/:id/reject', decide(false));

  // ---- PDV: busca por código, código de barras, SKU, fabricante, original, descrição e aplicação
  app.get('/pdv/search', async (req) => {
    const a = can(req, 'sales:create');
    const qs = z.object({ q: z.string().trim().min(1).max(100), customer_id: z.string().uuid().optional(), branch_id: z.string().uuid().optional(), channel: z.string().optional() }).parse(req.query);
    const branchId = await branchOf(pool, a, qs.branch_id);
    const like = `%${qs.q}%`;
    const direct = (await pool.query(
      `select p.id, (p.sku = $2 or p.internal_code = $2 or p.manufacturer_code = $2 or p.original_code = $2 or exists (select 1 from product_barcodes pb where pb.product_id = p.id and pb.barcode = $2)) as exact
         from products p where p.company_id = $1 and p.active and (unaccent(p.description) ilike unaccent($3) or p.sku ilike $3 or p.internal_code ilike $3 or p.manufacturer_code ilike $3 or p.original_code ilike $3
           or exists (select 1 from product_barcodes pb where pb.product_id = p.id and pb.barcode = $2)) order by exact desc, p.description limit 15`, [a.companyId, qs.q, like])).rows;
    const byApp = qs.q.includes(' ') ? (await searchApplications(a.companyId, qs.q)).items.slice(0, 15).map((x) => ({ id: x.id as string, exact: false })) : [];
    const ids = [...new Map([...direct, ...byApp].map((x) => [x.id, x])).values()].slice(0, 20);
    const out = [];
    for (const x of ids) {
      const p = (await pool.query(
        `select p.id, p.sku, p.description, p.manufacturer_code, p.location, b.name as brand_name,
           coalesce((select sum(qty) from stock_balances where product_id = p.id and branch_id = $2 and status = 'disponivel'), 0) as disponivel
         from products p left join brands b on b.id = p.brand_id where p.id = $1`, [x.id, branchId])).rows[0];
      const price = await resolvePrice(pool, a.companyId, x.id, { customerId: qs.customer_id, channel: qs.channel });
      out.push({ ...p, price: price.price, price_source: price.source, exact: x.exact, equivalents: Number(p.disponivel) <= 0 ? await equivalentsWithStock(a.companyId, x.id, branchId) : [] });
    }
    return { items: out };
  });

  app.get('/sales/availability/:productId', async (req) => {
    const a = can(req, 'sales:view');
    return { equivalents: await equivalentsWithStock(a.companyId, (req.params as { productId: string }).productId, a.branchId) };
  });
}
