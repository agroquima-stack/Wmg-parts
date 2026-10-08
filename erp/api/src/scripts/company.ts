import type { PoolClient } from 'pg';
import { DEFAULT_ROLES } from '../permissions.js';
import { hashPassword } from '../lib/security.js';

/** Cria empresa + matriz + perfis padrão + usuário administrador (tudo na mesma transação). */
export async function createCompany(db: PoolClient, o: {
  legalName: string; tradeName?: string; cnpj?: string; isDemo?: boolean;
  adminName: string; adminEmail: string; adminPassword: string; mustChangePassword?: boolean;
}) {
  const c = (await db.query('insert into companies (legal_name, trade_name, cnpj, is_demo) values ($1,$2,$3,$4) returning id',
    [o.legalName, o.tradeName ?? null, o.cnpj ?? null, o.isDemo ?? false])).rows[0];
  const b = (await db.query(`insert into branches (company_id, code, name, is_headquarters) values ($1,'MATRIZ','Matriz',true) returning id`, [c.id])).rows[0];
  const roleIds: Record<string, string> = {};
  for (const [name, def] of Object.entries(DEFAULT_ROLES)) {
    const r = (await db.query('insert into roles (company_id, name, description, is_system) values ($1,$2,$3,true) returning id', [c.id, name, def.description])).rows[0];
    roleIds[name] = r.id;
    for (const p of new Set(def.permissions)) await db.query('insert into role_permissions values ($1,$2)', [r.id, p]);
  }
  const u = (await db.query(
    `insert into users (company_id, role_id, name, email, password_hash, must_change_password) values ($1,$2,$3,$4,$5,$6) returning id`,
    [c.id, roleIds.administrador, o.adminName, o.adminEmail, await hashPassword(o.adminPassword), o.mustChangePassword ?? true])).rows[0];
  return { companyId: c.id as string, branchId: b.id as string, adminId: u.id as string, roleIds };
}
