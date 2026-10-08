import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { can, HttpError } from '../auth.js';
import { audit } from '../audit.js';
import { assertRefs, insertRow, pageParams, registerCrud, updateRow } from '../crud.js';
import { hashPassword, passwordIssue } from '../lib/security.js';
import { ALL_PERMISSIONS, RESOURCES, ACTIONS } from '../permissions.js';
import { reqText, text, uf } from '../schemas.js';

const userCols = `u.id, u.name, u.email, u.active, u.is_seller, u.commission_pct, u.max_discount_pct, u.role_id,
  r.name as role_name, u.last_login_at, u.created_at,
  coalesce((select array_agg(branch_id) from user_branches where user_id = u.id), '{}') as branch_ids`;

const userBase = z.object({
  name: reqText(120), email: z.string().trim().email().max(200), role_id: z.string().uuid(),
  active: z.boolean().optional(), is_seller: z.boolean().optional(),
  commission_pct: z.coerce.number().min(0).max(100).optional(),
  max_discount_pct: z.coerce.number().min(0).max(100).optional(),
  branch_ids: z.array(z.string().uuid()).optional(),
});

export async function adminRoutes(app: FastifyInstance) {
  // ---- Filiais
  registerCrud(app, {
    path: '/branches', table: 'branches', entity: 'branch', perm: 'branches',
    schema: z.object({ code: reqText(20), name: reqText(), cnpj: text(20), city: text(), state: uf,
      is_headquarters: z.boolean().optional(), active: z.boolean().optional() }),
    searchCols: ['name', 'code', 'city'], orderBy: 't.is_headquarters desc, t.name', hasActive: true,
  });

  // ---- Usuários
  app.get('/users', async (req) => {
    const a = can(req, 'users:view');
    const qs = req.query as Record<string, string>;
    const { page, pageSize, offset } = pageParams(qs);
    const params: unknown[] = [a.companyId]; let w = 'u.company_id = $1';
    if (qs.q?.trim()) { params.push(`%${qs.q.trim()}%`); w += ` and (u.name ilike $2 or u.email ilike $2)`; }
    if (qs.is_seller === 'true') w += ' and u.is_seller';
    const items = await pool.query(`select ${userCols} from users u join roles r on r.id = u.role_id where ${w} order by u.name limit ${pageSize} offset ${offset}`, params);
    const total = await pool.query(`select count(*)::int n from users u where ${w}`, params);
    return { items: items.rows, total: total.rows[0].n, page, pageSize };
  });

  app.post('/users', async (req, reply) => {
    const a = can(req, 'users:create');
    const { password, branch_ids, ...data } = userBase.extend({ password: z.string() }).parse(req.body);
    const issue = passwordIssue(password); if (issue) throw new HttpError(422, issue);
    const row = await tx(async (db) => {
      await assertRefs(db, a.companyId, data, { role_id: 'roles' });
      const r = await insertRow(db, 'users', a.companyId, { ...data, password_hash: await hashPassword(password), must_change_password: true });
      for (const b of branch_ids ?? []) {
        const ok = await db.query('select 1 from branches where id = $1 and company_id = $2', [b, a.companyId]);
        if (!ok.rowCount) throw new HttpError(422, 'Filial inválida.');
        await db.query('insert into user_branches (user_id, branch_id) values ($1,$2)', [r.id, b]);
      }
      const { password_hash: _h, ...safe } = r;
      await audit(db, a, 'user', String(r.id), 'create', null, { ...safe, branch_ids });
      return safe;
    });
    return reply.code(201).send(row);
  });

  app.patch('/users/:id', async (req) => {
    const a = can(req, 'users:edit');
    const id = (req.params as { id: string }).id;
    const { branch_ids, ...data } = userBase.partial().parse(req.body);
    return tx(async (db) => {
      const before = (await db.query(`select ${userCols} from users u join roles r on r.id = u.role_id where u.id = $1 and u.company_id = $2 for update of u`, [id, a.companyId])).rows[0];
      if (!before) throw new HttpError(404, 'Usuário não encontrado.');
      if (id === a.userId && (data.active === false || (data.role_id && data.role_id !== before.role_id)))
        throw new HttpError(422, 'Você não pode desativar ou alterar o próprio perfil.');
      await assertRefs(db, a.companyId, data, { role_id: 'roles' });
      if (Object.keys(data).length) await updateRow(db, 'users', a.companyId, id, data);
      if (branch_ids) {
        await db.query('delete from user_branches where user_id = $1', [id]);
        for (const b of branch_ids) {
          const ok = await db.query('select 1 from branches where id = $1 and company_id = $2', [b, a.companyId]);
          if (!ok.rowCount) throw new HttpError(422, 'Filial inválida.');
          await db.query('insert into user_branches (user_id, branch_id) values ($1,$2)', [id, b]);
        }
      }
      if (data.active === false || data.role_id) await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      const after = (await db.query(`select ${userCols} from users u join roles r on r.id = u.role_id where u.id = $1`, [id])).rows[0];
      await audit(db, a, 'user', id, 'update', before, after);
      return after;
    });
  });

  app.post('/users/:id/reset-password', async (req) => {
    const a = can(req, 'users:edit');
    const id = (req.params as { id: string }).id;
    const { password } = z.object({ password: z.string() }).parse(req.body);
    const issue = passwordIssue(password); if (issue) throw new HttpError(422, issue);
    return tx(async (db) => {
      const r = await db.query('update users set password_hash = $3, must_change_password = true, failed_attempts = 0, locked_until = null where id = $1 and company_id = $2 returning id', [id, a.companyId, await hashPassword(password)]);
      if (!r.rowCount) throw new HttpError(404, 'Usuário não encontrado.');
      await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      await audit(db, a, 'user', id, 'password_reset');
      return { ok: true };
    });
  });

  // ---- Perfis e permissões (RBAC)
  app.get('/permissions', async (req) => { can(req, 'roles:view'); return { resources: RESOURCES, actions: ACTIONS, all: ALL_PERMISSIONS }; });

  app.get('/roles', async (req) => {
    const a = can(req, 'roles:view');
    const rows = await pool.query(
      `select r.*, coalesce((select array_agg(permission order by permission) from role_permissions where role_id = r.id), '{}') as permissions,
              (select count(*)::int from users where role_id = r.id) as users_count
         from roles r where r.company_id = $1 order by r.name`, [a.companyId]);
    return { items: rows.rows };
  });

  app.post('/roles', async (req, reply) => {
    const a = can(req, 'roles:create');
    const data = z.object({ name: reqText(60), description: text(200), permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])) }).parse(req.body);
    return tx(async (db) => {
      const r = await insertRow(db, 'roles', a.companyId, { name: data.name, description: data.description });
      for (const p of data.permissions) await db.query('insert into role_permissions values ($1,$2)', [r.id, p]);
      await audit(db, a, 'role', String(r.id), 'create', null, { ...r, permissions: data.permissions });
      return reply.code(201).send(r);
    });
  });

  app.put('/roles/:id/permissions', async (req) => {
    const a = can(req, 'roles:edit');
    const id = (req.params as { id: string }).id;
    const { permissions } = z.object({ permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])) }).parse(req.body);
    return tx(async (db) => {
      const role = (await db.query('select * from roles where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
      if (!role) throw new HttpError(404, 'Perfil não encontrado.');
      if (role.name === 'administrador') throw new HttpError(422, 'O perfil administrador não pode ser alterado.');
      const old = (await db.query('select permission from role_permissions where role_id = $1 order by 1', [id])).rows.map((r) => r.permission);
      await db.query('delete from role_permissions where role_id = $1', [id]);
      for (const p of new Set(permissions)) await db.query('insert into role_permissions values ($1,$2)', [id, p]);
      await audit(db, a, 'role', id, 'permissions_update', { permissions: old }, { permissions: [...new Set(permissions)].sort() });
      return { ok: true };
    });
  });

  // ---- Auditoria (somente leitura)
  app.get('/audit', async (req) => {
    const a = can(req, 'audit:view');
    const qs = req.query as Record<string, string>;
    const { page, pageSize, offset } = pageParams(qs);
    const params: unknown[] = [a.companyId]; const w = ['company_id = $1'];
    for (const f of ['entity', 'action', 'user_id', 'entity_id']) if (qs[f]) { params.push(qs[f]); w.push(`${f} = $${params.length}`); }
    if (qs.from) { params.push(qs.from); w.push(`created_at >= $${params.length}`); }
    if (qs.to) { params.push(qs.to); w.push(`created_at < ($${params.length}::date + 1)`); }
    const items = await pool.query(`select * from audit_log where ${w.join(' and ')} order by id desc limit ${pageSize} offset ${offset}`, params);
    const total = await pool.query(`select count(*)::int n from audit_log where ${w.join(' and ')}`, params);
    return { items: items.rows, total: total.rows[0].n, page, pageSize };
  });
}
