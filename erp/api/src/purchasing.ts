import type { PoolClient } from 'pg';
import { pool, type Db } from './db.js';
import { HttpError, type Auth } from './auth.js';
import { audit } from './audit.js';
import { applyMovement } from './stock.js';
import { nextNumber } from './sales.js';
import { categoryId } from './finance.js';
import { postReceiving } from './accounting.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
export const PRICE_TOLERANCE_PCT = 0.5;

export async function getPurchasingSettings(db: Db, companyId: string): Promise<{ approval_threshold: number | null; review_days: number }> {
  const v = (await db.query(`select value from company_settings where company_id = $1 and key = 'purchasing'`, [companyId])).rows[0]?.value ?? {};
  return { approval_threshold: v.approval_threshold ?? null, review_days: v.review_days ?? 7 };
}

export async function recordSupplierPrice(db: Db, companyId: string, supplierId: string, productId: string, price: number, source: string, ref?: string) {
  await db.query('insert into supplier_prices (company_id, supplier_id, product_id, price, source, ref) values ($1,$2,$3,$4,$5,$6)', [companyId, supplierId, productId, price, source, ref ?? null]);
}

/**
 * Custo final de entrada (empresa do Simples Nacional, nota normal sem ST): não há crédito de ICMS/PIS/COFINS a abater,
 * então o custo é valor do item + IPI do item + rateio de frete/seguro/outras despesas − rateio do desconto
 * (rateio proporcional ao valor dos produtos). Custo unitário = total do item ÷ quantidade da NF.
 */
export function allocateCosts(items: { qty_nf: number; unit_price_nf: number; ipi: number }[], t: { freight: number; insurance: number; other_expenses: number; discount: number }) {
  const values = items.map((i) => i.qty_nf * i.unit_price_nf); const sum = values.reduce((s, v) => s + v, 0);
  return items.map((i, k) => {
    const w = sum > 0 ? values[k] / sum : 0;
    const total = values[k] + i.ipi + (t.freight + t.insurance + t.other_expenses) * w - t.discount * w;
    return r4(total / i.qty_nf);
  });
}

export interface ReceivingItemIn {
  product_id?: string | null; supplier_code?: string | null; ean?: string | null; description: string; ncm?: string | null; cfop?: string | null; unit?: string | null;
  qty: number; unit_price: number; ipi?: number;
}
export interface ReceivingIn {
  branchId: string; poId?: string | null; supplierId: string; source: 'xml' | 'manual'; nfNumber: string; nfSeries?: string | null; nfKey?: string | null; issueDate?: string | null;
  freight?: number; insurance?: number; other?: number; discount?: number; ipiTotal?: number; totalNf?: number; installments?: { due_date: string; amount: number }[]; xml?: string | null; items: ReceivingItemIn[];
}

/** Casa item do XML com produto: (1) código do fornecedor já mapeado, (2) EAN cadastrado, (3) código do fabricante igual ao cProd. */
async function matchProduct(db: Db, companyId: string, supplierId: string, it: ReceivingItemIn): Promise<string | null> {
  if (it.product_id) return it.product_id;
  if (it.supplier_code) {
    const m = (await db.query('select product_id from supplier_products where company_id = $1 and supplier_id = $2 and supplier_code = $3', [companyId, supplierId, it.supplier_code])).rows[0];
    if (m) return m.product_id;
  }
  if (it.ean) {
    const m = (await db.query('select product_id from product_barcodes where company_id = $1 and barcode = $2', [companyId, it.ean])).rows[0];
    if (m) return m.product_id;
  }
  if (it.supplier_code) {
    const m = (await db.query('select id from products where company_id = $1 and (manufacturer_code = $2 or sku = $2 or original_code = $2)', [companyId, it.supplier_code])).rows;
    if (m.length === 1) return m[0].id;
  }
  return null;
}

export async function createReceiving(db: PoolClient, a: Auth, i: ReceivingIn) {
  const sup = (await db.query('select id from suppliers where id = $1 and company_id = $2', [i.supplierId, a.companyId])).rows[0];
  if (!sup) throw new HttpError(422, 'Fornecedor inválido.');
  let po: { id: string; status: string; supplier_id: string } | null = null;
  if (i.poId) {
    po = (await db.query('select id, status, supplier_id from purchase_orders where id = $1 and company_id = $2 for update', [i.poId, a.companyId])).rows[0] ?? null;
    if (!po) throw new HttpError(422, 'Pedido de compra inválido.');
    if (po.supplier_id !== i.supplierId) throw new HttpError(422, 'O pedido é de outro fornecedor.');
    if (!['aprovado', 'enviado', 'parcial'].includes(po.status)) throw new HttpError(422, `Pedido ${po.status} não pode receber mercadoria.`);
  }
  const dupKey = i.nfKey ? await db.query(`select 1 from receivings where company_id = $1 and nf_key = $2 and status <> 'cancelado'`, [a.companyId, i.nfKey]) : { rowCount: 0 };
  const dupNum = await db.query(`select 1 from receivings where company_id = $1 and supplier_id = $2 and nf_number = $3 and coalesce(nf_series,'') = $4 and status <> 'cancelado'`, [a.companyId, i.supplierId, i.nfNumber, i.nfSeries ?? '']);
  if (dupKey.rowCount || dupNum.rowCount) throw new HttpError(409, `NF ${i.nfNumber} deste fornecedor já foi lançada.`, 'duplicate_nf');
  const productsTotal = r2(i.items.reduce((s, it) => s + it.qty * it.unit_price, 0));
  const ipiTotal = i.ipiTotal ?? r2(i.items.reduce((s, it) => s + (it.ipi ?? 0), 0));
  const freight = i.freight ?? 0, ins = i.insurance ?? 0, other = i.other ?? 0, disc = i.discount ?? 0;
  const totalNf = i.totalNf ?? r2(productsTotal + ipiTotal + freight + ins + other - disc);
  const number = await nextNumber(db, a.companyId, 'receiving');
  const rec = (await db.query(
    `insert into receivings (company_id, branch_id, number, po_id, supplier_id, source, nf_number, nf_series, nf_key, issue_date, freight, insurance, other_expenses, ipi_total, discount, total_products, total_nf, installments, created_by, xml)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning *`,
    [a.companyId, i.branchId, number, i.poId ?? null, i.supplierId, i.source, i.nfNumber, i.nfSeries ?? null, i.nfKey ?? null, i.issueDate ?? null, freight, ins, other, ipiTotal, disc, productsTotal, totalNf,
     i.installments?.length ? JSON.stringify(i.installments) : null, a.userId, i.xml ?? null])).rows[0];
  for (const it of i.items) {
    const productId = await matchProduct(db, a.companyId, i.supplierId, it);
    if (productId) {
      const ok = await db.query('select 1 from products where id = $1 and company_id = $2', [productId, a.companyId]);
      if (!ok.rowCount) throw new HttpError(422, 'Produto inválido.');
    }
    const poItem = po && productId ? (await db.query('select id from purchase_order_items where po_id = $1 and product_id = $2', [po.id, productId])).rows[0] : null;
    await db.query(
      `insert into receiving_items (receiving_id, product_id, po_item_id, supplier_code, ean, description, ncm, cfop, unit, qty_nf, unit_price_nf, ipi) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [rec.id, productId, poItem?.id ?? null, it.supplier_code ?? null, it.ean ?? null, it.description, it.ncm ?? null, it.cfop ?? null, it.unit ?? null, it.qty, it.unit_price, it.ipi ?? 0]);
  }
  await audit(db, a, 'receiving', rec.id, 'create', null, { number, nf: i.nfNumber, source: i.source, items: i.items.length });
  return rec;
}

/** Divergências do item: quantidade (NF × físico, NF × pedido), preço (NF × pedido), item sem produto, item fora do pedido. */
export function itemFlags(it: { product_id: string | null; po_item_id: string | null; qty_nf: string | number; qty_received: string | number | null; unit_price_nf: string | number; po_price?: string | number | null; po_pending?: string | number | null }, hasPo: boolean) {
  const flags: string[] = [];
  if (!it.product_id) flags.push('sem_produto');
  if (it.qty_received != null && Number(it.qty_received) !== Number(it.qty_nf)) flags.push(Number(it.qty_received) < Number(it.qty_nf) ? 'quantidade_menor' : 'quantidade_maior');
  if (hasPo && it.product_id && !it.po_item_id) flags.push('fora_do_pedido');
  if (it.po_item_id && it.po_pending != null && Number(it.qty_nf) > Number(it.po_pending)) flags.push('acima_do_pedido');
  if (it.po_item_id && it.po_price != null && Number(it.po_price) > 0 && Math.abs(Number(it.unit_price_nf) - Number(it.po_price)) / Number(it.po_price) * 100 > PRICE_TOLERANCE_PCT) flags.push('preco_divergente');
  return flags;
}

export async function loadReceivingItems(db: Db, receivingId: string, hasPo: boolean) {
  const rows = (await db.query(
    `select ri.*, p.sku, p.description as product_description, poi.unit_price as po_price, poi.qty - poi.received_qty as po_pending
       from receiving_items ri left join products p on p.id = ri.product_id left join purchase_order_items poi on poi.id = ri.po_item_id where ri.receiving_id = $1 order by ri.description`, [receivingId])).rows;
  return rows.map((r) => ({ ...r, flags: itemFlags(r, hasPo) }));
}

export async function finishReceiving(db: PoolClient, a: Auth, id: string, acceptDivergences: boolean) {
  const rec = (await db.query('select * from receivings where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
  if (!rec) throw new HttpError(404, 'Recebimento não encontrado.');
  if (rec.status !== 'em_conferencia') throw new HttpError(409, `Recebimento ${rec.status}.`);
  const items = await loadReceivingItems(db, id, !!rec.po_id);
  if (items.some((i) => !i.product_id)) throw new HttpError(422, 'Existem itens sem produto vinculado.', 'unmapped_items');
  if (items.some((i) => i.qty_received == null)) throw new HttpError(422, 'Conclua a conferência física de todos os itens.', 'unchecked_items');
  const all = new Set(items.flatMap((i) => i.flags as string[]));
  const priceDiv = all.has('preco_divergente'), qtyDiv = ['quantidade_menor', 'quantidade_maior', 'acima_do_pedido', 'fora_do_pedido'].some((f) => all.has(f));
  if ((priceDiv || qtyDiv) && !acceptDivergences) throw new HttpError(409, 'Há divergências de quantidade/preço: revise e confirme o aceite.', 'divergences', { divergences: [...all] });
  if (priceDiv && !a.permissions.has('purchases:approve')) throw new HttpError(403, 'Divergência de preço em relação ao pedido só pode ser aceita por quem aprova compras.', 'price_divergence');
  const unitCosts = allocateCosts(items.map((i) => ({ qty_nf: Number(i.qty_nf), unit_price_nf: Number(i.unit_price_nf), ipi: Number(i.ipi) })),
    { freight: Number(rec.freight), insurance: Number(rec.insurance), other_expenses: Number(rec.other_expenses), discount: Number(rec.discount) });
  for (const [k, it] of items.entries()) {
    const qty = Number(it.qty_received); const cost = unitCosts[k];
    await db.query('update receiving_items set unit_cost_final = $2 where id = $1', [it.id, cost]);
    if (qty > 0)
      await applyMovement(db, a, { branchId: rec.branch_id, productId: it.product_id, type: 'entrada', qty, from: null, to: 'disponivel', unitCost: cost, updateCost: true,
        documentType: 'NF', documentRef: rec.nf_number, origin: `Fornecedor`, reason: `Recebimento nº ${rec.number}` });
    await recordSupplierPrice(db, a.companyId, rec.supplier_id, it.product_id, Number(it.unit_price_nf), 'nf', rec.nf_number);
    await db.query(`insert into supplier_products (company_id, supplier_id, product_id, supplier_code) values ($1,$2,$3,$4)
                    on conflict (supplier_id, product_id) do update set supplier_code = coalesce(excluded.supplier_code, supplier_products.supplier_code)`, [a.companyId, rec.supplier_id, it.product_id, it.supplier_code]);
    if (it.po_item_id && qty > 0) await db.query('update purchase_order_items set received_qty = received_qty + $2 where id = $1', [it.po_item_id, qty]);
  }
  if (rec.po_id) {
    const open = await db.query('select 1 from purchase_order_items where po_id = $1 and received_qty < qty', [rec.po_id]);
    await db.query('update purchase_orders set status = $2 where id = $1', [rec.po_id, open.rowCount ? 'parcial' : 'recebido']);
  }
  // contas a pagar: duplicatas do XML ou prazo do pedido/fornecedor
  let parcels: { due_date: string; amount: number }[] = rec.installments ?? [];
  if (!parcels.length) {
    const terms = rec.po_id ? (await db.query('select payment_terms_days from purchase_orders where id = $1', [rec.po_id])).rows[0].payment_terms_days
      : (await db.query('select payment_terms_days from suppliers where id = $1', [rec.supplier_id])).rows[0].payment_terms_days;
    const due = new Date(Date.now() + Number(terms) * 86400000).toISOString().slice(0, 10);
    parcels = [{ due_date: due, amount: Number(rec.total_nf) }];
  }
  const catCompra = await categoryId(db, a.companyId, 'Compra de mercadorias');
  for (const [k, p] of parcels.entries())
    if (p.amount > 0) await db.query(`insert into payables (company_id, supplier_id, receiving_id, installment_no, installments, due_date, amount, description, category_id, competence, doc_number) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,date_trunc('month', current_date)::date,$10)`,
      [a.companyId, rec.supplier_id, id, k + 1, parcels.length, p.due_date, p.amount, `NF ${rec.nf_number}`, catCompra, rec.nf_number]);
  const note = all.size ? `Aceite com divergências: ${[...all].join(', ')}` : null;
  await db.query(`update receivings set status = 'concluido', finished_by = $2, finished_at = now(), divergence_note = $3 where id = $1`, [id, a.userId, note]);
  await postReceiving(db, id);
  await audit(db, a, 'receiving', id, 'finish', { status: 'em_conferencia' }, { status: 'concluido', total_nf: rec.total_nf, divergences: [...all] });
  return { id, status: 'concluido', divergences: [...all], payables: parcels.length };
}

// ---------------------------------------------------------------- Sugestão de compra
export interface Suggestion {
  product_id: string; sku: string; description: string; brand_name: string | null; abc: 'A' | 'B' | 'C';
  disponivel: number; min_stock: number; max_stock: number; ideal_stock: number; pending: number; transit: number; position: number;
  avg_daily: number; seasonality: number; seasonality_note: string; lead_time_days: number; reorder_point: number; target: number; suggested_qty: number; coverage_days: number | null;
  supplier_id: string | null; supplier_name: string | null; last_price: number | null; est_cost: number | null; confidence: 'baixa' | 'média' | 'alta'; basis: string;
}

/**
 * Sugestão automática: considera estoque, mínimo/máximo/ideal, venda média (90 dias), curva ABC, sazonalidade (mesmo período do ano anterior
 * quando há 12+ meses de histórico), pedidos pendentes, estoque em trânsito e prazo do fornecedor. É uma estimativa — mostra a confiança.
 */
export async function suggestions(companyId: string, branchId: string | null, supplierId: string | null): Promise<Suggestion[]> {
  const bp = branchId ? [companyId, branchId] : [companyId];
  const bf = branchId ? 'and s.branch_id = $2' : '';
  const rows = (await pool.query(`
    with hist as (select min(confirmed_at) as first_sale from sales where company_id = $1 and status = 'concluida'),
    sold as (
      select si.product_id,
        sum(si.qty) filter (where s.confirmed_at >= now() - interval '90 days') as q90,
        sum(si.total) filter (where s.confirmed_at >= now() - interval '90 days') as rev90,
        sum(si.qty) filter (where s.confirmed_at between now() - interval '365 days' and now() - interval '335 days') as ly_window,
        sum(si.qty) filter (where s.confirmed_at between now() - interval '455 days' and now() - interval '365 days') as ly_base,
        count(distinct s.id) filter (where s.confirmed_at >= now() - interval '90 days') as orders90
      from sale_items si join sales s on s.id = si.sale_id where s.company_id = $1 and s.status = 'concluida' ${bf} group by si.product_id),
    stock as (select product_id, sum(qty) filter (where status = 'disponivel') as disp, sum(qty) filter (where status = 'transito') as transit
      from stock_balances where company_id = $1 ${branchId ? 'and branch_id = $2' : ''} group by product_id),
    pend as (select poi.product_id, sum(poi.qty - poi.received_qty) as pending from purchase_order_items poi join purchase_orders po on po.id = poi.po_id
      where po.company_id = $1 and po.status in ('aprovado','enviado','parcial') ${branchId ? 'and po.branch_id = $2' : ''} group by poi.product_id)
    select p.id, p.sku, p.description, b.name as brand_name, p.min_stock, p.max_stock, p.ideal_stock, p.cost_avg, p.cost_current,
      coalesce(stock.disp,0) as disp, coalesce(stock.transit,0) as transit, coalesce(pend.pending,0) as pending,
      coalesce(sold.q90,0) as q90, coalesce(sold.rev90,0) as rev90, coalesce(sold.ly_window,0) as ly_window, coalesce(sold.ly_base,0) as ly_base, coalesce(sold.orders90,0) as orders90,
      extract(day from now() - hist.first_sale) as hist_days,
      sup.supplier_id, sup.name as supplier_name, sup.lead_time, sup.price as last_price
    from products p left join brands b on b.id = p.brand_id cross join hist
    left join stock on stock.product_id = p.id left join pend on pend.product_id = p.id left join sold on sold.product_id = p.id
    left join lateral (
      select sp.supplier_id, s.legal_name as name, coalesce(sp.lead_time_days, s.lead_time_days) as lead_time,
             (select price from supplier_prices where supplier_id = sp.supplier_id and product_id = p.id order by created_at desc, id desc limit 1) as price
        from supplier_products sp join suppliers s on s.id = sp.supplier_id
       where sp.product_id = p.id and s.active ${supplierId ? 'and sp.supplier_id = $' + (bp.length + 1) : ''}
       order by sp.preferred desc, (select price from supplier_prices where supplier_id = sp.supplier_id and product_id = p.id order by created_at desc, id desc limit 1) nulls last limit 1) sup on true
    where p.company_id = $1 and p.active ${supplierId ? 'and sup.supplier_id is not null' : ''}`, supplierId ? [...bp, supplierId] : bp)).rows;
  // curva ABC por faturamento dos últimos 90 dias
  const ranked = rows.filter((r) => Number(r.rev90) > 0).sort((x, y) => Number(y.rev90) - Number(x.rev90));
  const totalRev = ranked.reduce((s, r) => s + Number(r.rev90), 0); const abc = new Map<string, 'A' | 'B' | 'C'>(); let cum = 0;
  for (const r of ranked) { abc.set(r.id, cum / totalRev * 100 < 80 ? 'A' : cum / totalRev * 100 < 95 ? 'B' : 'C'); cum += Number(r.rev90); }
  const review = (await getPurchasingSettings(pool, companyId)).review_days;
  const out: Suggestion[] = [];
  for (const r of rows) {
    const histDays = Number(r.hist_days ?? 0); const window = Math.max(1, Math.min(90, histDays));
    const avg = Number(r.q90) / window;
    const cls = abc.get(r.id) ?? 'C';
    let seas = 1; let note = 'sem histórico de 12 meses: sazonalidade não aplicada';
    if (histDays >= 400 && Number(r.ly_base) > 0) { seas = Math.min(2, Math.max(0.5, Number(r.ly_window) / (Number(r.ly_base) / 3))); note = `mesmo período do ano anterior: fator ${seas.toFixed(2)}`; }
    const lead = Number(r.lead_time ?? 0); const horizon = lead + review;
    const leadDemand = avg * seas * horizon; const safety = leadDemand * ({ A: 0.3, B: 0.15, C: 0.05 }[cls]);
    const min = Number(r.min_stock), max = Number(r.max_stock), ideal = Number(r.ideal_stock);
    const reorder = Math.max(min, leadDemand + safety);
    const target = Math.max(ideal, reorder + (avg > 0 ? avg * seas * review : 0), min);
    const position = Number(r.disp) + Number(r.pending) + Number(r.transit);
    let qty = position <= reorder && reorder > 0 ? Math.ceil(target - position) : 0;
    if (qty > 0 && max > 0) qty = Math.min(qty, Math.max(0, Math.ceil(max - position)));
    if (qty <= 0) continue;
    const price = r.last_price != null ? Number(r.last_price) : null;
    const confidence = histDays < 30 || Number(r.orders90) < 3 ? 'baixa' : histDays < 90 ? 'média' : 'alta';
    out.push({ product_id: r.id, sku: r.sku, description: r.description, brand_name: r.brand_name, abc: cls, disponivel: Number(r.disp), min_stock: min, max_stock: max, ideal_stock: ideal,
      pending: Number(r.pending), transit: Number(r.transit), position, avg_daily: r2(avg), seasonality: r2(seas), seasonality_note: note, lead_time_days: lead, reorder_point: r2(reorder), target: r2(target),
      suggested_qty: qty, coverage_days: avg > 0 ? r2(Number(r.disp) / avg) : null, supplier_id: r.supplier_id, supplier_name: r.supplier_name, last_price: price, est_cost: price != null ? r2(price * qty) : null, confidence,
      basis: `posição ${r2(position)} (disp. ${r2(Number(r.disp))} + pedidos ${r2(Number(r.pending))} + trânsito ${r2(Number(r.transit))}) ≤ ponto de pedido ${r2(reorder)}; repor até ${r2(target)}` });
  }
  return out.sort((a, b) => (a.coverage_days ?? 9999) - (b.coverage_days ?? 9999));
}
