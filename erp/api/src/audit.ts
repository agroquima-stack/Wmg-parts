import type { Db } from './db.js';
import type { Auth } from './auth.js';

export async function audit(
  db: Db,
  a: Pick<Auth, 'companyId' | 'userId' | 'userName' | 'branchId'> & { ip?: string },
  entity: string, entityId: string | null, action: string,
  before: unknown = null, after: unknown = null,
) {
  await db.query(
    `insert into audit_log (company_id, branch_id, user_id, user_name, entity, entity_id, action, before, after, ip)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [a.companyId, a.branchId, a.userId, a.userName, entity, entityId, action,
     before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), a.ip ?? null],
  );
}
