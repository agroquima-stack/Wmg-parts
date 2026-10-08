// Uso: ADMIN_EMAIL=... ADMIN_PASSWORD=... COMPANY_NAME="Minha Distribuidora" npm run bootstrap
import { pool, tx } from '../db.js';
import { migrate } from './migrate.js';
import { createCompany } from './company.js';
import { passwordIssue } from '../lib/security.js';

const { ADMIN_EMAIL, ADMIN_PASSWORD, COMPANY_NAME, ADMIN_NAME } = process.env;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !COMPANY_NAME) {
  console.error('Defina ADMIN_EMAIL, ADMIN_PASSWORD e COMPANY_NAME.'); process.exit(1);
}
const issue = passwordIssue(ADMIN_PASSWORD);
if (issue) { console.error(issue); process.exit(1); }
await migrate();
const r = await tx((db) => createCompany(db, { legalName: COMPANY_NAME, adminName: ADMIN_NAME ?? 'Administrador', adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD }));
console.log('Empresa criada:', r.companyId, '— o administrador deverá trocar a senha no primeiro acesso.');
await pool.end();
