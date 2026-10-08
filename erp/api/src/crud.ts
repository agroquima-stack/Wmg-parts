import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { pool, tx, type Db } from './db.js';
import { can, HttpError } from './auth.js';
import { audit } from './audit.js';

type Row = Record<string, unknown>;
const q = (id: string) => `"${id.replace(/"/g, '')}"`;

export interface CrudConfig {
  path: string;                 // /brands
  table: string;
  entity: string;               // nome para auditoria
  perm: string;                 // prefixo de permissão (brands -> brands:view)
  schema: z.ZodObject<z.ZodRawShape>;
  searchCols: string[];
  orderBy: string;
  filters?: string[];           // colunas filtráveis por igualdade (?col=valor)
  refs?: Record<string, string>; // coluna -> tabela (validadas contra a mesma empresa)
  hasActive?: boolean;          // true => DELETE vira inativação se em uso
  check?: (merged: Row) => string | null; // regras entre campos
  select?: string;              // select customizado (alias t = tabela)
}

export const pageParams = (query: Row) => {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
};

/** Garante que todo id referenciado pertence à empresa do usuário (isolamento multiempresa). */
export async function assertRefs(db: Db, companyId: string, data: Row, refs: Record<string, string>) {
  for (const [col, table] of Object.entries(refs)) {
    const v = data[col];
    if (v == null) continue;
    const r = await db.query(`select 1 from ${q(table)} where id = $1 and company_id = $2`, [v, companyId]);
    if (!r.rowCount) throw new HttpError(422, `Referência inválida em "${col}".`);
  }
}

export async function insertRow(db: Db, table: string, companyId: string, data: Row): Promise<Row> {
  const cols = Object.keys(data).filter((k) => data[k] !== undefined);
  const all = ['company_id', ...cols];
  const vals = [companyId, ...cols.map((c) => data[c])];
  const r = await db.query(
    `insert into ${q(table)} (${all.map(q).join(',')}) values (${all.map((_, i) => `$${i + 1}`).join(',')}) returning *`, vals);
  return r.rows[0];
}

export async function updateRow(db: Db, table: string, companyId: string, id: string, data: Row): Promise<Row | null> {
  const cols = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!cols.length) throw new HttpError(422, 'Nada para atualizar.');
  const r = await db.query(
    `update ${q(table)} set ${cols.map((c, i) => `${q(c)} = $${i + 1}`).join(',')}
      where id = $${cols.length + 1} and company_id = $${cols.length + 2} returning *`,
    [...cols.map((c) => data[c]), id, companyId]);
  return r.rows[0] ?? null;
}

export function registerCrud(app: FastifyInstance, c: CrudConfig) {
  const p = c.path;

  app.get(p, async (req) => {
    const a = can(req, `${c.perm}:view`);
    const qs = req.query as Row;
    const { page, pageSize, offset } = pageParams(qs);
    const where = ['t.company_id = $1']; const params: unknown[] = [a.companyId];
    if (qs.q && String(qs.q).trim()) {
      params.push(`%${String(qs.q).trim()}%`);
      where.push('(' + c.searchCols.map((col) => `unaccent(t.${q(col)}::text) ilike unaccent($${params.length})`).join(' or ') + ')');
    }
    for (const f of c.filters ?? []) {
      if (qs[f] !== undefined && qs[f] !== '') { params.push(qs[f]); where.push(`t.${q(f)} = $${params.length}`); }
    }
    if (c.hasActive && qs.active !== undefined && qs.active !== '') { params.push(qs.active === 'true'); where.push(`t.active = $${params.length}`); }
    const sel = c.select ?? 't.*';
    const w = where.join(' and ');
    const [items, total] = await Promise.all([
      pool.query(`select ${sel} from ${q(c.table)} t where ${w} order by ${c.orderBy} limit ${pageSize} offset ${offset}`, params),
      pool.query(`select count(*)::int n from ${q(c.table)} t where ${w}`, params),
    ]);
    return { items: items.rows, total: total.rows[0].n, page, pageSize };
  });

  app.get(`${p}/:id`, async (req) => {
    const a = can(req, `${c.perm}:view`);
    const r = await pool.query(`select ${c.select ?? 't.*'} from ${q(c.table)} t where t.id = $1 and t.company_id = $2`,
      [(req.params as Row).id, a.companyId]);
    if (!r.rowCount) throw new HttpError(404, 'Registro não encontrado.');
    return r.rows[0];
  });

  app.post(p, async (req, reply) => {
    const a = can(req, `${c.perm}:create`);
    const data = c.schema.parse(req.body) as Row;
    const bad = c.check?.(data); if (bad) throw new HttpError(422, bad);
    const row = await tx(async (db) => {
      await assertRefs(db, a.companyId, data, c.refs ?? {});
      const r = await insertRow(db, c.table, a.companyId, data);
      await audit(db, a, c.entity, String(r.id), 'create', null, r);
      return r;
    });
    return reply.code(201).send(row);
  });

  app.patch(`${p}/:id`, async (req) => {
    const a = can(req, `${c.perm}:edit`);
    const id = (req.params as Row).id as string;
    const data = c.schema.partial().parse(req.body) as Row;
    return tx(async (db) => {
      const before = await db.query(`select * from ${q(c.table)} where id = $1 and company_id = $2 for update`, [id, a.companyId]);
      if (!before.rowCount) throw new HttpError(404, 'Registro não encontrado.');
      const bad = c.check?.({ ...before.rows[0], ...data }); if (bad) throw new HttpError(422, bad);
      await assertRefs(db, a.companyId, data, c.refs ?? {});
      const after = await updateRow(db, c.table, a.companyId, id, data);
      await audit(db, a, c.entity, id, 'update', before.rows[0], after);
      return after;
    });
  });

  app.delete(`${p}/:id`, async (req) => {
    const a = can(req, `${c.perm}:delete`);
    const id = (req.params as Row).id as string;
    return tx(async (db) => {
      const before = await db.query(`select * from ${q(c.table)} where id = $1 and company_id = $2 for update`, [id, a.companyId]);
      if (!before.rowCount) throw new HttpError(404, 'Registro não encontrado.');
      try {
        await db.query('savepoint del');
        await db.query(`delete from ${q(c.table)} where id = $1 and company_id = $2`, [id, a.companyId]);
        await audit(db, a, c.entity, id, 'delete', before.rows[0], null);
        return { deleted: true };
      } catch (e) {
        if ((e as { code?: string }).code !== '23503') throw e;
        await db.query('rollback to savepoint del');
        if (!c.hasActive) throw new HttpError(409, 'Registro em uso; não pode ser excluído.');
        const after = await updateRow(db, c.table, a.companyId, id, { active: false });
        await audit(db, a, c.entity, id, 'deactivate', before.rows[0], after);
        return { deleted: false, deactivated: true, message: 'Registro em uso: foi inativado em vez de excluído.' };
      }
    });
  });
}

export type Req = FastifyRequest;
