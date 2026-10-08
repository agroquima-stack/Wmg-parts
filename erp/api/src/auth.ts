import type { FastifyRequest } from 'fastify';
import { pool } from './db.js';
import { sha256 } from './lib/security.js';

export interface Auth {
  userId: string; userName: string; companyId: string; branchId: string | null;
  roleName: string; mustChangePassword: boolean; permissions: Set<string>; sessionId: string; ip: string;
}
declare module 'fastify' { interface FastifyRequest { auth?: Auth } }

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

/** Resolve a sessão a partir do Bearer token (token opaco; só o hash é armazenado). */
export async function authenticate(req: FastifyRequest): Promise<Auth> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw new HttpError(401, 'Não autenticado.');
  const hash = sha256(h.slice(7));
  const { rows } = await pool.query(
    `select s.id as sid, s.branch_id, u.id as uid, u.name, u.company_id, u.must_change_password, r.id as role_id, r.name as role_name
       from sessions s join users u on u.id = s.user_id join roles r on r.id = u.role_id
       join companies c on c.id = u.company_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
        and u.active and c.active`, [hash]);
  const s = rows[0];
  if (!s) throw new HttpError(401, 'Sessão inválida ou expirada.');
  const perms = await pool.query('select permission from role_permissions where role_id = $1', [s.role_id]);
  return {
    userId: s.uid, userName: s.name, companyId: s.company_id, branchId: s.branch_id,
    roleName: s.role_name, mustChangePassword: s.must_change_password, permissions: new Set(perms.rows.map((p) => p.permission)),
    sessionId: s.sid, ip: req.ip,
  };
}

export function requireAuth(req: FastifyRequest): Auth {
  if (!req.auth) throw new HttpError(401, 'Não autenticado.');
  return req.auth;
}

export function can(req: FastifyRequest, permission: string): Auth {
  const a = requireAuth(req);
  if (!a.permissions.has(permission)) throw new HttpError(403, `Sem permissão (${permission}).`, 'forbidden');
  return a;
}
