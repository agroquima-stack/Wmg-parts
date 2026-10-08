// Financeiro de DEMONSTRAÇÃO: contas, baixas de recebíveis, despesas fixas e um extrato CSV de exemplo (via serviços reais).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { pool, tx } from '../db.js';
import { authForUser } from '../sales.js';
import { categoryId, settle } from '../finance.js';

const co = (await pool.query(`select id from companies where is_demo order by created_at limit 1`)).rows[0];
if (!co) { console.log('Sem empresa demo.'); await pool.end(); process.exit(0); }
const cid = co.id as string;
if ((await pool.query('select 1 from bank_accounts where company_id = $1 limit 1', [cid])).rowCount) { console.log('Financeiro demo já existe.'); await pool.end(); process.exit(0); }
const branch = (await pool.query('select id from branches where company_id = $1 order by is_headquarters desc limit 1', [cid])).rows[0].id;
const admin = (await pool.query('select id from users where company_id = $1 order by created_at limit 1', [cid])).rows[0].id;

await tx(async (db) => {
  const a = await authForUser(db, admin, branch);
  const btg = (await db.query(`insert into bank_accounts (company_id, name, kind, bank_name, opening_balance, opening_date) values ($1,'BTG Pactual (DEMO)','banco','BTG Pactual',45000, current_date - 90) returning id`, [cid])).rows[0].id;
  await db.query(`insert into bank_accounts (company_id, name, kind, bank_name, opening_balance, opening_date) values ($1,'Aplicação BTG (DEMO)','aplicacao','BTG Pactual',20000, current_date - 90)`, [cid]);
  await db.query(`insert into company_settings (company_id, key, value) values ($1,'finance',$2) on conflict (company_id, key) do update set value = $2`, [cid, JSON.stringify({ fine_pct: 2, interest_monthly_pct: 1, grace_days: 0, default_accounts: { pix: btg, cartao_debito: btg } })]);
  // recebimentos: Pix/débito já recebidos; cartão e boletos com vencimento passado pagos em sua maioria (alguns ficam vencidos p/ demonstrar inadimplência)
  const open = (await db.query(`select id, method, due_date::text d, customer_id from receivables where company_id = $1 and status = 'aberto' order by due_date`, [cid])).rows;
  let k = 0;
  for (const r of open) {
    k++;
    const past = r.d < new Date().toISOString().slice(0, 10);
    if (['pix', 'cartao_debito', 'dinheiro'].includes(r.method)) await settle(db, a, { kind: 'receivable', docId: r.id, date: r.d, accountId: btg, method: r.method, noMovement: false });
    else if (r.method === 'cartao_credito' && past) await settle(db, a, { kind: 'receivable', docId: r.id, date: r.d, accountId: btg, method: r.method, fee: 0 });
    else if (past && k % 3 !== 0) await settle(db, a, { kind: 'receivable', docId: r.id, date: r.d, accountId: btg, method: r.method });
  }
  const cat = async (n: string) => (await categoryId(db, cid, n))!;
  const cc = async (n: string) => (await db.query('select id from cost_centers where company_id = $1 and name = $2', [cid, n])).rows[0].id;
  for (const [desc, c, center, amount, day] of [['Aluguel do galpão (DEMO)', 'Aluguel', 'Administrativo', 6500, 5], ['Folha de pagamento (DEMO)', 'Salários e encargos', 'Administrativo', 18000, 5], ['Simples Nacional — DAS (DEMO)', 'Simples Nacional (DAS)', 'Financeiro', 3200, 20], ['Internet e energia (DEMO)', 'Energia, água e internet', 'Administrativo', 950, 12]] as const)
    for (let m = 0; m < 4; m++) {
      const due = (await db.query(`select (date_trunc('month', current_date) + ($1 || ' months')::interval + ($2 - 1 || ' days')::interval)::date::text d`, [String(m), day])).rows[0].d;
      const p = (await db.query(`insert into payables (company_id, due_date, amount, description, category_id, cost_center_id, competence, installment_no, installments) values ($1,$2,$3,$4,$5,$6,date_trunc('month',$2::date)::date,$7,4) returning id`, [cid, due, amount, desc, await cat(c), await cc(center), m + 1])).rows[0];
      if (m === 0 && due < new Date().toISOString().slice(0, 10)) await settle(db, a, { kind: 'payable', docId: p.id, date: due, accountId: btg, method: 'transferencia' });
    }
});

// CSV de exemplo (layout genérico, NÃO é o layout oficial do BTG): linhas coerentes com os movimentos da demo
const rows = (await pool.query(`select m.movement_date::text d, m.amount, m.description from account_movements m join bank_accounts b on b.id = m.account_id where b.company_id = $1 and b.name like 'BTG%' and not m.reversed order by m.movement_date desc, m.created_at desc limit 8`, [cid])).rows;
const br = (n: number) => n.toFixed(2).replace('.', ',');
let saldo = 45000;
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../samples/extrato-exemplo-demo.csv'),
  'Data;Histórico;Documento;Valor;Saldo\n' + rows.map((r, i) => { saldo += Number(r.amount); return `${r.d.split('-').reverse().join('/')};${String(r.description).replace(/;/g, ',').toUpperCase()};${1000 + i};${br(Number(r.amount))};${br(saldo)}`; }).join('\n')
  + `\n${new Date().toISOString().slice(0, 10).split('-').reverse().join('/')};TARIFA PACOTE DE SERVICOS;9001;-39,90;${br(saldo - 39.9)}\n`);
console.log('Financeiro de demonstração criado (contas, baixas, despesas fixas) e samples/extrato-exemplo-demo.csv gerado.');
await pool.end();
