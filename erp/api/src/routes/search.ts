import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { can, requireAuth } from '../auth.js';
import { idleAnalysis, stockSummary } from './stock.js';

export async function searchRoutes(app: FastifyInstance) {
  /**
   * Busca por aplicação: "Pastilha CG 160 2020".
   * Cada termo precisa casar com produto/marca/categoria/códigos OU com a moto/sistema/posição;
   * um termo de 4 dígitos entre 1950 e 2100 vira filtro de ano contra o intervalo da aplicação.
   */
  app.get('/search/applications', async (req) => {
    const a = can(req, 'products:view');
    const raw = String((req.query as Record<string, string>).q ?? '').trim();
    const tokens = raw.split(/\s+/).filter(Boolean).slice(0, 8);
    if (!tokens.length) return { items: [] };
    let year: number | null = null; const words: string[] = [];
    for (const t of tokens) {
      if (/^\d{4}$/.test(t) && +t >= 1950 && +t <= 2100 && year == null) year = +t; else words.push(t);
    }
    const params: unknown[] = [a.companyId]; const conds: string[] = [];
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
    return { items: rows.rows, interpreted: { terms: words, year } };
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
    return { counts, alerts, stock };
  });
}
