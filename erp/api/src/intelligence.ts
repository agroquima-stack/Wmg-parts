import { pool, type Db } from './db.js';
import { cashflow } from './finance.js';
import { commercial, goalFor } from './bi.js';
import { suggestions, type Suggestion } from './purchasing.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const todayStr = () => iso(new Date());
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s) + n * 86400000));
export const brl = (n: number) => 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// =============================================================== Alertas (motor de regras)
export type Severity = 'critico' | 'atencao' | 'info';
export interface Candidate { fingerprint: string; severity: Severity; title: string; detail?: string; link?: string; value?: number }
type Params = Record<string, number>;
export interface RuleDef {
  key: string; label: string; description: string; area: string;
  params: Record<string, { label: string; default: number; min: number; max: number }>;
  run(db: Db, companyId: string, p: Params): Promise<Candidate[]>;
}

const DISP = `select product_id, sum(qty) as d from stock_balances where company_id = $1 and status = 'disponivel' group by 1`;

export const RULES: RuleDef[] = [
  { key: 'ruptura', area: 'Estoque', label: 'Ruptura de estoque', description: 'Produto vendido nos últimos 90 dias e hoje sem saldo disponível.',
    params: { min_sold_90d: { label: 'Vendeu no mínimo (un. em 90 dias)', default: 1, min: 1, max: 1000 }, critical_units: { label: 'Crítico a partir de (un. em 90 dias)', default: 10, min: 1, max: 100000 } },
    async run(db, c, p) {
      const r = await db.query(`with sold as (select si.product_id, sum(si.qty) as q90, sum(si.total) as rev from sale_items si join sales s on s.id = si.sale_id where s.company_id = $1 and s.status = 'concluida' and s.confirmed_at >= now() - interval '90 days' group by 1), disp as (${DISP})
        select p.id, p.sku, p.description, sold.q90, sold.rev from products p join sold on sold.product_id = p.id left join disp on disp.product_id = p.id
        where p.company_id = $1 and p.active and coalesce(disp.d, 0) <= 0 and sold.q90 >= $2 order by sold.rev desc limit 50`, [c, p.min_sold_90d]);
      return r.rows.map((x) => ({ fingerprint: `ruptura:${x.id}`, severity: Number(x.q90) >= p.critical_units ? 'critico' : 'atencao', title: `Sem estoque: ${x.sku} — ${x.description}`, detail: `Vendeu ${Number(x.q90)} un. em 90 dias (${brl(Number(x.rev))}) e está zerado.`, link: '/compras/sugestao', value: Number(x.rev) }) as Candidate);
    } },
  { key: 'abaixo_minimo', area: 'Estoque', label: 'Abaixo do estoque mínimo', description: 'Saldo disponível acima de zero, porém abaixo do mínimo cadastrado.',
    params: { limit: { label: 'Máximo de alertas', default: 30, min: 1, max: 200 } },
    async run(db, c, p) {
      const r = await db.query(`with disp as (${DISP}) select p.id, p.sku, p.description, p.min_stock, coalesce(disp.d,0) as d from products p left join disp on disp.product_id = p.id
        where p.company_id = $1 and p.active and p.min_stock > 0 and coalesce(disp.d,0) > 0 and coalesce(disp.d,0) < p.min_stock order by (p.min_stock - coalesce(disp.d,0)) * p.cost_avg desc limit $2`, [c, p.limit]);
      return r.rows.map((x) => ({ fingerprint: `minimo:${x.id}`, severity: 'atencao', title: `Abaixo do mínimo: ${x.sku} — ${x.description}`, detail: `Disponível ${Number(x.d)} · mínimo ${Number(x.min_stock)}.`, link: '/compras/sugestao' }) as Candidate);
    } },
  { key: 'estoque_parado', area: 'Estoque', label: 'Dinheiro parado em estoque', description: 'Valor (a custo médio) de itens sem saída há muitos dias.',
    params: { days: { label: 'Sem saída há (dias)', default: 180, min: 30, max: 720 }, min_value: { label: 'Alertar a partir de (R$)', default: 1000, min: 0, max: 1e9 } },
    async run(db, c, p) {
      const r = (await db.query(`with bal as (select product_id, sum(qty) as q from stock_balances where company_id = $1 and status in ('disponivel','reservado','quarentena','avariado') group by 1),
        last as (select product_id, max(created_at) filter (where type = 'saida') as lo, min(created_at) as fi from stock_movements where company_id = $1 group by 1)
        select count(*)::int as n, coalesce(sum(bal.q * p.cost_avg),0) as val from products p join bal on bal.product_id = p.id left join last on last.product_id = p.id
        where p.company_id = $1 and p.active and bal.q > 0 and coalesce(last.lo, last.fi, now()) < now() - ($2::int * interval '1 day')`, [c, p.days])).rows[0];
      return Number(r.val) >= p.min_value && r.n > 0 ? [{ fingerprint: 'parado', severity: 'atencao', title: `${brl(Number(r.val))} parados em ${r.n} item(ns) sem saída há mais de ${p.days} dias`, detail: 'Avalie promoção, kit ou devolução ao fornecedor.', link: '/estoque/analises', value: Number(r.val) }] : [];
    } },
  { key: 'margem_baixa', area: 'Comercial', label: 'Venda abaixo da margem mínima', description: 'Produto vendido, no período, com margem bruta abaixo da mínima do cadastro.',
    params: { days: { label: 'Janela (dias)', default: 30, min: 7, max: 365 } },
    async run(db, c, p) {
      const r = await db.query(`select p.id, p.sku, p.description, p.min_margin_pct, sum(i.total) as revenue, sum(i.total - i.qty * i.unit_cost) / nullif(sum(i.total),0) * 100 as m
        from sale_items i join sales s on s.id = i.sale_id join products p on p.id = i.product_id where s.company_id = $1 and s.status = 'concluida' and s.confirmed_at >= now() - ($2::int * interval '1 day')
        group by p.id having p.min_margin_pct > 0 and sum(i.total - i.qty * i.unit_cost) / nullif(sum(i.total),0) * 100 < p.min_margin_pct order by sum(i.total) desc limit 30`, [c, p.days]);
      return r.rows.map((x) => ({ fingerprint: `margem:${x.id}`, severity: Number(x.m) < 0 ? 'critico' : 'atencao', title: `Margem de ${r1(Number(x.m))}% (mín. ${Number(x.min_margin_pct)}%): ${x.sku}`, detail: `${x.description} — faturou ${brl(Number(x.revenue))} em ${p.days} dias.`, link: '/precificacao', value: Number(x.revenue) }) as Candidate);
    } },
  { key: 'meta_faturamento', area: 'Comercial', label: 'Meta de faturamento em risco', description: 'Projeção do mês abaixo da meta (só existe se houver meta cadastrada).',
    params: { min_day: { label: 'Avaliar a partir do dia', default: 10, min: 1, max: 28 }, tolerance_pct: { label: 'Tolerância (% abaixo da meta)', default: 10, min: 0, max: 90 } },
    async run(db, c, p) {
      const t = todayStr(), day = Number(t.slice(8)), month = t.slice(0, 7) + '-01';
      if (day < p.min_day) return [];
      const goal = await goalFor(db, c, 'faturamento', 'company', null, month); if (!goal) return [];
      const rev = Number((await db.query(`select coalesce(sum(total),0) as v from sales where company_id = $1 and status = 'concluida' and confirmed_at::date between $2 and $3`, [c, month, t])).rows[0].v);
      const dim = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7), 0)).getUTCDate(); const proj = rev / day * dim;
      return proj < goal * (1 - p.tolerance_pct / 100) ? [{ fingerprint: `meta:${month}`, severity: 'atencao', title: `Projeção do mês ${brl(proj)} contra meta de ${brl(goal)}`, detail: `Faturado até hoje: ${brl(rev)} (${r1(rev / goal * 100)}% da meta). Projeção linear, é estimativa.`, link: '/bi/comercial', value: proj - goal }] : [];
    } },
  { key: 'margem_geral', area: 'Comercial', label: 'Margem bruta abaixo da meta', description: 'Margem dos últimos 30 dias menor que a meta (só existe se houver meta cadastrada).',
    params: {},
    async run(db, c) {
      const goal = await goalFor(db, c, 'margem_bruta_pct', 'company', null, todayStr().slice(0, 7) + '-01'); if (goal == null) return [];
      const r = (await db.query(`select coalesce(sum(total),0) as rev, coalesce(sum(cost_total),0) as cost from sales where company_id = $1 and status = 'concluida' and confirmed_at >= now() - interval '30 days'`, [c])).rows[0];
      const rev = Number(r.rev); if (rev <= 0) return []; const m = (rev - Number(r.cost)) / rev * 100;
      return m < goal ? [{ fingerprint: 'margem_geral', severity: 'atencao', title: `Margem bruta de ${r1(m)}% nos últimos 30 dias (meta ${goal}%)`, link: '/bi/comercial', value: r1(m - goal) }] : [];
    } },
  { key: 'cliente_queda', area: 'Comercial', label: 'Cliente comprando menos', description: 'Queda relevante frente aos 30 dias anteriores.',
    params: { decline_pct: { label: 'Queda mínima (%)', default: 30, min: 5, max: 100 }, min_base: { label: 'Base mínima (R$)', default: 500, min: 0, max: 1e9 } },
    async run(db, c, p) {
      const t = todayStr(); const r = await commercial(db, c, { from: addDays(t, -29), to: t, compare: 'previous' }, { decline_pct: p.decline_pct, decline_min_base: p.min_base });
      return r.declining_customers.items.slice(0, 15).map((x: any) => ({ fingerprint: `queda:${x.id}`, severity: 'atencao', title: `${x.name} reduziu compras em ${Math.abs(x.variation_pct)}%`, detail: `Antes ${brl(x.prev_revenue)} → agora ${brl(x.revenue)}. Vale um contato do vendedor.`, link: '/bi/comercial', value: x.lost }) as Candidate);
    } },
  { key: 'inadimplencia', area: 'Financeiro', label: 'Cliente com títulos vencidos', description: 'Cliente com título vencido além da tolerância.',
    params: { days: { label: 'Vencido há mais de (dias)', default: 7, min: 1, max: 365 }, critical_days: { label: 'Crítico após (dias)', default: 60, min: 1, max: 720 } },
    async run(db, c, p) {
      const r = await db.query(`select cu.id, cu.legal_name as name, sum(r.amount - coalesce(r.paid_amount,0)) as owed, max(current_date - r.due_date)::int as days, count(*)::int as n
        from receivables r join customers cu on cu.id = r.customer_id where r.company_id = $1 and r.status in ('aberto','parcial') and r.due_date < current_date - $2::int
        group by cu.id, cu.legal_name order by owed desc limit 40`, [c, p.days]);
      return r.rows.map((x) => ({ fingerprint: `inad:${x.id}`, severity: x.days > p.critical_days ? 'critico' : 'atencao', title: `${x.name} deve ${brl(Number(x.owed))} (${x.n} título(s), até ${x.days} dias de atraso)`, detail: 'Cobrança na tela Contas a receber; considere bloquear novos pedidos.', link: '/financeiro/receber', value: Number(x.owed) }) as Candidate);
    } },
  { key: 'contas_pagar', area: 'Financeiro', label: 'Contas a pagar vencidas ou a vencer', description: 'Títulos de fornecedores vencidos ou vencendo nos próximos dias.',
    params: { ahead_days: { label: 'Avisar vencimentos em (dias)', default: 3, min: 1, max: 30 } },
    async run(db, c, p) {
      const r = (await db.query(`select count(*) filter (where due_date < current_date)::int as vn, coalesce(sum(amount - coalesce(paid_amount,0)) filter (where due_date < current_date),0) as vv,
        count(*) filter (where due_date between current_date and current_date + $2::int)::int as sn, coalesce(sum(amount - coalesce(paid_amount,0)) filter (where due_date between current_date and current_date + $2::int),0) as sv
        from payables where company_id = $1 and status in ('aberto','parcial') and kind = 'titulo'`, [c, p.ahead_days])).rows[0]; const out: Candidate[] = [];
      if (r.vn > 0) out.push({ fingerprint: 'pagar:vencidas', severity: 'critico', title: `${r.vn} conta(s) a pagar vencida(s): ${brl(Number(r.vv))}`, detail: 'Multa e juros correm. Priorize a baixa.', link: '/financeiro/pagar', value: Number(r.vv) });
      if (r.sn > 0) out.push({ fingerprint: 'pagar:vencendo', severity: 'atencao', title: `${r.sn} conta(s) vencem em até ${p.ahead_days} dia(s): ${brl(Number(r.sv))}`, link: '/financeiro/pagar', value: Number(r.sv) });
      return out;
    } },
  { key: 'caixa_negativo', area: 'Financeiro', label: 'Caixa projetado negativo', description: 'Saldo projetado (com atraso e inadimplência históricos) fica negativo nos próximos 30 dias.',
    params: {},
    async run(db, c) {
      const f = await cashflow(db, c, 30); if (!f.negative_from) return [];
      return [{ fingerprint: 'caixa:negativo', severity: 'critico', title: `Caixa projetado fica negativo em ${f.negative_from} (menor saldo ${brl(f.min_projected_balance.value)})`, detail: `Projeção com confiança ${f.projection.confidence}; é estimativa, não garantia. Antecipe recebíveis ou renegocie pagamentos.`, link: '/financeiro/fluxo', value: f.min_projected_balance.value }];
    } },
  { key: 'conciliacao', area: 'Financeiro', label: 'Extrato sem conciliar', description: 'Linhas de extrato importadas e ainda pendentes.',
    params: { days: { label: 'Pendente há mais de (dias)', default: 7, min: 1, max: 90 } },
    async run(db, c, p) {
      const r = (await db.query(`select count(*)::int as n from bank_statement_lines where company_id = $1 and status = 'pendente' and line_date < current_date - $2::int`, [c, p.days])).rows[0];
      return r.n > 0 ? [{ fingerprint: 'conciliacao', severity: 'info', title: `${r.n} linha(s) do extrato pendentes há mais de ${p.days} dias`, link: '/financeiro/conciliacao', value: r.n }] : [];
    } },
  { key: 'fornecedor_aumento', area: 'Compras', label: 'Fornecedor aumentou preço', description: 'Último preço pago acima da média dos 180 dias anteriores.',
    params: { pct: { label: 'Aumento mínimo (%)', default: 5, min: 1, max: 500 } },
    async run(db, c, p) {
      const r = await db.query(`with last as (select distinct on (supplier_id, product_id) supplier_id, product_id, price, created_at from supplier_prices where company_id = $1 order by supplier_id, product_id, created_at desc),
        prev as (select sp.supplier_id, sp.product_id, avg(sp.price) as avgp from supplier_prices sp join last l on l.supplier_id = sp.supplier_id and l.product_id = sp.product_id
          where sp.company_id = $1 and sp.created_at < l.created_at and sp.created_at >= l.created_at - interval '180 days' group by 1, 2)
        select s.legal_name as sup, s.id as sid, p.id as pid, p.sku, l.price, prev.avgp, (l.price / prev.avgp - 1) * 100 as pct from last l join prev on prev.supplier_id = l.supplier_id and prev.product_id = l.product_id
        join suppliers s on s.id = l.supplier_id join products p on p.id = l.product_id where prev.avgp > 0 and (l.price / prev.avgp - 1) * 100 >= $2 and l.created_at >= now() - interval '90 days' order by pct desc limit 30`, [c, p.pct]);
      return r.rows.map((x) => ({ fingerprint: `preco:${x.sid}:${x.pid}`, severity: 'atencao', title: `${x.sup} subiu ${r1(Number(x.pct))}% em ${x.sku}`, detail: `Último ${brl(Number(x.price))} contra média anterior ${brl(Number(x.avgp))}. Compare fornecedores.`, link: '/compras/precos', value: r1(Number(x.pct)) }) as Candidate);
    } },
  { key: 'aprovacoes', area: 'Comercial', label: 'Aprovações de venda paradas', description: 'Pedidos aguardando aprovação do gestor.',
    params: { hours: { label: 'Parado há mais de (horas)', default: 24, min: 1, max: 720 } },
    async run(db, c, p) {
      const r = (await db.query(`select count(*)::int as n from sale_approvals where company_id = $1 and status = 'pendente' and requested_at < now() - ($2::int * interval '1 hour')`, [c, p.hours])).rows[0];
      return r.n > 0 ? [{ fingerprint: 'aprov:pendentes', severity: 'atencao', title: `${r.n} aprovação(ões) de venda aguardando há mais de ${p.hours}h`, link: '/aprovacoes', value: r.n }] : [];
    } },
  { key: 'fiscal', area: 'Fiscal', label: 'Notas fiscais com problema', description: 'Notas rejeitadas ou rascunhos parados.',
    params: { draft_days: { label: 'Rascunho parado há (dias)', default: 2, min: 1, max: 60 } },
    async run(db, c, p) {
      const r = (await db.query(`select count(*) filter (where status = 'rejeitada')::int as rej, count(*) filter (where status = 'rascunho' and created_at < now() - ($2::int * interval '1 day'))::int as dra from fiscal_documents where company_id = $1`, [c, p.draft_days])).rows[0]; const out: Candidate[] = [];
      if (r.rej > 0) out.push({ fingerprint: 'fiscal:rejeitadas', severity: 'critico', title: `${r.rej} nota(s) fiscal(is) rejeitada(s)`, detail: 'Corrija e reenvie.', link: '/fiscal/notas', value: r.rej });
      if (r.dra > 0) out.push({ fingerprint: 'fiscal:rascunhos', severity: 'info', title: `${r.dra} nota(s) em rascunho há mais de ${p.draft_days} dia(s)`, link: '/fiscal/notas', value: r.dra });
      return out;
    } },
];
const RULE_MAP = new Map(RULES.map((r) => [r.key, r]));

export async function getRuleConfig(db: Db, companyId: string) {
  const saved = new Map((await db.query('select rule_key, enabled, params from alert_rules where company_id = $1', [companyId])).rows.map((x) => [x.rule_key, x]));
  return RULES.map((r) => {
    const s = saved.get(r.key); const values: Params = {};
    for (const [k, d] of Object.entries(r.params)) { const v = s?.params?.[k]; values[k] = typeof v === 'number' && v >= d.min && v <= d.max ? v : d.default; }
    return { key: r.key, label: r.label, description: r.description, area: r.area, enabled: s ? s.enabled : true, params: r.params, values };
  });
}

/** Executa as regras, abre/atualiza alertas e resolve sozinho os que deixaram de acontecer. */
export async function runAlerts(db: Db, companyId: string) {
  const cfg = await getRuleConfig(db, companyId); const t = todayStr();
  const res = { opened: 0, updated: 0, resolved: 0, errors: [] as string[] };
  await db.query(`update alerts set status = 'aberto', snoozed_until = null where company_id = $1 and status = 'adiado' and snoozed_until < $2`, [companyId, t]);
  for (const c of cfg) {
    if (!c.enabled) { res.resolved += (await db.query(`update alerts set status = 'resolvido', resolved_at = now() where company_id = $1 and rule_key = $2 and status <> 'resolvido'`, [companyId, c.key])).rowCount ?? 0; continue; }
    let cands: Candidate[];
    try { cands = await RULE_MAP.get(c.key)!.run(db, companyId, c.values); } catch (e) { res.errors.push(`${c.key}: ${(e as Error).message}`); continue; }
    for (const x of cands) {
      const r = await db.query(`insert into alerts (company_id, rule_key, fingerprint, severity, title, detail, link, value) values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (company_id, fingerprint) do update set severity = excluded.severity, title = excluded.title, detail = excluded.detail, link = excluded.link, value = excluded.value, last_seen = now(),
          status = case when alerts.status = 'resolvido' then 'aberto' else alerts.status end, first_seen = case when alerts.status = 'resolvido' then now() else alerts.first_seen end,
          resolved_at = case when alerts.status = 'resolvido' then null else alerts.resolved_at end, handled_by = case when alerts.status = 'resolvido' then null else alerts.handled_by end
        returning (xmax = 0) as inserted`, [companyId, c.key, x.fingerprint, x.severity, x.title.slice(0, 300), x.detail ?? null, x.link ?? null, x.value ?? null]);
      if (r.rows[0].inserted) res.opened++; else res.updated++;
    }
    res.resolved += (await db.query(`update alerts set status = 'resolvido', resolved_at = now() where company_id = $1 and rule_key = $2 and status <> 'resolvido' and not (fingerprint = any($3))`, [companyId, c.key, cands.map((x) => x.fingerprint)])).rowCount ?? 0;
  }
  return res;
}

// =============================================================== Previsão de demanda
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
/** Média móvel ponderada (semanas recentes pesam mais) + tendência linear amortecida. Sem sazonalidade: só com 24+ meses de histórico. */
export function forecastSeries(weekly: number[], weeks: number) {
  const n = weekly.length; const w = weekly.map((_, i) => i + 1); const wsum = w.reduce((a, b) => a + b, 0);
  const wma = weekly.reduce((a, v, i) => a + v * w[i], 0) / wsum;
  const mx = (n - 1) / 2, my = mean(weekly); let num = 0, den = 0; weekly.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
  const slope = den ? num / den : 0; const damp = my > 0 ? Math.max(-0.5 * my, Math.min(0.5 * my, slope * 4)) : 0; // limita o efeito da tendência a ±50% da média
  const out = Array.from({ length: weeks }, (_, i) => Math.max(0, wma + damp * Math.min(1, (i + 1) / 4)));
  const sd = Math.sqrt(mean(weekly.map((v) => (v - my) ** 2)));
  return { wma, slope, trend_pct: my > 0 ? r1(damp / my * 100) : 0, forecast: out, cv: my > 0 ? sd / my : null };
}

export async function forecastProduct(db: Db, companyId: string, productId: string, weeks = 8) {
  const p = (await db.query('select id, sku, description, cost_avg, min_stock from products where id = $1 and company_id = $2', [productId, companyId])).rows[0]; if (!p) return null;
  const monday = (d: string) => { const x = new Date(Date.parse(d)); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return iso(x); };
  const thisWeek = monday(todayStr()); const start = addDays(thisWeek, -12 * 7);
  const rows = (await db.query(`select (date_trunc('week', s.confirmed_at))::date::text as wk, sum(si.qty) as q, count(distinct s.id)::int as orders from sale_items si join sales s on s.id = si.sale_id
    where si.product_id = $1 and s.company_id = $2 and s.status = 'concluida' and s.confirmed_at::date >= $3 and s.confirmed_at::date < $4 group by 1`, [productId, companyId, start, thisWeek])).rows;
  const m = new Map(rows.map((x) => [x.wk, Number(x.q)])); const history = Array.from({ length: 12 }, (_, i) => { const wk = addDays(start, i * 7); return { week: wk, qty: m.get(wk) ?? 0 }; });
  const orders = rows.reduce((a, x) => a + x.orders, 0); const weeksWith = history.filter((h) => h.qty > 0).length;
  const first = (await db.query(`select min(s.confirmed_at)::date::text as d from sales s where s.company_id = $1 and s.status = 'concluida'`, [companyId])).rows[0].d as string | null;
  const dataWeeks = first ? Math.floor((Date.parse(thisWeek) - Date.parse(first)) / (7 * 86400000)) : 0;
  const f = forecastSeries(history.map((h) => h.qty), weeks);
  const disp = Number((await db.query(`select coalesce(sum(qty),0) as d from stock_balances where company_id = $1 and product_id = $2 and status = 'disponivel'`, [companyId, productId])).rows[0].d);
  const avgDaily = f.wma / 7; const cover = avgDaily > 0 ? r1(disp / avgDaily) : null;
  const confidence: 'baixa' | 'média' | 'alta' = dataWeeks < 8 || weeksWith < 4 ? 'baixa' : weeksWith >= 8 && orders >= 15 ? 'alta' : 'média';
  const note = confidence === 'baixa' ? `Pouco histórico (${weeksWith} de 12 semanas com venda${dataWeeks < 8 ? `, base de dados com ${dataWeeks} semanas` : ''}). Trate como ordem de grandeza.` : f.cv != null && f.cv > 1 ? 'Demanda irregular: use margem de segurança.' : 'Demanda regular nas últimas semanas.';
  const next = Array.from({ length: weeks }, (_, i) => ({ week: addDays(thisWeek, i * 7), qty: r1(f.forecast[i]) }));
  let sug: Suggestion | undefined; try { sug = (await suggestions(companyId, null, null)).find((x) => x.product_id === productId); } catch { /* sugestão é opcional aqui */ }
  return { product: { id: p.id, sku: p.sku, description: p.description }, method: 'média móvel ponderada de 12 semanas com tendência amortecida (sem sazonalidade)', history, forecast: next,
    avg_daily: r2(avgDaily), trend_pct: f.trend_pct, available: disp, coverage_days: cover, stockout_date: cover != null ? addDays(todayStr(), Math.floor(cover)) : null,
    suggested_qty: sug?.suggested_qty ?? null, supplier: sug?.supplier_name ?? null, confidence, note };
}

/** Itens com cobertura curta, vindos da sugestão de compra (mesmo motor, mesma confiança). */
export async function criticalCoverage(companyId: string, limit = 20) {
  const s = (await suggestions(companyId, null, null)).filter((x) => x.avg_daily > 0 && x.coverage_days != null).sort((a, b) => (a.coverage_days! - b.coverage_days!)).slice(0, limit);
  return s.map((x) => ({ product_id: x.product_id, sku: x.sku, description: x.description, abc: x.abc, available: x.disponivel, avg_daily: x.avg_daily, coverage_days: x.coverage_days, lead_time_days: x.lead_time_days, suggested_qty: x.suggested_qty, supplier: x.supplier_name, confidence: x.confidence }));
}

// =============================================================== Recomendações (ações sugeridas, com a base de cada uma)
export interface Recommendation { kind: string; title: string; detail: string; impact: number | null; link: string; basis: string }
export async function recommendations(db: Db, companyId: string): Promise<Recommendation[]> {
  const out: Recommendation[] = [];
  const sug = (await suggestions(companyId, null, null)).filter((x) => x.suggested_qty > 0).sort((a, b) => (a.abc === b.abc ? (a.coverage_days ?? 9999) - (b.coverage_days ?? 9999) : a.abc.localeCompare(b.abc))).slice(0, 8);
  for (const x of sug) out.push({ kind: 'comprar', title: `Comprar ${x.suggested_qty} un. de ${x.sku}`, detail: `${x.description}. ${x.coverage_days != null ? `Cobertura ${x.coverage_days} dia(s), p` : 'P'}razo do fornecedor ${x.lead_time_days} dia(s)${x.supplier_name ? `, sugestão: ${x.supplier_name}` : ''}.`, impact: x.est_cost != null ? r2(x.est_cost * x.suggested_qty) : null, link: '/compras/sugestao', basis: `Sugestão de compra — curva ${x.abc}, confiança ${x.confidence}. ${x.basis}` });
  const idle = await db.query(`with bal as (select product_id, sum(qty) as q from stock_balances where company_id = $1 and status = 'disponivel' group by 1), last as (select product_id, max(created_at) filter (where type = 'saida') as lo, min(created_at) as fi from stock_movements where company_id = $1 group by 1)
    select p.sku, p.description, bal.q, p.cost_avg, p.min_price, p.sale_price, extract(day from now() - coalesce(last.lo, last.fi))::int as days from products p join bal on bal.product_id = p.id left join last on last.product_id = p.id
    where p.company_id = $1 and p.active and bal.q > 0 and coalesce(last.lo, last.fi, now()) < now() - interval '180 days' order by bal.q * p.cost_avg desc limit 5`, [companyId]);
  for (const x of idle.rows) out.push({ kind: 'liquidar', title: `Girar ${x.sku}: parado há ${x.days} dias`, detail: `${x.description}: ${Number(x.q)} un. (${brl(Number(x.q) * Number(x.cost_avg))} a custo). Promoção possível até o preço mínimo ${brl(Number(x.min_price))} (hoje ${brl(Number(x.sale_price))}).`, impact: r2(Number(x.q) * Number(x.cost_avg)), link: '/estoque/analises', basis: 'Sem saída há mais de 180 dias. Preço mínimo vem do cadastro; confirme a margem antes de promover.' });
  const low = await db.query(`select p.sku, p.description, p.min_margin_pct, p.target_margin_pct, p.cost_avg, sum(i.total) as rev, avg(i.unit_price) as avg_price, sum(i.total - i.qty * i.unit_cost) / nullif(sum(i.total),0) * 100 as m
    from sale_items i join sales s on s.id = i.sale_id join products p on p.id = i.product_id where s.company_id = $1 and s.status = 'concluida' and s.confirmed_at >= now() - interval '30 days'
    group by p.id having p.min_margin_pct > 0 and sum(i.total - i.qty * i.unit_cost) / nullif(sum(i.total),0) * 100 < p.min_margin_pct order by sum(i.total) desc limit 5`, [companyId]);
  for (const x of low.rows) { const tgt = Number(x.target_margin_pct) || Number(x.min_margin_pct); const np = Number(x.cost_avg) / (1 - tgt / 100); out.push({ kind: 'preco', title: `Rever preço de ${x.sku}`, detail: `${x.description}: margem ${r1(Number(x.m))}% (mínima ${Number(x.min_margin_pct)}%). Para ${tgt}% sobre o custo médio atual o preço seria ${brl(np)} (média praticada ${brl(Number(x.avg_price))}).`, impact: null, link: '/precificacao', basis: 'Vendas dos últimos 30 dias × custo médio atual. Considere impostos e a concorrência antes de reajustar.' }); }
  const debt = await db.query(`select cu.legal_name as name, sum(r.amount - coalesce(r.paid_amount,0)) as owed, max(current_date - r.due_date)::int as days from receivables r join customers cu on cu.id = r.customer_id where r.company_id = $1 and r.status in ('aberto','parcial') and r.due_date < current_date group by cu.id, cu.legal_name order by owed desc limit 3`, [companyId]);
  for (const x of debt.rows) out.push({ kind: 'cobrar', title: `Cobrar ${x.name}`, detail: `${brl(Number(x.owed))} vencidos, até ${x.days} dia(s) de atraso.`, impact: Number(x.owed), link: '/financeiro/receber', basis: 'Contas a receber vencidas.' });
  return out;
}

// =============================================================== Pergunte à Empresa (sem IA externa)
// Interpretador por regras: reconhece a intenção, executa uma consulta FIXA e responde com a origem do número. O que não entende, diz que não entende.
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export interface Answer { intent: string | null; answer: string; table?: { columns: string[]; rows: (string | number)[][] }; source?: string; link?: string; note?: string }

function parsePeriod(q: string): { from: string; to: string; label: string } {
  const t = todayStr(); let m: RegExpMatchArray | null;
  if (/\bhoje\b/.test(q)) return { from: t, to: t, label: 'hoje' };
  if (/\bontem\b/.test(q)) { const y = addDays(t, -1); return { from: y, to: y, label: 'ontem' }; }
  if ((m = q.match(/ultimos? (\d{1,3}) dias/))) return { from: addDays(t, -(+m[1] - 1)), to: t, label: `nos últimos ${m[1]} dias` };
  if (/semana/.test(q)) return { from: addDays(t, -6), to: t, label: 'nos últimos 7 dias' };
  if (/mes (passado|anterior)/.test(q)) { const d = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 2, 1)); const e = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, 0)); return { from: iso(d), to: iso(e), label: 'no mês passado' }; }
  if (/(este|esse|neste|nesse|atual|no) mes|mes atual/.test(q)) return { from: t.slice(0, 7) + '-01', to: t, label: 'neste mês' };
  if (/\bano\b/.test(q)) return { from: t.slice(0, 4) + '-01-01', to: t, label: 'neste ano' };
  return { from: addDays(t, -29), to: t, label: 'nos últimos 30 dias' };
}
const SALES_W = `s.company_id = $1 and s.status = 'concluida' and s.confirmed_at::date between $2 and $3`;
const tbl = (columns: string[], rows: (string | number)[][]) => ({ columns, rows });

interface Intent { key: string; test: (q: string) => boolean; run(db: Db, companyId: string, q: string, raw: string): Promise<Answer> }
const INTENTS: Intent[] = [
  { key: 'alertas', test: (q) => /alerta|urgente|atencao|problema|pendenc|o que (esta )?errado/.test(q), async run(db, c) {
      await runAlerts(db, c); const r = (await db.query(`select severity, title, link from alerts where company_id = $1 and status in ('aberto','reconhecido') order by case severity when 'critico' then 0 when 'atencao' then 1 else 2 end, last_seen desc limit 10`, [c])).rows;
      return { intent: 'alertas', answer: r.length ? `Há ${r.length}${r.length === 10 ? '+' : ''} alerta(s) em aberto; os mais importantes estão abaixo.` : 'Nenhum alerta em aberto no momento.', table: r.length ? tbl(['Gravidade', 'Alerta'], r.map((x) => [x.severity, x.title])) : undefined, source: 'central de alertas (regras configuráveis)', link: '/alertas' }; } },
  { key: 'cliente_queda', test: (q) => /cliente/.test(q) && /(menos|queda|reduz|parou|deixou|diminu|cair)/.test(q), async run(db, c) {
      const t = todayStr(); const r = await commercial(db, c, { from: addDays(t, -29), to: t, compare: 'previous' }, {}); const it = r.declining_customers.items;
      return { intent: 'cliente_queda', answer: it.length ? `${it.length} cliente(s) com queda de ${r.declining_customers.threshold_pct}% ou mais nos últimos 30 dias frente aos 30 anteriores.` : 'Nenhum cliente com queda relevante nos últimos 30 dias.', table: it.length ? tbl(['Cliente', 'Antes', 'Agora', 'Variação'], it.map((x: any) => [x.name, brl(x.prev_revenue), brl(x.revenue), `${x.variation_pct}%`])) : undefined, source: 'vendas concluídas por cliente, período × período anterior (base mínima R$ 500)', link: '/bi/comercial' }; } },
  { key: 'inadimplencia', test: (q) => /inadimpl|devendo|deve |atrasad|vencid.*receb|receb.*vencid|calote/.test(q) || /(quem|clientes?).*(deve|pagou|pagam)/.test(q), async run(db, c) {
      const r = (await db.query(`select cu.legal_name as name, sum(r.amount - coalesce(r.paid_amount,0)) as owed, max(current_date - r.due_date)::int as days from receivables r join customers cu on cu.id = r.customer_id where r.company_id = $1 and r.status in ('aberto','parcial') and r.due_date < current_date group by cu.id, cu.legal_name order by owed desc limit 10`, [c])).rows;
      const tot = (await db.query(`select coalesce(sum(amount - coalesce(paid_amount,0)) filter (where due_date < current_date),0) as ven, coalesce(sum(amount - coalesce(paid_amount,0)),0) as aberto from receivables where company_id = $1 and status in ('aberto','parcial')`, [c])).rows[0];
      return { intent: 'inadimplencia', answer: Number(tot.ven) > 0 ? `${brl(Number(tot.ven))} vencidos de ${brl(Number(tot.aberto))} em aberto (${Number(tot.aberto) ? r1(Number(tot.ven) / Number(tot.aberto) * 100) : 0}%).` : `Nada vencido. Em aberto a receber: ${brl(Number(tot.aberto))}.`, table: r.length ? tbl(['Cliente', 'Vencido', 'Maior atraso (dias)'], r.map((x) => [x.name, brl(Number(x.owed)), x.days])) : undefined, source: 'contas a receber em aberto com vencimento anterior a hoje', link: '/financeiro/receber' }; } },
  { key: 'impostos', test: (q) => /imposto|\bdas\b|simples|tribut/.test(q), async run(db, c) {
      const m = todayStr().slice(0, 7); const r = (await db.query(`select coalesce(sum(total),0) as rev, coalesce(sum(tax_amount),0) as tax from sales where company_id = $1 and status = 'concluida' and to_char(confirmed_at,'YYYY-MM') = $2`, [c, m])).rows[0];
      return { intent: 'impostos', answer: `Imposto estimado sobre as vendas de ${m}: ${brl(Number(r.tax))} sobre faturamento de ${brl(Number(r.rev))}. É estimativa; o valor oficial vem do PGDAS-D.`, source: 'DAS estimado nas vendas concluídas do mês (alíquota efetiva configurada)', link: '/fiscal/impostos' }; } },
  { key: 'pagar', test: (q) => /a pagar|contas a pagar|pagaremos|vamos pagar|devemos|fornecedores? .*(pagar|devendo)/.test(q), async run(db, c) {
      const r = (await db.query(`select coalesce(sum(amount - coalesce(paid_amount,0)) filter (where due_date < current_date),0) as ven, coalesce(sum(amount - coalesce(paid_amount,0)) filter (where due_date between current_date and current_date + 7),0) as s7, coalesce(sum(amount - coalesce(paid_amount,0)) filter (where due_date between current_date and current_date + 30),0) as s30, coalesce(sum(amount - coalesce(paid_amount,0)),0) as tot from payables where company_id = $1 and status in ('aberto','parcial') and kind = 'titulo'`, [c])).rows[0];
      return { intent: 'pagar', answer: `A pagar: ${brl(Number(r.tot))} no total — vencido ${brl(Number(r.ven))}, próximos 7 dias ${brl(Number(r.s7))}, próximos 30 dias ${brl(Number(r.s30))}.`, source: 'contas a pagar em aberto', link: '/financeiro/pagar' }; } },
  { key: 'caixa', test: (q) => /caixa|saldo|banco|30.*60.*90|projecao|dinheiro (em|no) (banco|caixa)/.test(q), async run(db, c) {
      const f = await cashflow(db, c, 90); const at = (d: number) => { const k = addDays(todayStr(), d); return (f.series.find((s: any) => s.bucket === k) ?? f.series[f.series.length - 1]).balance_projected; };
      return { intent: 'caixa', answer: `Saldo hoje ${brl(f.opening_balance)}. Projetado: 30 dias ${brl(at(30))}, 60 dias ${brl(at(60))}, 90 dias ${brl(at(90))} (confiança ${f.projection.confidence}).${f.negative_from ? ` Atenção: fica negativo a partir de ${f.negative_from}.` : ''}`, source: 'saldos bancários + títulos a receber/pagar, com atraso e inadimplência históricos (estimativa)', link: '/financeiro/fluxo', note: 'Projeção é estimativa, não garantia.' }; } },
  { key: 'parado', test: (q) => /parad|sem giro|encalhad|obsolet|dinheiro parado|sem sair|nao (gira|vende)/.test(q), async run(db, c) {
      const r = (await db.query(`with bal as (select product_id, sum(qty) as q from stock_balances where company_id = $1 and status in ('disponivel','reservado','quarentena','avariado') group by 1), last as (select product_id, max(created_at) filter (where type = 'saida') as lo, min(created_at) as fi from stock_movements where company_id = $1 group by 1)
        select p.sku, p.description, bal.q, bal.q * p.cost_avg as val, extract(day from now() - coalesce(last.lo, last.fi))::int as days from products p join bal on bal.product_id = p.id left join last on last.product_id = p.id where p.company_id = $1 and p.active and bal.q > 0 and coalesce(last.lo, last.fi, now()) < now() - interval '90 days' order by val desc limit 10`, [c])).rows;
      const tot = (await db.query(`with bal as (select product_id, sum(qty) as q from stock_balances where company_id = $1 and status in ('disponivel','reservado','quarentena','avariado') group by 1), last as (select product_id, max(created_at) filter (where type = 'saida') as lo, min(created_at) as fi from stock_movements where company_id = $1 group by 1)
        select count(*)::int as n, coalesce(sum(bal.q * p.cost_avg),0) as val from products p join bal on bal.product_id = p.id left join last on last.product_id = p.id where p.company_id = $1 and p.active and bal.q > 0 and coalesce(last.lo, last.fi, now()) < now() - interval '90 days'`, [c])).rows[0];
      return { intent: 'parado', answer: tot.n ? `${brl(Number(tot.val))} (a custo médio) em ${tot.n} item(ns) sem saída há mais de 90 dias.` : 'Nenhum item sem saída há mais de 90 dias.', table: r.length ? tbl(['Produto', 'Qtd', 'Valor a custo', 'Dias sem saída'], r.map((x) => [`${x.sku} — ${x.description}`, Number(x.q), brl(Number(x.val)), x.days])) : undefined, source: 'saldo × custo médio dos itens sem movimento de saída', link: '/estoque/analises' }; } },
  { key: 'comprar', test: (q) => /comprar|reposicao|reabastec|pedir ao fornecedor|precisa(mos)? repor/.test(q), async run(db, c) {
      const s = (await suggestions(c, null, null)).filter((x) => x.suggested_qty > 0).slice(0, 10); const tot = s.reduce((a, x) => a + (x.est_cost ?? 0) * x.suggested_qty, 0);
      return { intent: 'comprar', answer: s.length ? `${s.length} item(ns) para repor (top 10 abaixo), estimado ${brl(tot)}.` : 'Nada para comprar agora.', table: s.length ? tbl(['Produto', 'Disponível', 'Sugerido', 'Fornecedor', 'Confiança'], s.map((x) => [`${x.sku} — ${x.description}`, x.disponivel, x.suggested_qty, x.supplier_name ?? '—', x.confidence])) : undefined, source: 'sugestão de compra (estoque, mínimo, venda média 90 dias, curva ABC, pedidos pendentes, prazo)', link: '/compras/sugestao', note: 'Estimativa com nível de confiança.' }; } },
  { key: 'ruptura', test: (q) => /falta|sem estoque|ruptura|zerad|acabou|acabando|faltando/.test(q), async run(db, c) {
      const r = await RULE_MAP.get('ruptura')!.run(db, c, { min_sold_90d: 1, critical_units: 10 });
      return { intent: 'ruptura', answer: r.length ? `${r.length} produto(s) vendidos nos últimos 90 dias estão sem saldo disponível.` : 'Nenhum produto com giro está sem estoque.', table: r.length ? tbl(['Produto', 'Detalhe'], r.slice(0, 10).map((x) => [x.title.replace('Sem estoque: ', ''), x.detail ?? ''])) : undefined, source: 'vendas dos últimos 90 dias × saldo disponível', link: '/compras/sugestao' }; } },
  { key: 'estoque', test: (q) => /estoque|armazen/.test(q) && /(quanto|valor|temos|total)/.test(q), async run(db, c) {
      const r = (await db.query(`select coalesce(sum(b.qty * p.cost_avg),0) as val, coalesce(sum(b.qty),0) as qty, count(distinct b.product_id)::int as items from stock_balances b join products p on p.id = b.product_id where b.company_id = $1 and b.status in ('disponivel','reservado','quarentena','avariado') and b.qty > 0`, [c])).rows[0];
      return { intent: 'estoque', answer: `Estoque de ${brl(Number(r.val))} ao custo médio: ${Number(r.qty)} unidades em ${r.items} item(ns).`, source: 'saldos × custo médio global', link: '/bi/estoque' }; } },
  { key: 'fornecedor', test: (q) => /fornecedor/.test(q) && /(aument|barato|caro|preco|subiu)/.test(q), async run(db, c) {
      const r = await RULE_MAP.get('fornecedor_aumento')!.run(db, c, { pct: 5 });
      return { intent: 'fornecedor', answer: r.length ? `${r.length} aumento(s) de 5% ou mais nos últimos 90 dias.` : 'Nenhum aumento relevante de fornecedor nos últimos 90 dias. Para comparar preços entre fornecedores use a tela de comparação.', table: r.length ? tbl(['Aumento', 'Detalhe'], r.slice(0, 10).map((x) => [x.title, x.detail ?? ''])) : undefined, source: 'histórico de preços por fornecedor (último × média dos 180 dias anteriores)', link: '/compras/precos' }; } },
  { key: 'margem_baixa', test: (q) => /perdendo margem|margem baixa|abaixo da margem|prejuizo|vendendo barato|margem negativa/.test(q), async run(db, c) {
      const r = await RULE_MAP.get('margem_baixa')!.run(db, c, { days: 30 });
      return { intent: 'margem_baixa', answer: r.length ? `${r.length} produto(s) vendidos abaixo da margem mínima nos últimos 30 dias.` : 'Nenhum produto vendido abaixo da margem mínima nos últimos 30 dias.', table: r.length ? tbl(['Produto', 'Detalhe'], r.slice(0, 10).map((x) => [x.title, x.detail ?? ''])) : undefined, source: 'margem realizada × margem mínima do cadastro', link: '/bi/comercial' }; } },
  { key: 'vendedor', test: (q) => /vendedor|representante/.test(q), async run(db, c, q) {
      const p = parsePeriod(q); const r = (await db.query(`select u.name, count(*)::int as n, sum(s.total) as rev, sum(s.total - s.cost_total) as gross from sales s join users u on u.id = s.seller_id where ${SALES_W} group by u.name order by rev desc limit 10`, [c, p.from, p.to])).rows;
      return { intent: 'vendedor', answer: r.length ? `${r[0].name} vendeu mais (${brl(Number(r[0].rev))}) ${p.label}.` : `Sem vendas ${p.label}.`, table: r.length ? tbl(['Vendedor', 'Vendas', 'Faturamento', 'Margem bruta'], r.map((x) => [x.name, x.n, brl(Number(x.rev)), brl(Number(x.gross))])) : undefined, source: `vendas concluídas por vendedor, ${p.label}`, link: '/bi/comercial' }; } },
  { key: 'cliente_top', test: (q) => /(melhor|maior|principal|top)s? cliente|cliente.*(mais compra|rentav|lucr|mais vend)/.test(q), async run(db, c, q) {
      const p = parsePeriod(q); const r = (await db.query(`select cu.legal_name as name, count(*)::int as n, sum(s.total) as rev, sum(s.total - s.cost_total) as gross from sales s join customers cu on cu.id = s.customer_id where ${SALES_W} group by cu.legal_name order by rev desc limit 10`, [c, p.from, p.to])).rows;
      return { intent: 'cliente_top', answer: r.length ? `${r[0].name} é o maior cliente ${p.label} (${brl(Number(r[0].rev))}).` : `Sem vendas identificadas por cliente ${p.label}.`, table: r.length ? tbl(['Cliente', 'Compras', 'Faturamento', 'Margem bruta'], r.map((x) => [x.name, x.n, brl(Number(x.rev)), brl(Number(x.gross))])) : undefined, source: `vendas concluídas por cliente, ${p.label}`, link: '/bi/comercial' }; } },
  { key: 'produto_top', test: (q) => /produto|item|peca/.test(q) && /(vend|rentav|lucr|top|mais)/.test(q), async run(db, c, q) {
      const p = parsePeriod(q); const byProfit = /rentav|lucr|margem/.test(q);
      const r = (await db.query(`select pr.sku, pr.description, sum(i.qty) as qty, sum(i.total) as rev, sum(i.total - i.qty * i.unit_cost) as gross from sale_items i join sales s on s.id = i.sale_id join products pr on pr.id = i.product_id where ${SALES_W} group by pr.id order by ${byProfit ? 'gross' : 'rev'} desc limit 10`, [c, p.from, p.to])).rows;
      return { intent: 'produto_top', answer: r.length ? `${r[0].sku} — ${r[0].description} lidera ${byProfit ? 'em margem bruta' : 'em faturamento'} (${brl(Number(byProfit ? r[0].gross : r[0].rev))}) ${p.label}.` : `Sem vendas ${p.label}.`, table: r.length ? tbl(['Produto', 'Qtd', 'Faturamento', 'Margem bruta'], r.map((x) => [`${x.sku} — ${x.description}`, Number(x.qty), brl(Number(x.rev)), brl(Number(x.gross))])) : undefined, source: `itens de vendas concluídas, ${p.label}`, link: '/bi/comercial' }; } },
  { key: 'resultado', test: (q) => /lucr|margem|resultado|ganh/.test(q), async run(db, c, q) {
      const p = parsePeriod(q); const r = (await db.query(`select count(*)::int as n, coalesce(sum(s.total),0) as rev, coalesce(sum(s.cost_total),0) as cost, coalesce(sum(s.tax_amount),0) as tax from sales s where ${SALES_W}`, [c, p.from, p.to])).rows[0];
      const rev = Number(r.rev), gross = rev - Number(r.cost);
      return { intent: 'resultado', answer: rev > 0 ? `Margem bruta ${p.label}: ${brl(gross)} (${r1(gross / rev * 100)}% do faturamento de ${brl(rev)}); após impostos estimados ${brl(gross - Number(r.tax))}. Não inclui despesas operacionais — para o lucro líquido veja a DRE.` : `Sem vendas ${p.label}.`, source: `receita − CMV (− DAS estimado) das vendas concluídas, ${p.label}`, link: '/contabil/dre' }; } },
  { key: 'faturamento', test: (q) => /vend|fatur|receita|vendemos/.test(q), async run(db, c, q) {
      const p = parsePeriod(q); const r = (await db.query(`select count(*)::int as n, coalesce(sum(s.total),0) as rev from sales s where ${SALES_W}`, [c, p.from, p.to])).rows[0];
      const ch = (await db.query(`select s.channel, count(*)::int as n, sum(s.total) as rev from sales s where ${SALES_W} group by s.channel order by rev desc`, [c, p.from, p.to])).rows;
      return { intent: 'faturamento', answer: `Faturamento ${p.label}: ${brl(Number(r.rev))} em ${r.n} venda(s)${r.n ? ` (ticket médio ${brl(Number(r.rev) / r.n)})` : ''}.`, table: ch.length ? tbl(['Canal', 'Vendas', 'Faturamento'], ch.map((x) => [x.channel, x.n, brl(Number(x.rev))])) : undefined, source: `vendas concluídas, ${p.label}`, link: '/bi/comercial' }; } },
];

export const EXAMPLES = ['Quanto vendemos este mês?', 'Qual vendedor vende mais?', 'Quais clientes estão comprando menos?', 'Quem está devendo?', 'Quanto teremos em caixa em 30/60/90 dias?', 'O que precisamos comprar?', 'Quais produtos estão sem estoque?', 'Quanto dinheiro está parado no estoque?', 'Qual produto é mais rentável?', 'Onde estamos perdendo margem?', 'Qual fornecedor aumentou o preço?', 'Quanto temos a pagar?', 'Quanto pagaremos de impostos?', 'Quando acaba o estoque do DEMO-0016?', 'Quais alertas estão abertos?'];

async function productAnswer(db: Db, companyId: string, raw: string): Promise<Answer | null> {
  const tokens = raw.toUpperCase().match(/[A-Z0-9][A-Z0-9._/-]+/g) ?? []; if (!tokens.length) return null;
  const p = (await db.query(`select id from products where company_id = $1 and active and (upper(sku) = any($2) or upper(coalesce(internal_code,'')) = any($2) or upper(coalesce(manufacturer_code,'')) = any($2)) limit 1`, [companyId, tokens])).rows[0]; if (!p) return null;
  const f = (await forecastProduct(db, companyId, p.id, 8))!; const sum = f.forecast.reduce((a, x) => a + x.qty, 0);
  return { intent: 'previsao', answer: `${f.product.sku} — ${f.product.description}: disponível ${f.available}, venda média ${f.avg_daily.toLocaleString('pt-BR')}/dia${f.coverage_days != null ? `, cobertura ${f.coverage_days.toLocaleString('pt-BR')} dia(s) (acaba por volta de ${f.stockout_date!.split('-').reverse().join('/')})` : ' (sem vendas recentes)'}. Previsão de ${sum.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} un. nas próximas 8 semanas. Confiança ${f.confidence}: ${f.note}`, table: tbl(['Semana', 'Previsto (un.)'], f.forecast.map((x) => [x.week.split('-').reverse().join('/'), x.qty.toLocaleString('pt-BR')])), source: f.method, link: '/ai', note: f.suggested_qty != null ? `Sugestão de compra: ${f.suggested_qty} un.${f.supplier ? ` (${f.supplier})` : ''}` : undefined };
}

export async function ask(db: Db, companyId: string, userId: string, raw: string): Promise<Answer> {
  const q = norm(raw).replace(/[?!.,;]/g, ' ').replace(/\s+/g, ' ').trim(); let res: Answer | null = null;
  const hasProduct = await productAnswer(db, companyId, raw);
  if (hasProduct) res = hasProduct;
  else { const it = INTENTS.find((i) => i.test(q)); if (it) res = await it.run(db, companyId, q, raw); }
  const out = res ?? { intent: null, answer: 'Não entendi a pergunta. Eu só respondo com consultas aos dados do sistema, sem inventar. Experimente uma das perguntas sugeridas abaixo (ou cite o SKU de um produto).', note: 'Perguntas sugeridas: ' + EXAMPLES.slice(0, 6).join(' · ') };
  await db.query('insert into ask_log (company_id, user_id, question, intent, answered) values ($1,$2,$3,$4,$5)', [companyId, userId, raw.slice(0, 500), out.intent, !!res]);
  return out;
}
