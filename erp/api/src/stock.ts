import type { PoolClient } from 'pg';
import type { Auth } from './auth.js';
import { HttpError } from './auth.js';

export const STATUSES = ['disponivel', 'reservado', 'transito', 'avariado', 'quarentena', 'consignado'] as const;
export type Status = (typeof STATUSES)[number];
/** Status cujo saldo pertence à empresa e compõe o custo médio global. */
const OWNED: Status[] = ['disponivel', 'reservado', 'avariado', 'quarentena'];

export interface MoveInput {
  branchId: string; productId: string; type: string; qty: number;
  from: Status | null; to: Status | null;           // null = externo (entrada/saída)
  unitCost?: number | null; updateCost?: boolean;
  documentType?: string | null; documentRef?: string | null; origin?: string | null; destination?: string | null; reason?: string | null;
}

async function lockBalance(db: PoolClient, a: Auth, branchId: string, productId: string, status: Status): Promise<number> {
  await db.query(
    `insert into stock_balances (company_id, product_id, branch_id, status, qty) values ($1,$2,$3,$4,0) on conflict do nothing`,
    [a.companyId, productId, branchId, status]);
  const r = await db.query('select qty from stock_balances where product_id = $1 and branch_id = $2 and status = $3 for update', [productId, branchId, status]);
  return Number(r.rows[0].qty);
}

/**
 * Única porta de entrada para alterar saldo. Valida saldo (nunca negativo), grava o movimento
 * imutável e, em entradas com custo, recalcula o custo médio GLOBAL do produto.
 * Deve ser chamada dentro de uma transação.
 */
export async function applyMovement(db: PoolClient, a: Auth, m: MoveInput) {
  if (!(m.qty > 0)) throw new HttpError(422, 'Quantidade deve ser maior que zero.');
  const ok = await db.query(
    `select 1 from products p, branches b where p.id = $1 and p.company_id = $3 and b.id = $2 and b.company_id = $3`,
    [m.productId, m.branchId, a.companyId]);
  if (!ok.rowCount) throw new HttpError(422, 'Produto ou filial inválidos.');
  let before = 0; let after = 0;

  // trava em ordem determinística para evitar deadlock em operações concorrentes
  const touched = [m.from, m.to].filter((s): s is Status => !!s).sort();
  const bal: Record<string, number> = {};
  for (const s of touched) bal[s] = await lockBalance(db, a, m.branchId, m.productId, s);

  if (m.from) {
    before = bal[m.from];
    if (before < m.qty) throw new HttpError(409, `Saldo insuficiente (${m.from}: ${before}, solicitado: ${m.qty}).`, 'insufficient_stock');
    await db.query('update stock_balances set qty = qty - $4, updated_at = now() where product_id = $1 and branch_id = $2 and status = $3', [m.productId, m.branchId, m.from, m.qty]);
    after = before - m.qty;
  }
  if (m.to) {
    if (!m.from) { before = bal[m.to]; after = before + m.qty; }
    await db.query('update stock_balances set qty = qty + $4, updated_at = now() where product_id = $1 and branch_id = $2 and status = $3', [m.productId, m.branchId, m.to, m.qty]);
  }

  if (m.updateCost && m.unitCost != null && m.to && !m.from) {
    const owned = await db.query(
      `select coalesce(sum(qty),0) q from stock_balances where product_id = $1 and status = any($2)`, [m.productId, OWNED]);
    const prevOwned = Number(owned.rows[0].q) - (OWNED.includes(m.to) ? m.qty : 0);
    const p = (await db.query('select cost_avg from products where id = $1 for update', [m.productId])).rows[0];
    const prevAvg = Number(p.cost_avg);
    const newAvg = prevOwned > 0 ? (prevOwned * prevAvg + m.qty * m.unitCost) / (prevOwned + m.qty) : m.unitCost;
    await db.query('update products set cost_avg = $2, cost_last = $3, cost_current = $3, updated_at = now() where id = $1',
      [m.productId, Math.round(newAvg * 10000) / 10000, m.unitCost]);
  }

  const r = await db.query(
    `insert into stock_movements (company_id, branch_id, product_id, type, from_status, to_status, qty, qty_before, qty_after, unit_cost,
       document_type, document_ref, origin, destination, reason, user_id, user_name)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
    [a.companyId, m.branchId, m.productId, m.type, m.from, m.to, m.qty, before, after, m.unitCost ?? null,
     m.documentType ?? null, m.documentRef ?? null, m.origin ?? null, m.destination ?? null, m.reason ?? null, a.userId, a.userName]);
  return r.rows[0];
}
