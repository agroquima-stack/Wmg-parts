import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db.js';
import { config } from '../config.js';
import { can, HttpError, type Auth } from '../auth.js';
import { audit } from '../audit.js';
import { pageParams } from '../crud.js';
import { resolvePrice } from '../pricing.js';
import { authForUser, createSale, nextNumber } from '../sales.js';
import { newToken, sha256 } from '../lib/security.js';
import { text } from '../schemas.js';
import { itemSchema } from './sales.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const quoteSchema = z.object({
  customer_id: z.string().uuid(), valid_until: z.string().date().optional(), valid_days: z.coerce.number().int().min(1).max(180).default(7),
  payment_condition: text(120), lead_time_days: z.coerce.number().int().min(0).max(365).nullish().transform((v) => v ?? null), notes: text(1000),
  items: z.array(itemSchema).min(1).max(300),
});

async function expire(db: Db, companyId: string) {
  await db.query(`update quotes set status = 'expirado' where company_id = $1 and valid_until < current_date and status in ('rascunho','enviado','visualizado')`, [companyId]);
}

async function priceItems(db: Db, a: Auth, customerId: string, items: z.infer<typeof itemSchema>[]) {
  const out = [];
  for (const it of items) {
    const p = (await db.query('select id, active from products where id = $1 and company_id = $2', [it.product_id, a.companyId])).rows[0];
    if (!p || !p.active) throw new HttpError(422, 'Produto inexistente ou inativo.');
    const rp = await resolvePrice(db, a.companyId, it.product_id, { customerId, qty: it.qty });
    if (rp.price <= 0) throw new HttpError(422, 'Produto sem preço de venda.');
    const d = it.discount_pct ?? 0; const unit = r2(rp.price * (1 - d / 100));
    out.push({ product_id: it.product_id, qty: it.qty, list_price: rp.price, discount_pct: d, unit_price: unit, total: r2(unit * it.qty) });
  }
  return out;
}

async function saveItems(db: Db, companyId: string, quoteId: string, lines: Awaited<ReturnType<typeof priceItems>>) {
  await db.query('delete from quote_items where quote_id = $1', [quoteId]);
  for (const l of lines)
    await db.query('insert into quote_items (quote_id, company_id, product_id, qty, list_price, discount_pct, unit_price, total) values ($1,$2,$3,$4,$5,$6,$7,$8)', [quoteId, companyId, l.product_id, l.qty, l.list_price, l.discount_pct, l.unit_price, l.total]);
  const subtotal = r2(lines.reduce((s, l) => s + l.list_price * l.qty, 0)), total = r2(lines.reduce((s, l) => s + l.total, 0));
  await db.query('update quotes set subtotal = $2, total = $3, discount_total = $4 where id = $1', [quoteId, subtotal, total, r2(subtotal - total)]);
}

/** Converte orçamento em venda (reserva estoque). Preços do orçamento são honrados; alçada é avaliada contra o vendedor do orçamento. */
async function convertQuote(db: import('pg').PoolClient, a: Auth, quoteId: string) {
  const q = (await db.query('select * from quotes where id = $1 and company_id = $2 for update', [quoteId, a.companyId])).rows[0];
  if (!q) throw new HttpError(404, 'Orçamento não encontrado.');
  if (q.status === 'convertido') throw new HttpError(409, 'Orçamento já convertido.');
  if (['recusado', 'expirado'].includes(q.status) || q.valid_until < new Date().toISOString().slice(0, 10)) throw new HttpError(409, 'Orçamento recusado ou expirado.');
  const items = (await db.query('select product_id, qty, unit_price from quote_items where quote_id = $1', [quoteId])).rows
    .map((i) => ({ product_id: i.product_id, qty: Number(i.qty), fixed_unit_price: Number(i.unit_price) }));
  const sale = await createSale(db, a, { branchId: q.branch_id, customerId: q.customer_id, type: 'balcao', channel: 'balcao', items, quoteId, sellerId: q.seller_id, notes: `Orçamento ${q.number}` });
  await db.query(`update quotes set status = 'convertido', converted_sale_id = $2, decided_at = coalesce(decided_at, now()) where id = $1`, [quoteId, sale.id]);
  await audit(db, a, 'quote', quoteId, 'convert', { status: q.status }, { status: 'convertido', sale_id: sale.id });
  return sale;
}

const waLink = (phone: string | null, text: string) => {
  const d = (phone ?? '').replace(/\D/g, ''); if (d.length < 10) return null;
  return `https://wa.me/${d.length <= 11 ? '55' + d : d}?text=${encodeURIComponent(text)}`;
};

export async function quoteRoutes(app: FastifyInstance) {
  app.post('/quotes', async (req, reply) => {
    const a = can(req, 'quotes:create');
    const b = quoteSchema.parse(req.body);
    const q = await tx(async (db) => {
      if (!a.branchId) throw new HttpError(422, 'Selecione uma filial.');
      const c = (await db.query('select status from customers where id = $1 and company_id = $2', [b.customer_id, a.companyId])).rows[0];
      if (!c) throw new HttpError(422, 'Cliente inválido.');
      const lines = await priceItems(db, a, b.customer_id, b.items);
      const until = b.valid_until ?? new Date(Date.now() + b.valid_days * 86400000).toISOString().slice(0, 10);
      const number = await nextNumber(db, a.companyId, 'quote');
      const q = (await db.query(
        `insert into quotes (company_id, branch_id, number, customer_id, seller_id, valid_until, payment_condition, lead_time_days, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [a.companyId, a.branchId, number, b.customer_id, a.userId, until, b.payment_condition, b.lead_time_days, b.notes])).rows[0];
      await saveItems(db, a.companyId, q.id, lines);
      await audit(db, a, 'quote', q.id, 'create', null, { number, items: lines.length });
      return q;
    });
    return reply.code(201).send(q);
  });

  app.get('/quotes', async (req) => {
    const a = can(req, 'quotes:view'); await expire(pool, a.companyId);
    const qs = req.query as Record<string, string>; const { page, pageSize, offset } = pageParams(qs);
    const params: unknown[] = [a.companyId]; let w = 'q.company_id = $1';
    if (!a.permissions.has('sales:approve')) { params.push(a.userId); w += ` and q.seller_id = $${params.length}`; }
    if (qs.status) { params.push(qs.status); w += ` and q.status = $${params.length}`; }
    if (qs.q?.trim()) { params.push(qs.q.trim()); w += ` and (q.number::text = $${params.length} or unaccent(c.legal_name) ilike unaccent('%' || $${params.length} || '%'))`; }
    const from = `from quotes q join customers c on c.id = q.customer_id join users u on u.id = q.seller_id where ${w}`;
    const [items, total] = await Promise.all([
      pool.query(`select q.*, c.legal_name as customer_name, u.name as seller_name ${from} order by q.number desc limit ${pageSize} offset ${offset}`, params),
      pool.query(`select count(*)::int n ${from}`, params)]);
    return { items: items.rows, total: total.rows[0].n, page, pageSize };
  });

  const load = async (a: Auth, id: string) => {
    await expire(pool, a.companyId);
    const params: unknown[] = [id, a.companyId]; let w = '';
    if (!a.permissions.has('sales:approve')) { params.push(a.userId); w = ' and q.seller_id = $3'; }
    const q = (await pool.query(`select q.*, c.legal_name as customer_name, c.whatsapp, c.phone from quotes q join customers c on c.id = q.customer_id where q.id = $1 and q.company_id = $2${w}`, params)).rows[0];
    if (!q) throw new HttpError(404, 'Orçamento não encontrado.');
    return q;
  };

  app.get('/quotes/:id', async (req) => {
    const a = can(req, 'quotes:view'); const id = (req.params as { id: string }).id;
    const q = await load(a, id);
    const items = (await pool.query(`select i.*, p.sku, p.description from quote_items i join products p on p.id = i.product_id where i.quote_id = $1 order by p.description`, [id])).rows;
    const { public_token_hash: _h, ...safe } = q;
    return { ...safe, items };
  });

  app.patch('/quotes/:id', async (req) => {
    const a = can(req, 'quotes:edit'); const id = (req.params as { id: string }).id;
    const b = quoteSchema.partial().parse(req.body);
    const q = await load(a, id);
    if (q.status !== 'rascunho') throw new HttpError(409, 'Somente rascunhos podem ser editados.');
    return tx(async (db) => {
      const set: Record<string, unknown> = {};
      if (b.valid_until) set.valid_until = b.valid_until; else if (b.valid_days) set.valid_until = new Date(Date.now() + b.valid_days * 86400000).toISOString().slice(0, 10);
      for (const k of ['payment_condition', 'lead_time_days', 'notes'] as const) if (b[k] !== undefined) set[k] = b[k];
      const cols = Object.keys(set);
      if (cols.length) await db.query(`update quotes set ${cols.map((c, i) => `${c} = $${i + 2}`).join(',')} where id = $1`, [id, ...cols.map((c) => set[c])]);
      if (b.items) await saveItems(db, a.companyId, id, await priceItems(db, a, q.customer_id, b.items));
      await audit(db, a, 'quote', id, 'update', null, { ...set, items: b.items?.length });
      return { ok: true };
    });
  });

  app.delete('/quotes/:id', async (req) => {
    const a = can(req, 'quotes:delete'); const id = (req.params as { id: string }).id;
    const q = await load(a, id);
    if (q.status !== 'rascunho') throw new HttpError(409, 'Somente rascunhos podem ser excluídos.');
    await pool.query('delete from quotes where id = $1', [id]); await audit(pool, a, 'quote', id, 'delete', { number: q.number }, null);
    return { deleted: true };
  });

  /** Gera (ou renova) o link público de aprovação; só o hash do token fica no banco. */
  app.post('/quotes/:id/send', async (req) => {
    const a = can(req, 'quotes:edit'); const id = (req.params as { id: string }).id;
    const q = await load(a, id);
    if (['convertido', 'recusado', 'expirado'].includes(q.status)) throw new HttpError(409, `Orçamento ${q.status}.`);
    const token = newToken();
    await pool.query(`update quotes set public_token_hash = $2, status = case when status in ('rascunho','enviado','visualizado') then 'enviado' else status end, sent_at = now() where id = $1`, [id, sha256(token)]);
    await audit(pool, a, 'quote', id, 'send', { status: q.status }, { status: 'enviado' });
    const link = `${config.publicUrl}/orcamento/${token}`;
    return { link, whatsapp_url: waLink(q.whatsapp ?? q.phone, `Olá! Segue o orçamento nº ${q.number}. Para aprovar, acesse: ${link}`) };
  });

  app.post('/quotes/:id/convert', async (req, reply) => {
    const a = can(req, 'sales:create'); can(req, 'quotes:view');
    const id = (req.params as { id: string }).id; await load(a, id);
    return reply.code(201).send(await tx((db) => convertQuote(db, a, id)));
  });

  app.post('/quotes/:id/refuse', async (req) => {
    const a = can(req, 'quotes:edit'); const id = (req.params as { id: string }).id; const q = await load(a, id);
    if (['convertido', 'recusado'].includes(q.status)) throw new HttpError(409, `Orçamento ${q.status}.`);
    await pool.query(`update quotes set status = 'recusado', decided_at = now() where id = $1`, [id]);
    await audit(pool, a, 'quote', id, 'refuse', { status: q.status }, { status: 'recusado' });
    return { status: 'recusado' };
  });

  // ---- Link público (sem login): visualizar, aprovar (→ pedido) ou recusar
  const pub = { config: { public: true, rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const byToken = async (token: string) => {
    const q = (await pool.query(`select q.*, co.trade_name, co.legal_name as company_name, c.legal_name as customer_name from quotes q join companies co on co.id = q.company_id join customers c on c.id = q.customer_id where q.public_token_hash = $1`, [sha256(token)])).rows[0];
    if (!q) throw new HttpError(404, 'Link inválido ou expirado.');
    await expire(pool, q.company_id);
    q.status = (await pool.query('select status from quotes where id = $1', [q.id])).rows[0].status;
    return q;
  };
  app.get('/public/quotes/:token', pub, async (req) => {
    const q = await byToken((req.params as { token: string }).token);
    if (q.status === 'enviado') { await pool.query(`update quotes set status = 'visualizado', viewed_at = now() where id = $1`, [q.id]); q.status = 'visualizado'; }
    const items = (await pool.query(`select p.sku, p.description, i.qty, i.unit_price, i.total from quote_items i join products p on p.id = i.product_id where i.quote_id = $1 order by p.description`, [q.id])).rows;
    return { number: q.number, company: q.trade_name ?? q.company_name, customer: q.customer_name, status: q.status, valid_until: q.valid_until, payment_condition: q.payment_condition,
      lead_time_days: q.lead_time_days, notes: q.notes, total: q.total, discount_total: q.discount_total, items };
  });
  app.post('/public/quotes/:token/approve', pub, async (req) => {
    const q = await byToken((req.params as { token: string }).token);
    if (q.status === 'convertido') return { status: 'convertido', message: 'Este orçamento já foi aprovado.' };
    if (['recusado', 'expirado'].includes(q.status)) throw new HttpError(409, `Orçamento ${q.status}.`);
    await pool.query(`update quotes set status = 'aprovado', decided_at = now() where id = $1`, [q.id]);
    try {
      const sale = await tx(async (db) => convertQuote(db, await authForUser(db, q.seller_id, q.branch_id), q.id));
      await audit(pool, await authForUser(pool, q.seller_id, q.branch_id), 'quote', q.id, 'customer_approved', null, { sale_number: sale.number, via: 'link público' });
      return { status: 'convertido', message: 'Orçamento aprovado! Seu pedido foi gerado.', order_number: sale.number };
    } catch (e) {
      if (e instanceof HttpError && e.code === 'insufficient_stock') return { status: 'aprovado', message: 'Orçamento aprovado. Vamos confirmar a disponibilidade e retornar o contato.' };
      throw e;
    }
  });
  app.post('/public/quotes/:token/reject', pub, async (req) => {
    const q = await byToken((req.params as { token: string }).token);
    if (['convertido', 'recusado', 'expirado'].includes(q.status)) throw new HttpError(409, `Orçamento ${q.status}.`);
    await pool.query(`update quotes set status = 'recusado', decided_at = now() where id = $1`, [q.id]);
    return { status: 'recusado' };
  });
}
