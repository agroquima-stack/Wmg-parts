import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { can, requireAuth } from '../auth.js';
import { idleAnalysis, stockSummary } from './stock.js';

export async function searchApplications(companyId: string, raw: string) {
  const tokens = raw.split(/\s+/).filter(Boolean).slice(0, 8);
  if (!tokens.length) return { items: [] as Array<Record<string, any>>, interpreted: { terms: [] as string[], year: null as number | null } };
  let year: number | null = null; const words: string[] = [];
  for (const t of tokens) {
    if (/^\d{4}$/.test(t) && +t >= 1950 && +t <= 2100 && year == null) year = +t; else words.push(t);
  }
  const params: unknown[] = [companyId]; const conds: string[] = [];
    for (const w of words) {
      params.push(`%${w}%`);
      conds.push(`unaccent(concat_ws(' ', p.description, p.commercial_description, p.sku, p.manufacturer_code, p.original_code, b.name, c.name,
        vm.make, vm.model, vm.version, pa.system, pa.position)) ilike unaccent($${params.length})`);
    }
    if (year != null) {
      params.push(year);
      conds.push(`pa.id is not null and $${params.length} between coalesce(pa.year_from, vm.year_from) and coalesce(pa.year_to, vm.year_to, 2100)`);
    }
    const rows = await pool.query(
      `select p.id, p.sku, p.description, p.manufacturer_code, p.original_code, p.sale_price, p.active, b.name as brand_name,
              coalesce(json_agg(distinct jsonb_build_object('make', vm.make, 'model', vm.model, 'version', vm.version,
                'system', pa.system, 'position', pa.position,
                'year_from', coalesce(pa.year_from, vm.year_from), 'year_to', coalesce(pa.year_to, vm.year_to)))
                filter (where pa.id is not null), '[]') as applications
         from products p
         left join brands b on b.id = p.brand_id
         left join categories c on c.id = p.category_id
         left join product_applications pa on pa.product_id = p.id
         left join vehicle_models vm on vm.id = pa.vehicle_model_id
        where p.company_id = $1 and p.active ${conds.length ? 'and ' + conds.join(' and ') : ''}
        group by p.id, b.name order by p.description limit 100`, params);
  return { items: rows.rows as Array<Record<string, any>>, interpreted: { terms: words, year } };
}

export async function searchRoutes(app: FastifyInstance) {
  /**
   * Busca por aplicação: "Pastilha CG 160 2020".
   * Cada termo precisa casar com produto/marca/categoria/códigos OU com a moto/sistema/posição;
   * um termo de 4 dígitos entre 1950 e 2100 vira filtro de ano contra o intervalo da aplicação.
   */
  app.get('/search/applications', async (req) => {
    const a = can(req, 'products:view');
    return searchApplications(a.companyId, String((req.query as Record<string, string>).q ?? '').trim());
  });

  /** Busca global: produtos (inclui códigos e EAN), clientes, fornecedores — filtrado por permissão. */
  app.get('/search/global', async (req) => {
    const a = requireAuth(req);
    const q = String((req.query as Record<string, string>).q ?? '').trim();
    if (q.length < 2) return { results: [] };
    const like = `%${q}%`; const out: Array<Record<string, unknown>> = [];
    if (a.permissions.has('products:view')) {
      const r = await pool.query(
        `select id, sku, description, manufacturer_code from products t where company_id = $1 and (
           unaccent(description) ilike unaccent($2) or sku ilike $2 or internal_code ilike $2 or manufacturer_code ilike $2 or original_code ilike $2
           or exists (select 1 from product_barcodes pb where pb.product_id = t.id and pb.barcode = $3)) order by description limit 8`, [a.companyId, like, q]);
      out.push(...r.rows.map((x) => ({ type: 'product', id: x.id, title: x.description, subtitle: `SKU ${x.sku}${x.manufacturer_code ? ' · ' + x.manufacturer_code : ''}` })));
    }
    if (a.permissions.has('customers:view')) {
      const r = await pool.query(`select id, legal_name, document, city from customers where company_id = $1 and (unaccent(legal_name) ilike unaccent($2) or unaccent(coalesce(trade_name,'')) ilike unaccent($2) or document like $2) order by legal_name limit 6`, [a.companyId, like]);
      out.push(...r.rows.map((x) => ({ type: 'customer', id: x.id, title: x.legal_name, subtitle: [x.document, x.city].filter(Boolean).join(' · ') })));
    }
    if (a.permissions.has('suppliers:view')) {
      const r = await pool.query(`select id, legal_name, cnpj, city from suppliers where company_id = $1 and (unaccent(legal_name) ilike unaccent($2) or unaccent(coalesce(trade_name,'')) ilike unaccent($2) or cnpj like $2) order by legal_name limit 6`, [a.companyId, like]);
      out.push(...r.rows.map((x) => ({ type: 'supplier', id: x.id, title: x.legal_name, subtitle: [x.cnpj, x.city].filter(Boolean).join(' · ') })));
    }
    return { results: out };
  });

  /**
   * Resumo da Fase 1: apenas indicadores que existem hoje (cadastros e saúde dos dados).
   * KPIs de vendas/estoque/financeiro entram nas fases seguintes, sempre derivados do banco.
   */
  app.get('/dashboard/summary', async (req) => {
    const a = requireAuth(req);
    const c = a.companyId;
    const one = async (sql: string) => (await pool.query(sql, [c])).rows[0];
    const counts = await one(`select
      (select count(*)::int from products where company_id = $1 and active) as products_active,
      (select count(*)::int from products where company_id = $1 and not active) as products_inactive,
      (select count(*)::int from customers where company_id = $1 and status = 'ativo') as customers_active,
      (select count(*)::int from suppliers where company_id = $1 and active) as suppliers_active,
      (select count(*)::int from brands where company_id = $1 and active) as brands,
      (select count(*)::int from vehicle_models where company_id = $1 and active) as vehicle_models`);
    const alertsQ = await one(`select
      (select count(*)::int from products where company_id = $1 and active and sale_price > 0 and cost_current > 0
         and (sale_price - cost_current) / sale_price * 100 < min_margin_pct) as below_min_margin,
      (select count(*)::int from products where company_id = $1 and active and sale_price = 0) as without_price,
      (select count(*)::int from products where company_id = $1 and active and (ncm is null)) as without_ncm,
      (select count(*)::int from products p where company_id = $1 and active and not exists (select 1 from product_applications where product_id = p.id)) as without_application,
      (select count(*)::int from customers where company_id = $1 and status = 'bloqueado') as customers_blocked`);
    const alerts: Array<{ level: 'red' | 'yellow'; text: string }> = [];
    if (alertsQ.below_min_margin) alerts.push({ level: 'red', text: `${alertsQ.below_min_margin} produtos com margem atual abaixo da margem mínima.` });
    if (alertsQ.without_price) alerts.push({ level: 'yellow', text: `${alertsQ.without_price} produtos ativos sem preço de venda.` });
    if (alertsQ.without_ncm) alerts.push({ level: 'yellow', text: `${alertsQ.without_ncm} produtos ativos sem NCM (necessário para emissão fiscal).` });
    if (alertsQ.without_application) alerts.push({ level: 'yellow', text: `${alertsQ.without_application} produtos ativos sem aplicação em moto.` });
    if (alertsQ.customers_blocked) alerts.push({ level: 'red', text: `${alertsQ.customers_blocked} clientes bloqueados.` });
    let stock = null;
    if (a.permissions.has('stock:view')) {
      stock = await stockSummary(c, null);
      const idle = await idleAnalysis(c, null);
      const old = idle.filter((b) => ['181-360', '+360'].includes(b.bucket));
      const idleValue = old.reduce((s, b) => s + Number(b.cost_value), 0);
      const idle180 = { value: idleValue, products: old.reduce((s, b) => s + b.products, 0) };
      stock = { ...stock, idle180 };
      if (stock.out_of_stock) alerts.unshift({ level: 'red', text: `${stock.out_of_stock} produtos sem estoque disponível.` });
      if (stock.below_min) alerts.unshift({ level: 'red', text: `${stock.below_min} produtos estão abaixo do estoque mínimo.` });
      if (idleValue > 0) alerts.push({ level: 'yellow', text: `R$ ${idleValue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} parados em estoque há mais de 180 dias.` });
      if (stock.excess) alerts.push({ level: 'yellow', text: `${stock.excess} produtos acima do estoque máximo.` });
    }
    let commercial = null;
    if (a.permissions.has('sales:view')) {
      const own = a.permissions.has('sales:approve') ? '' : ` and seller_id = '${a.userId}'`;   // id vem da sessão (uuid), nunca do cliente
      const k = (await pool.query(`select
        coalesce(sum(total) filter (where confirmed_at::date = current_date),0)::numeric(14,2) as revenue_day,
        coalesce(sum(total) filter (where date_trunc('month', confirmed_at) = date_trunc('month', now())),0)::numeric(14,2) as revenue_month,
        count(*) filter (where date_trunc('month', confirmed_at) = date_trunc('month', now()))::int as sales_month,
        coalesce(sum(margin_total) filter (where date_trunc('month', confirmed_at) = date_trunc('month', now())),0)::numeric(14,2) as margin_month,
        coalesce(sum(commission_amount) filter (where date_trunc('month', confirmed_at) = date_trunc('month', now())),0)::numeric(14,2) as commission_month
        from sales where company_id = $1 and status = 'concluida'${own}`, [c])).rows[0];
      const bySeller = (await pool.query(`select u.name, sum(s.total)::numeric(14,2) as revenue, sum(s.margin_total)::numeric(14,2) as margin, count(*)::int as sales
        from sales s join users u on u.id = s.seller_id where s.company_id = $1 and s.status = 'concluida' and date_trunc('month', s.confirmed_at) = date_trunc('month', now())${own.replace('seller_id', 's.seller_id')}
        group by u.name order by revenue desc`, [c])).rows;
      const byChannel = (await pool.query(`select channel, sum(total)::numeric(14,2) as revenue, count(*)::int as sales from sales where company_id = $1 and status = 'concluida'
        and date_trunc('month', confirmed_at) = date_trunc('month', now())${own} group by channel order by revenue desc`, [c])).rows;
      const goal = Number((await pool.query(`select value->>'monthly' as m from company_settings where company_id = $1 and key = 'goal'`, [c])).rows[0]?.m ?? 0);
      const pending = a.permissions.has('sales:approve') ? (await pool.query(`select count(*)::int n from sale_approvals where company_id = $1 and status = 'pendente'`, [c])).rows[0].n : 0;
      const expiring = (await pool.query(`select count(*)::int n from quotes where company_id = $1 and status in ('enviado','visualizado') and valid_until between current_date and current_date + 2${own.replace('seller_id', 'seller_id')}`, [c])).rows[0].n;
      commercial = { ...k, avg_ticket: k.sales_month ? Math.round(Number(k.revenue_month) / k.sales_month * 100) / 100 : 0,
        margin_pct: Number(k.revenue_month) > 0 ? Math.round(Number(k.margin_month) / Number(k.revenue_month) * 10000) / 100 : null,
        goal, goal_pct: goal > 0 ? Math.round(Number(k.revenue_month) / goal * 1000) / 10 : null, by_seller: bySeller, by_channel: byChannel, pending_approvals: pending, quotes_expiring: expiring };
      if (pending) alerts.unshift({ level: 'red', text: `${pending} venda(s) aguardando aprovação de desconto/margem.` });
      if (expiring) alerts.push({ level: 'yellow', text: `${expiring} orçamento(s) expiram nos próximos 2 dias.` });
    }
    let purchasing = null;
    if (a.permissions.has('purchases:view')) {
      const k = (await pool.query(`select
        (select count(*)::int from purchase_orders where company_id = $1 and status = 'aguardando_aprovacao') as awaiting_approval,
        (select count(*)::int from purchase_orders where company_id = $1 and status in ('aprovado','enviado','parcial') and expected_date < current_date) as late_orders,
        (select count(*)::int from purchase_orders where company_id = $1 and status in ('aprovado','enviado','parcial')) as open_orders,
        (select count(*)::int from receivings where company_id = $1 and status = 'em_conferencia') as receivings_open,
        coalesce((select sum(amount) from payables where company_id = $1 and kind = 'titulo' and status = 'aberto' and due_date between current_date and current_date + 7),0)::numeric(14,2) as payables_7d,
        coalesce((select sum(amount) from payables where company_id = $1 and kind = 'titulo' and status = 'aberto' and due_date < current_date),0)::numeric(14,2) as payables_overdue`, [c])).rows[0];
      purchasing = k;
      if (k.awaiting_approval) alerts.unshift({ level: 'yellow', text: `${k.awaiting_approval} pedido(s) de compra aguardando aprovação.` });
      if (k.late_orders) alerts.push({ level: 'red', text: `${k.late_orders} pedido(s) de compra com entrega atrasada.` });
      if (k.receivings_open) alerts.push({ level: 'yellow', text: `${k.receivings_open} recebimento(s) aguardando conferência.` });
      if (Number(k.payables_overdue) > 0) alerts.unshift({ level: 'red', text: `R$ ${Number(k.payables_overdue).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} em contas a pagar vencidas.` });
      if (Number(k.payables_7d) > 0) alerts.push({ level: 'yellow', text: `R$ ${Number(k.payables_7d).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} em contas a pagar vencem nos próximos 7 dias.` });
    }
    return { counts, alerts, stock, commercial, purchasing };
  });
}
