import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../db.js';
import { config } from '../config.js';
import { HttpError, requireAuth } from '../auth.js';
import { audit } from '../audit.js';
import { hashPassword, newToken, passwordIssue, sha256, verifyPassword } from '../lib/security.js';

export async function authRoutes(app: FastifyInstance) {
  // Rate limit específico: 10 tentativas/min por IP
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' }, public: true } }, async (req) => {
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const genericFail = new HttpError(401, 'E-mail ou senha inválidos.');
    const u = (await pool.query(
      `select u.*, r.name as role_name from users u join roles r on r.id = u.role_id
        join companies c on c.id = u.company_id where lower(u.email) = lower($1) and c.active`, [email])).rows[0];
    if (!u) { await verifyPassword(password, 'scrypt$00$00'); throw genericFail; }
    const actor = { companyId: u.company_id, userId: u.id, userName: u.name, branchId: null as string | null, ip: req.ip };
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(423, 'Conta temporariamente bloqueada. Tente mais tarde.');
    const ok = u.active && (await verifyPassword(password, u.password_hash));
    if (!ok) {
      const attempts = u.failed_attempts + 1;
      const lock = attempts >= config.maxFailedAttempts;
      await pool.query('update users set failed_attempts = $2, locked_until = $3 where id = $1',
        [u.id, lock ? 0 : attempts, lock ? new Date(Date.now() + config.lockMinutes * 60000) : null]);
      await audit(pool, actor, 'session', null, 'login_failed');
      throw genericFail;
    }
    const branches = (await pool.query(
      `select b.id, b.name, b.code, b.is_headquarters from branches b
        where b.company_id = $1 and b.active and (b.id in (select branch_id from user_branches where user_id = $2)
          or not exists (select 1 from user_branches where user_id = $2))
        order by b.is_headquarters desc, b.name`, [u.company_id, u.id])).rows;
    const token = newToken();
    const branchId = branches[0]?.id ?? null;
    await tx(async (db) => {
      await db.query('update users set failed_attempts = 0, locked_until = null, last_login_at = now() where id = $1', [u.id]);
      await db.query(
        `insert into sessions (user_id, company_id, branch_id, token_hash, ip, user_agent, expires_at)
         values ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval)`,
        [u.id, u.company_id, branchId, sha256(token), req.ip, req.headers['user-agent'] ?? null, String(config.sessionHours)]);
      await audit(db, { ...actor, branchId }, 'session', null, 'login');
    });
    return { token, mustChangePassword: u.must_change_password, branches, user: { id: u.id, name: u.name, email: u.email, role: u.role_name } };
  });

  app.post('/auth/logout', async (req) => {
    const a = requireAuth(req);
    await pool.query('update sessions set revoked_at = now() where id = $1', [a.sessionId]);
    await audit(pool, a, 'session', null, 'logout');
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const a = requireAuth(req);
    const c = (await pool.query('select id, legal_name, trade_name, is_demo from companies where id = $1', [a.companyId])).rows[0];
    const branches = (await pool.query(
      `select id, name, code, is_headquarters from branches where company_id = $1 and active order by is_headquarters desc, name`, [a.companyId])).rows;
    return { user: { id: a.userId, name: a.userName, role: a.roleName }, company: c, branchId: a.branchId, branches, permissions: [...a.permissions] };
  });

  app.post('/auth/branch', async (req) => {
    const a = requireAuth(req);
    const { branchId } = z.object({ branchId: z.string().uuid() }).parse(req.body);
    const ok = await pool.query(
      `select 1 from branches b where b.id = $1 and b.company_id = $2 and b.active
         and (exists (select 1 from user_branches where user_id = $3 and branch_id = b.id)
              or not exists (select 1 from user_branches where user_id = $3))`, [branchId, a.companyId, a.userId]);
    if (!ok.rowCount) throw new HttpError(403, 'Filial não permitida.');
    await pool.query('update sessions set branch_id = $2 where id = $1', [a.sessionId, branchId]);
    return { branchId };
  });

  app.post('/auth/change-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireAuth(req);
    const { current, next } = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    const issue = passwordIssue(next);
    if (issue) throw new HttpError(422, issue);
    const u = (await pool.query('select password_hash from users where id = $1', [a.userId])).rows[0];
    if (!(await verifyPassword(current, u.password_hash))) throw new HttpError(401, 'Senha atual incorreta.');
    await tx(async (db) => {
      await db.query('update users set password_hash = $2, must_change_password = false where id = $1', [a.userId, await hashPassword(next)]);
      // encerra as demais sessões
      await db.query('update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null', [a.userId, a.sessionId]);
      await audit(db, a, 'user', a.userId, 'password_change');
    });
    return { ok: true };
  });
}
