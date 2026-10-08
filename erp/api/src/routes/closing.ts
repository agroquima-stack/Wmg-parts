import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { can, HttpError } from '../auth.js';
import { closePeriod, closingChecks, fingerprint, monthStart, reopenPeriod } from '../closing.js';

const periodParam = (s: string) => { if (!/^\d{4}-\d{2}$/.test(s)) throw new HttpError(422, 'Período inválido (use AAAA-MM).'); return `${s}-01`; };

export async function closingRoutes(app: FastifyInstance) {
  app.get('/accounting/periods', async (req) => {
    const a = can(req, 'accounting:view');
    const first = (await pool.query(`select min(competence)::text as m from journal_entries where company_id = $1`, [a.companyId])).rows[0].m as string | null;
    const cur = monthStart(new Date().toISOString().slice(0, 10));
    const items = (await pool.query(`select to_char(g,'YYYY-MM') as period, p.status, p.closed_at, u.name as closed_by_name, p.snapshot, p.entries_count, p.total_debits, p.checksum, p.note, p.reopened_at, p.reopen_reason, ru.name as reopened_by_name
      from generate_series(coalesce($2::date, $3::date), $3::date, interval '1 month') g left join accounting_periods p on p.company_id = $1 and p.period = g::date left join users u on u.id = p.closed_by left join users ru on ru.id = p.reopened_by order by g desc`, [a.companyId, first, cur])).rows
      .map((x) => ({ ...x, status: x.status === 'fechado' ? 'fechado' : x.period === cur.slice(0, 7) ? 'em_andamento' : 'aberto' }));
    return { current: cur.slice(0, 7), items };
  });
  app.get('/accounting/periods/:period/checks', async (req) => { const a = can(req, 'accounting:view'); return closingChecks(pool, a.companyId, periodParam((req.params as { period: string }).period)); });
  app.post('/accounting/periods/:period/close', async (req) => {
    const a = can(req, 'accounting:approve'); const b = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    return tx((db) => closePeriod(db, a, periodParam((req.params as { period: string }).period), b.note ?? null));
  });
  app.post('/accounting/periods/:period/reopen', async (req) => {
    const a = can(req, 'accounting:approve'); const b = z.object({ reason: z.string().trim().min(10, 'Explique o motivo (mín. 10 caracteres).').max(500) }).parse(req.body);
    return tx((db) => reopenPeriod(db, a, periodParam((req.params as { period: string }).period), b.reason));
  });
  /** Confere se os lançamentos do período fechado continuam idênticos aos do fechamento. */
  app.get('/accounting/periods/:period/verify', async (req) => {
    const a = can(req, 'accounting:view'); const period = periodParam((req.params as { period: string }).period);
    const p = (await pool.query('select * from accounting_periods where company_id = $1 and period = $2', [a.companyId, period])).rows[0]; if (!p || p.status !== 'fechado') throw new HttpError(409, 'Período não está fechado.');
    const now = await fingerprint(pool, a.companyId, period);
    return { period: period.slice(0, 7), intact: now.checksum === p.checksum, entries: { closed: p.entries_count, now: now.entries }, total_debits: { closed: Number(p.total_debits), now: now.debits } };
  });
}
