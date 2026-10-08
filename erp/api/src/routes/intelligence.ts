import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { can, HttpError } from '../auth.js';
import { audit } from '../audit.js';
import { ask, criticalCoverage, EXAMPLES, forecastProduct, getRuleConfig, recommendations, RULES, runAlerts } from '../intelligence.js';

const lastRun = new Map<string, number>(); // atualiza os alertas sozinho quando a última execução tem mais de 5 minutos
async function refreshIfStale(companyId: string) {
  if (Date.now() - (lastRun.get(companyId) ?? 0) < 5 * 60 * 1000) return; lastRun.set(companyId, Date.now()); await runAlerts(pool, companyId);
}

export async function intelligenceRoutes(app: FastifyInstance) {
  app.get('/alerts', async (req) => {
    const a = can(req, 'alerts:view'); const q = z.object({ status: z.enum(['abertos', 'resolvido', 'adiado', 'todos']).default('abertos'), severity: z.enum(['critico', 'atencao', 'info']).optional(), rule: z.string().optional() }).parse(req.query);
    await refreshIfStale(a.companyId);
    const where = ['company_id = $1']; const p: unknown[] = [a.companyId];
    if (q.status === 'abertos') where.push(`status in ('aberto','reconhecido')`); else if (q.status !== 'todos') { p.push(q.status); where.push(`status = $${p.length}`); }
    if (q.severity) { p.push(q.severity); where.push(`severity = $${p.length}`); } if (q.rule) { p.push(q.rule); where.push(`rule_key = $${p.length}`); }
    const items = (await pool.query(`select a.*, u.name as handled_by_name from alerts a left join users u on u.id = a.handled_by where ${where.join(' and ').replace(/\b(company_id|status|severity|rule_key)\b/g, 'a.$1')} order by case a.severity when 'critico' then 0 when 'atencao' then 1 else 2 end, a.last_seen desc limit 300`, p)).rows;
    return { summary: await summary(a.companyId), items };
  });
  const summary = async (companyId: string) => {
    const r = (await pool.query(`select count(*) filter (where severity = 'critico')::int as critico, count(*) filter (where severity = 'atencao')::int as atencao, count(*) filter (where severity = 'info')::int as info, count(*) filter (where status = 'aberto')::int as novos from alerts where company_id = $1 and status in ('aberto','reconhecido')`, [companyId])).rows[0];
    return { ...r, total: r.critico + r.atencao + r.info };
  };
  app.get('/alerts/summary', async (req) => { const a = can(req, 'alerts:view'); await refreshIfStale(a.companyId); return summary(a.companyId); });
  app.post('/alerts/run', async (req) => { const a = can(req, 'alerts:view'); lastRun.set(a.companyId, Date.now()); return { ...(await runAlerts(pool, a.companyId)), summary: await summary(a.companyId) }; });
  const act = (path: string, status: string, body: z.ZodTypeAny) => app.post(path, async (req) => {
    const a = can(req, 'alerts:edit'); const id = (req.params as { id: string }).id; const b = body.parse(req.body ?? {}) as { note?: string; days?: number };
    const before = (await pool.query('select * from alerts where id = $1 and company_id = $2', [id, a.companyId])).rows[0]; if (!before) throw new HttpError(404, 'Alerta não encontrado.');
    if (before.status === 'resolvido') throw new HttpError(409, 'Alerta já resolvido automaticamente: o problema não existe mais.');
    const until = status === 'adiado' ? new Date(Date.now() + (b.days ?? 7) * 86400000).toISOString().slice(0, 10) : null;
    const r = await pool.query(`update alerts set status = $3, snoozed_until = $4, handled_by = $5, handled_at = now(), note = coalesce($6, note) where id = $1 and company_id = $2 returning *`, [id, a.companyId, status, until, a.userId, b.note ?? null]);
    await audit(pool, a, 'alert', id, status, { status: before.status }, { status, until, note: b.note }); return r.rows[0];
  });
  act('/alerts/:id/ack', 'reconhecido', z.object({ note: z.string().max(500).optional() }));
  act('/alerts/:id/snooze', 'adiado', z.object({ days: z.coerce.number().int().min(1).max(90).default(7), note: z.string().max(500).optional() }));
  act('/alerts/:id/reopen', 'aberto', z.object({}));

  app.get('/alerts/rules', async (req) => { const a = can(req, 'alerts:view'); return getRuleConfig(pool, a.companyId); });
  app.put('/alerts/rules/:key', async (req) => {
    const a = can(req, 'alerts:edit'); const key = (req.params as { key: string }).key; const rule = RULES.find((r) => r.key === key); if (!rule) throw new HttpError(404, 'Regra não encontrada.');
    const b = z.object({ enabled: z.boolean(), params: z.record(z.string(), z.coerce.number()).default({}) }).parse(req.body);
    const params: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.params)) { const d = rule.params[k]; if (!d) throw new HttpError(422, `Parâmetro desconhecido: ${k}.`); if (v < d.min || v > d.max) throw new HttpError(422, `${d.label}: informe entre ${d.min} e ${d.max}.`); params[k] = v; }
    await pool.query(`insert into alert_rules (company_id, rule_key, enabled, params, updated_by) values ($1,$2,$3,$4,$5) on conflict (company_id, rule_key) do update set enabled = excluded.enabled, params = excluded.params, updated_by = excluded.updated_by, updated_at = now()`, [a.companyId, key, b.enabled, params, a.userId]);
    await audit(pool, a, 'alert_rule', key, 'update', null, b); lastRun.delete(a.companyId); return (await getRuleConfig(pool, a.companyId)).find((r) => r.key === key);
  });

  app.get('/ai/forecast', async (req) => { const a = can(req, 'ai:view'); const q = z.object({ product_id: z.string().uuid(), weeks: z.coerce.number().int().min(1).max(26).default(8) }).parse(req.query); const r = await forecastProduct(pool, a.companyId, q.product_id, q.weeks); if (!r) throw new HttpError(404, 'Produto não encontrado.'); return r; });
  app.get('/ai/coverage', async (req) => { const a = can(req, 'ai:view'); return criticalCoverage(a.companyId, 25); });
  app.get('/ai/recommendations', async (req) => { const a = can(req, 'ai:view'); return recommendations(pool, a.companyId); });
  app.get('/ai/examples', async (req) => { can(req, 'ai:view'); return EXAMPLES; });
  app.post('/ai/ask', async (req) => { const a = can(req, 'ai:view'); const b = z.object({ question: z.string().trim().min(3).max(300) }).parse(req.body); return ask(pool, a.companyId, a.userId, b.question); });
}
