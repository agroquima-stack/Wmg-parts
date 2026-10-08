import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { can, HttpError } from '../auth.js';
import { audit } from '../audit.js';
import { assertRefs } from '../crud.js';
import { commercial, costEvolution, executive, financeBi, purchasingBi, stockBi } from '../bi.js';

const date = z.string().date();
const today = () => new Date().toISOString().slice(0, 10);
const period = z.object({ from: date.default(today().slice(0, 7) + '-01'), to: date.default(today()), compare: z.enum(['previous', 'year', 'none']).default('previous') });
const KINDS = ['faturamento', 'margem_bruta_pct', 'ticket_medio', 'giro_estoque', 'cobertura_dias_max', 'inadimplencia_max_pct'] as const;
export const GOAL_INFO: Record<(typeof KINDS)[number], { label: string; unit: string; scopes: string[]; hint: string }> = {
  faturamento: { label: 'Faturamento mensal', unit: 'R$', scopes: ['company', 'seller'], hint: 'Meta de vendas por mês (geral ou por vendedor)' },
  margem_bruta_pct: { label: 'Margem bruta mínima', unit: '%', scopes: ['company'], hint: '(receita − CMV) ÷ receita' },
  ticket_medio: { label: 'Ticket médio', unit: 'R$', scopes: ['company'], hint: 'Valor médio por venda' },
  giro_estoque: { label: 'Giro de estoque (vezes/ano)', unit: 'x', scopes: ['company', 'category'], hint: 'Quanto maior, melhor' },
  cobertura_dias_max: { label: 'Cobertura máxima de estoque', unit: 'dias', scopes: ['company', 'category'], hint: 'Acima disso há excesso' },
  inadimplencia_max_pct: { label: 'Inadimplência máxima', unit: '%', scopes: ['company'], hint: 'Vencido ÷ contas a receber em aberto' },
};

export async function biRoutes(app: FastifyInstance) {
  app.get('/bi/executive', async (req) => { const a = can(req, 'bi:view'); return executive(pool, a.companyId); });
  app.get('/bi/commercial', async (req) => {
    const a = can(req, 'bi:view'); const q = period.extend({ branch_id: z.string().uuid().optional(), channel: z.string().optional(), decline_pct: z.coerce.number().min(1).max(100).optional(), decline_min_base: z.coerce.number().min(0).optional() }).parse(req.query);
    if (q.from > q.to) throw new HttpError(422, 'Período inválido.'); return commercial(pool, a.companyId, { from: q.from, to: q.to, compare: q.compare }, q);
  });
  app.get('/bi/stock', async (req) => { const a = can(req, 'bi:view'); const q = z.object({ branch_id: z.string().uuid().optional() }).parse(req.query); return stockBi(pool, a.companyId, q); });
  app.get('/bi/purchasing', async (req) => { const a = can(req, 'bi:view'); const q = period.extend({ compare: z.enum(['previous', 'year', 'none']).default('none') }).parse({ ...(req.query as object), from: (req.query as any).from ?? new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10) }); return purchasingBi(pool, a.companyId, q); });
  app.get('/bi/purchasing/cost-evolution', async (req) => { const a = can(req, 'bi:view'); const { product_id } = z.object({ product_id: z.string().uuid() }).parse(req.query); return costEvolution(pool, a.companyId, product_id); });
  app.get('/bi/finance', async (req) => { const a = can(req, 'bi:view'); return financeBi(pool, a.companyId); });

  // ---- Metas: estrutura pronta, valores ajustáveis pelo gestor (padrão para todos os meses ou por mês)
  app.get('/bi/goals', async (req) => {
    const a = can(req, 'bi:view');
    const r = await pool.query(`select g.*, g.month::text as month_txt, case g.scope_type when 'seller' then (select name from users where id = g.scope_id) when 'category' then (select name from categories where id = g.scope_id) end as scope_name from goals g where g.company_id = $1 order by g.kind, g.scope_type, g.month nulls first`, [a.companyId]);
    return { kinds: GOAL_INFO, items: r.rows.map(({ month, ...x }) => ({ ...x, month: x.month_txt, month_txt: undefined })) };
  });
  app.put('/bi/goals', async (req) => {
    const a = can(req, 'bi:edit');
    const b = z.object({ kind: z.enum(KINDS), scope_type: z.enum(['company', 'seller', 'category']).default('company'), scope_id: z.string().uuid().nullish().transform((v) => v ?? null), month: z.string().regex(/^\d{4}-\d{2}(-01)?$/).nullish().transform((v) => (v ? v.slice(0, 7) + '-01' : null)), target: z.coerce.number().min(0).max(1e10) }).parse(req.body);
    if (!GOAL_INFO[b.kind].scopes.includes(b.scope_type)) throw new HttpError(422, `A meta "${GOAL_INFO[b.kind].label}" não aceita escopo ${b.scope_type}.`);
    if ((b.scope_type === 'company') !== (b.scope_id == null)) throw new HttpError(422, 'Informe o vendedor/categoria da meta (ou deixe vazio para meta geral).');
    if (b.scope_id) await assertRefs(pool, a.companyId, { scope_id: b.scope_id }, { scope_id: b.scope_type === 'seller' ? 'users' : 'categories' });
    const r = await pool.query(`insert into goals (company_id, kind, scope_type, scope_id, month, target, updated_by) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (company_id, kind, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(month, date '1900-01-01')) do update set target = excluded.target, updated_by = excluded.updated_by, updated_at = now() returning *`,
      [a.companyId, b.kind, b.scope_type, b.scope_id, b.month, b.target, a.userId]);
    await audit(pool, a, 'goal', r.rows[0].id, 'upsert', null, b); return r.rows[0];
  });
  app.delete('/bi/goals/:id', async (req) => {
    const a = can(req, 'bi:delete'); const id = (req.params as { id: string }).id;
    const r = await pool.query('delete from goals where id = $1 and company_id = $2 returning *', [id, a.companyId]); if (!r.rowCount) throw new HttpError(404, 'Meta não encontrada.');
    await audit(pool, a, 'goal', id, 'delete', r.rows[0], null); return { deleted: true };
  });
}
