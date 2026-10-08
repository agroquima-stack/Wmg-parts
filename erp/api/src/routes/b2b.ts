import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { can, HttpError, type Auth } from '../auth.js';
import { audit } from '../audit.js';
import { assertRefs, pageParams } from '../crud.js';
import { createSale } from '../sales.js';

const itemsSchema = z.array(z.object({ product_id: z.string().uuid(), qty: z.coerce.number().positive(), discount_pct: z.coerce.number().min(0).lt(100).optional() })).min(1).max(200);

export async function customerSummary(companyId: string, customerId: string) {
  const c = (await pool.query('select id, legal_name, credit_limit, price_table, payment_condition, payment_term_days, status from customers where id = $1 and company_id = $2', [customerId, companyId])).rows[0];
  if (!c) throw new HttpError(404, 'Cliente não encontrado.');
  const s = (await pool.query(
    `select count(*)::int as sales_count, coalesce(sum(total),0)::numeric(14,2) as revenue, coalesce(avg(total),0)::numeric(14,2) as avg_ticket, coalesce(sum(margin_total),0)::numeric(14,2) as margin,
            max(confirmed_at) as last_purchase,
            coalesce(sum(total) filter (where confirmed_at > now() - interval '12 months'),0)::numeric(14,2) as revenue_12m,
            case when count(*) > 1 then round(extract(epoch from (max(confirmed_at) - min(confirmed_at))) / 86400 / (count(*) - 1)) end as avg_days_between
       from sales where company_id = $1 and customer_id = $2 and status = 'concluida'`, [companyId, customerId])).rows[0];
  const rec = (await pool.query(
    `select coalesce(sum(amount) filter (where status = 'aberto'),0)::numeric(14,2) as open_amount,
            coalesce(sum(amount) filter (where status = 'aberto' and due_date < current_date),0)::numeric(14,2) as overdue_amount,
            count(*) filter (where status = 'aberto' and due_date < current_date)::int as overdue_count
       from receivables where company_id = $1 and customer_id = $2`, [companyId, customerId])).rows[0];
  const top = (await pool.query(
    `select p.id, p.sku, p.description, sum(i.qty) as qty, sum(i.total)::numeric(14,2) as total from sale_items i join sales s on s.id = i.sale_id join products p on p.id = i.product_id
      where s.company_id = $1 and s.customer_id = $2 and s.status = 'concluida' group by p.id order by total desc limit 10`, [companyId, customerId])).rows;
  const limit = Number(c.credit_limit);
  return { customer: c, ...s, margin_pct: Number(s.revenue) > 0 ? Math.round(Number(s.margin) / Number(s.revenue) * 10000) / 100 : null,
    credit: { limit, used: Number(rec.open_amount), available: Math.max(0, limit - Number(rec.open_amount)) },
    delinquency: { overdue_amount: Number(rec.overdue_amount), overdue_count: rec.overdue_count }, top_products: top };
}

async function runRecurring(db: import('pg').PoolClient, a: Auth, id: string) {
  const r = (await db.query('select * from recurring_orders where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
  if (!r) throw new HttpError(404, 'Pedido recorrente não encontrado.');
  if (!r.active) throw new HttpError(409, 'Pedido recorrente inativo.');
  const sale = await createSale(db, a, { branchId: r.branch_id, customerId: r.customer_id, type: 'recorrente', channel: 'b2b', items: r.items, recurringId: id, sellerId: r.seller_id, notes: 'Pedido recorrente' });
  await db.query(`update recurring_orders set last_sale_id = $2, next_run = greatest(next_run, current_date) + interval_days where id = $1`, [id, sale.id]);
  await audit(db, a, 'recurring_order', id, 'run', null, { sale_number: sale.number });
  return sale;
}

export async function b2bRoutes(app: FastifyInstance) {
  app.get('/customers/:id/summary', async (req) => {
    const a = can(req, 'customers:view');
    return customerSummary(a.companyId, (req.params as { id: string }).id);
  });

  // Carteira B2B: limite, crédito usado/disponível, última compra, faturamento 12 meses
  app.get('/b2b/customers', async (req) => {
    const a = can(req, 'customers:view');
    const qs = req.query as Record<string, string>; const { page, pageSize, offset } = pageParams(qs);
    const params: unknown[] = [a.companyId]; let w = `c.company_id = $1 and c.type = 'PJ'`;
    if (qs.q?.trim()) { params.push(`%${qs.q.trim()}%`); w += ` and (unaccent(c.legal_name) ilike unaccent($2) or c.document like $2)`; }
    const r = await pool.query(
      `select c.id, c.legal_name, c.segment, c.price_table, c.payment_condition, c.status, c.credit_limit,
         coalesce((select sum(amount) from receivables where customer_id = c.id and status = 'aberto'),0) as used,
         greatest(c.credit_limit - coalesce((select sum(amount) from receivables where customer_id = c.id and status = 'aberto'),0), 0) as available,
         coalesce((select sum(amount) from receivables where customer_id = c.id and status = 'aberto' and due_date < current_date),0) as overdue,
         (select max(confirmed_at) from sales where customer_id = c.id and status = 'concluida') as last_purchase,
         coalesce((select sum(total) from sales where customer_id = c.id and status = 'concluida' and confirmed_at > now() - interval '12 months'),0) as revenue_12m
       from customers c where ${w} order by c.legal_name limit ${pageSize} offset ${offset}`, params);
    return { items: r.rows, page, pageSize };
  });

  // ---- Pedidos recorrentes
  app.get('/b2b/recurring', async (req) => {
    const a = can(req, 'sales:view');
    const r = await pool.query(`select r.*, c.legal_name as customer_name from recurring_orders r join customers c on c.id = r.customer_id where r.company_id = $1 order by r.next_run`, [a.companyId]);
    return { items: r.rows };
  });
  app.post('/b2b/recurring', async (req, reply) => {
    const a = can(req, 'sales:create');
    const b = z.object({ customer_id: z.string().uuid(), interval_days: z.coerce.number().int().min(1).max(365), next_run: z.string().date(), items: itemsSchema }).parse(req.body);
    if (!a.branchId) throw new HttpError(422, 'Selecione uma filial.');
    const row = await tx(async (db) => {
      await assertRefs(db, a.companyId, b, { customer_id: 'customers' });
      for (const i of b.items) await assertRefs(db, a.companyId, i, { product_id: 'products' });
      const r = (await db.query('insert into recurring_orders (company_id, branch_id, customer_id, seller_id, interval_days, next_run, items) values ($1,$2,$3,$4,$5,$6,$7) returning *',
        [a.companyId, a.branchId, b.customer_id, a.userId, b.interval_days, b.next_run, JSON.stringify(b.items)])).rows[0];
      await audit(db, a, 'recurring_order', r.id, 'create', null, r);
      return r;
    });
    return reply.code(201).send(row);
  });
  app.patch('/b2b/recurring/:id', async (req) => {
    const a = can(req, 'sales:edit'); const id = (req.params as { id: string }).id;
    const b = z.object({ active: z.boolean().optional(), interval_days: z.coerce.number().int().min(1).max(365).optional(), next_run: z.string().date().optional() }).parse(req.body);
    const cols = Object.keys(b) as (keyof typeof b)[]; if (!cols.length) throw new HttpError(422, 'Nada para atualizar.');
    const r = await pool.query(`update recurring_orders set ${cols.map((c, i) => `${c} = $${i + 3}`).join(',')} where id = $1 and company_id = $2 returning *`, [id, a.companyId, ...cols.map((c) => b[c])]);
    if (!r.rowCount) throw new HttpError(404, 'Pedido recorrente não encontrado.');
    await audit(pool, a, 'recurring_order', id, 'update', null, b); return r.rows[0];
  });
  app.post('/b2b/recurring/:id/run', async (req) => {
    const a = can(req, 'sales:create');
    return tx((db) => runRecurring(db, a, (req.params as { id: string }).id));
  });
  /** Gera os pedidos vencidos (data de execução ≤ hoje). Não há agendador automático nesta fase: o gestor dispara. */
  app.post('/b2b/recurring/run-due', async (req) => {
    const a = can(req, 'sales:create');
    const due = (await pool.query('select id from recurring_orders where company_id = $1 and active and next_run <= current_date', [a.companyId])).rows;
    const results = [];
    for (const d of due) {
      try { const s = await tx((db) => runRecurring(db, a, d.id)); results.push({ id: d.id, ok: true, sale_number: s.number, status: s.status }); }
      catch (e) { results.push({ id: d.id, ok: false, error: (e as Error).message }); }
    }
    return { results };
  });
}
