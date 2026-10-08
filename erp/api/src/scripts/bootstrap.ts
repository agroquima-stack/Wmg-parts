// Uso: ADMIN_EMAIL=... ADMIN_PASSWORD=... COMPANY_NAME="Minha Distribuidora" npm run bootstrap
import { pool, tx } from '../db.js';
import { migrate } from './migrate.js';
import { createCompany } from './company.js';
import { passwordIssue } from '../lib/security.js';
import { postBankOpening } from '../accounting.js';

// OPENING_BALANCE (ex.: 22600.07) cria a conta bancária inicial com esse saldo; a contrapartida contábil é o Capital social.
const { ADMIN_EMAIL, ADMIN_PASSWORD, COMPANY_NAME, ADMIN_NAME, OPENING_BALANCE, BANK_NAME } = process.env;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !COMPANY_NAME) {
  console.error('Defina ADMIN_EMAIL, ADMIN_PASSWORD e COMPANY_NAME.'); process.exit(1);
}
const issue = passwordIssue(ADMIN_PASSWORD);
if (issue) { console.error(issue); process.exit(1); }
await migrate();
const r = await tx((db) => createCompany(db, { legalName: COMPANY_NAME, adminName: ADMIN_NAME ?? 'Administrador', adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD }));
if (OPENING_BALANCE) {
  const v = Number(OPENING_BALANCE); if (!Number.isFinite(v)) { console.error('OPENING_BALANCE inválido.'); process.exit(1); }
  await tx(async (db) => {
    const acc = (await db.query(`insert into bank_accounts (company_id, name, kind, bank_name, opening_balance, opening_date) values ($1,$2,'banco',$2,$3,current_date) returning id`, [r.companyId, BANK_NAME ?? 'BTG Pactual', v])).rows[0];
    await postBankOpening(db, acc.id);
  });
  console.log(`Conta ${BANK_NAME ?? 'BTG Pactual'} criada com saldo inicial R$ ${v.toFixed(2)} (contrapartida: Capital social).`);
}
console.log('Empresa criada:', r.companyId, '— o administrador deverá trocar a senha no primeiro acesso.');
await pool.end();
