import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db.js';
import { can, HttpError, type Auth } from '../auth.js';
import { audit } from '../audit.js';
import { pageParams } from '../crud.js';
import { applyMovement, STATUSES, type Status } from '../stock.js';
import { text } from '../schemas.js';

/** Filial efetiva: a informada ou a da sessão; precisa estar entre as permitidas ao usuário. */
async function resolveBranch(db: Db, a: Auth, branchId?: string | null): Promise<string> {
  const id = branchId || a.branchId;
  if (!id) throw new HttpError(422, 'Selecione uma filial.');
  const ok = await db.query(
    `select 1 from branches b where b.id = $1 and b.company_id = $2 and b.active
       and (exists (select 1 from user_branches where user_id = $3 and branch_id = b.id) or not exists (select 1 from user_branches where user_id = $3))`,
    [id, a.companyId, a.userId]);
  if (!ok.rowCount) throw new HttpError(403, 'Filial não permitida.');
  return id;
}

const OPS: Record<string, { from: Status | null; to: Status | null; perm: 'create' | 'edit'; reason?: boolean }> = {
  entrada: { from: null, to: 'disponivel', perm: 'create' },
  entrada_consignado: { from: null, to: 'consignado', perm: 'create' },
  saida: { from: 'disponivel', to: null, perm: 'create', reason: true },
  ajuste_entrada: { from: null, to: 'disponivel', perm: 'edit', reason: true },
  ajuste_saida: { from: 'disponivel', to: null, perm: 'edit', reason: true },
  reserva: { from: 'disponivel', to: 'reservado', perm: 'create' },
  liberacao: { from: 'reservado', to: 'disponivel', perm: 'create' },
  bloqueio: { from: 'disponivel', to: 'quarentena', perm: 'edit', reason: true },
  desbloqueio: { from: 'quarentena', to: 'disponivel', perm: 'edit' },
  avaria: { from: 'disponivel', to: 'avariado', perm: 'edit', reason: true },
};

const moveSchema = z.object({
  op: z.enum(Object.keys(OPS) as [string, ...string[]]),
  product_id: z.string().uuid(), branch_id: z.string().uuid().nullish(),
  qty: z.coerce.number().positive().max(1e9),
  unit_cost: z.coerce.number().min(0).nullish(), update_cost: z.boolean().optional(),
  document_type: text(30), document_ref: text(60), origin: text(100), destination: text(100), reason: text(300),
});

const balanceSelect = (branchFilter: boolean) => `
  select p.id, p.sku, p.description, p.manufacturer_code, p.location, p.min_stock, p.max_stock, p.ideal_stock, p.cost_avg, p.sale_price, b.name as brand_name,
    coalesce(s.disponivel,0) as disponivel, coalesce(s.reservado,0) as reservado, coalesce(s.transito,0) as transito,
    coalesce(s.avariado,0) as avariado, coalesce(s.quarentena,0) as quarentena, coalesce(s.consignado,0) as consignado,
    (coalesce(s.disponivel,0)+coalesce(s.reservado,0)+coalesce(s.avariado,0)+coalesce(s.quarentena,0)) * p.cost_avg as stock_value
  from products p
  left join brands b on b.id = p.brand_id
  left join (select product_id,
      sum(qty) filter (where status='disponivel') disponivel, sum(qty) filter (where status='reservado') reservado,
      sum(qty) filter (where status='transito') transito, sum(qty) filter (where status='avariado') avariado,
      sum(qty) filter (where status='quarentena') quarentena, sum(qty) filter (where status='consignado') consignado
    from stock_balances where company_id = $1 ${branchFilter ? 'and branch_id = $2' : ''} group by product_id) s on s.product_id = p.id`;

/** Resumo/alertas de estoque (usado também pelo dashboard). branchId null = consolidado. */
export async function stockSummary(companyId: string, branchId: string | null) {
  const params: unknown[] = branchId ? [companyId, branchId] : [companyId];
  const r = await pool.query(`
    with t as (${balanceSelect(!!branchId)} where p.company_id = $1 and p.active)
    select coalesce(sum(stock_value),0)::numeric(16,2) as total_value,
      count(*) filter (where min_stock > 0 and disponivel < min_stock and disponivel > 0)::int as below_min,
      count(*) filter (where disponivel = 0 and (min_stock > 0 or reservado + transito + avariado + quarentena > 0))::int as out_of_stock,
      count(*) filter (where max_stock > 0 and disponivel > max_stock)::int as excess,
      coalesce(sum(greatest(disponivel - max_stock, 0) * cost_avg) filter (where max_stock > 0),0)::numeric(16,2) as excess_value
    from t`, params);
  return r.rows[0];
}

export async function idleAnalysis(companyId: string, branchId: string | null) {
  const params: unknown[] = branchId ? [companyId, branchId] : [companyId];
  const r = await pool.query(`
    with t as (${balanceSelect(!!branchId)} where p.company_id = $1 and p.active),
    ref as (
      select product_id, max(created_at) filter (where type = 'saida') as last_out, min(created_at) filter (where type like 'entrada%' or type = 'ajuste_entrada') as first_in
      from stock_movements where company_id = $1 ${branchId ? 'and branch_id = $2' : ''} group by product_id),
    x as (
      select t.id, t.sku, t.description, t.cost_avg, t.sale_price, (t.disponivel + t.reservado + t.quarentena + t.avariado) as qty,
        extract(day from now() - coalesce(ref.last_out, ref.first_in, now()))::int as days
      from t left join ref on ref.product_id = t.id where (t.disponivel + t.reservado + t.quarentena + t.avariado) > 0)
    select case when days <= 30 then '0-30' when days <= 60 then '31-60' when days <= 90 then '61-90' when days <= 180 then '91-180'
                when days <= 360 then '181-360' else '+360' end as bucket,
      count(*)::int as products, sum(qty) as qty, sum(qty * cost_avg)::numeric(16,2) as cost_value, sum(qty * sale_price)::numeric(16,2) as sale_value,
      sum(qty * (sale_price - cost_avg))::numeric(16,2) as potential_margin
    from x group by 1`, params);
  const order = ['0-30', '31-60', '61-90', '91-180', '181-360', '+360'];
  const suggestions: Record<string, string> = {
    '0-30': 'Giro normal.', '31-60': 'Acompanhar; considerar combo com itens de maior giro.',
    '61-90': 'Promoção ou combo; oferecer a clientes que já compraram o item.',
    '91-180': 'Desconto progressivo e oferta direcionada a oficinas/lojistas.',
    '181-360': 'Avaliar devolução ao fornecedor ou liquidação parcial.', '+360': 'Liquidação; capital parado há mais de um ano.' };
  return order.map((b) => {
    const row = r.rows.find((x) => x.bucket === b);
    return { bucket: b, products: row?.products ?? 0, qty: Number(row?.qty ?? 0), cost_value: row?.cost_value ?? '0.00', sale_value: row?.sale_value ?? '0.00',
      potential_margin: row?.potential_margin ?? '0.00', suggestion: suggestions[b] };
  });
}

export async function stockRoutes(app: FastifyInstance) {
  // ---- Saldos (por filial ou consolidado: branch_id=all)
  app.get('/stock/balances', async (req) => {
    const a = can(req, 'stock:view');
    const qs = req.query as Record<string, string>;
    const { page, pageSize, offset } = pageParams(qs);
    const branchId = qs.branch_id === 'all' ? null : await resolveBranch(pool, a, qs.branch_id);
    const params: unknown[] = branchId ? [a.companyId, branchId] : [a.companyId];
    const where = ['p.company_id = $1', 'p.active'];
    if (qs.q?.trim()) { params.push(`%${qs.q.trim()}%`); where.push(`(unaccent(p.description) ilike unaccent($${params.length}) or p.sku ilike $${params.length} or p.manufacturer_code ilike $${params.length} or p.original_code ilike $${params.length})`); }
    for (const f of ['brand_id', 'category_id']) if (qs[f]) { params.push(qs[f]); where.push(`p.${f} = $${params.length}`); }
    const flt: Record<string, string> = {
      below_min: 'p.min_stock > 0 and coalesce(s.disponivel,0) < p.min_stock', zero: 'coalesce(s.disponivel,0) = 0',
      excess: 'p.max_stock > 0 and coalesce(s.disponivel,0) > p.max_stock', with_stock: 'coalesce(s.disponivel,0) > 0' };
    if (qs.filter && flt[qs.filter]) where.push(flt[qs.filter]);
    const w = where.join(' and ');
    const [items, total] = await Promise.all([
      pool.query(`${balanceSelect(!!branchId)} where ${w} order by p.description limit ${pageSize} offset ${offset}`, params),
      pool.query(`select count(*)::int n from products p left join (select product_id, sum(qty) filter (where status='disponivel') disponivel from stock_balances where company_id = $1 ${branchId ? 'and branch_id = $2' : ''} group by product_id) s on s.product_id = p.id where ${w}`, params),
    ]);
    return { items: items.rows, total: total.rows[0].n, page, pageSize, branch_id: branchId };
  });

  app.get('/stock/summary', async (req) => {
    const a = can(req, 'stock:view');
    const b = (req.query as Record<string, string>).branch_id;
    return stockSummary(a.companyId, b === 'all' || !b ? null : await resolveBranch(pool, a, b));
  });

  // ---- Movimentações
  app.post('/stock/movements', async (req, reply) => {
    const body = moveSchema.parse(req.body);
    const op = OPS[body.op];
    const a = can(req, `stock:${op.perm}`);
    if (op.reason && !body.reason) throw new HttpError(422, 'Informe o motivo.');
    const row = await tx(async (db) => {
      const branchId = await resolveBranch(db, a, body.branch_id);
      const type = body.op.startsWith('ajuste') ? 'ajuste' : body.op === 'entrada_consignado' ? 'entrada' : body.op;
      const m = await applyMovement(db, a, {
        branchId, productId: body.product_id, type, qty: body.qty, from: op.from, to: op.to,
        unitCost: body.unit_cost, updateCost: body.op === 'entrada' && body.unit_cost != null && body.update_cost !== false,
        documentType: body.document_type, documentRef: body.document_ref, origin: body.origin, destination: body.destination, reason: body.reason });
      if (type === 'ajuste' || type === 'avaria' || type === 'bloqueio' || (type === 'saida' && body.reason))
        await audit(db, a, 'stock_movement', String(m.id), type, null, m);
      return m;
    });
    return reply.code(201).send(row);
  });

  app.get('/stock/movements', async (req) => {
    const a = can(req, 'stock:view');
    const qs = req.query as Record<string, string>;
    const { page, pageSize, offset } = pageParams(qs);
    const params: unknown[] = [a.companyId]; const w = ['m.company_id = $1'];
    for (const f of ['product_id', 'branch_id', 'type']) if (qs[f]) { params.push(qs[f]); w.push(`m.${f} = $${params.length}`); }
    if (qs.from) { params.push(qs.from); w.push(`m.created_at >= $${params.length}`); }
    if (qs.to) { params.push(qs.to); w.push(`m.created_at < ($${params.length}::date + 1)`); }
    const sql = `from stock_movements m join products p on p.id = m.product_id join branches b on b.id = m.branch_id where ${w.join(' and ')}`;
    const [items, total] = await Promise.all([
      pool.query(`select m.*, p.sku, p.description, b.name as branch_name ${sql} order by m.id desc limit ${pageSize} offset ${offset}`, params),
      pool.query(`select count(*)::int n ${sql}`, params)]);
    return { items: items.rows, total: total.rows[0].n, page, pageSize };
  });

  // ---- Transferências entre filiais (saída na origem → trânsito no destino → recebimento)
  app.post('/stock/transfers', async (req, reply) => {
    const a = can(req, 'stock:create');
    const b = z.object({ from_branch_id: z.string().uuid().nullish(), to_branch_id: z.string().uuid(), note: text(300),
      items: z.array(z.object({ product_id: z.string().uuid(), qty: z.coerce.number().positive() })).min(1).max(200) }).parse(req.body);
    const out = await tx(async (db) => {
      const from = await resolveBranch(db, a, b.from_branch_id);
      if (from === b.to_branch_id) throw new HttpError(422, 'Origem e destino devem ser diferentes.');
      const toOk = await db.query('select name from branches where id = $1 and company_id = $2 and active', [b.to_branch_id, a.companyId]);
      if (!toOk.rowCount) throw new HttpError(422, 'Filial de destino inválida.');
      const fromName = (await db.query('select name from branches where id = $1', [from])).rows[0].name;
      if (new Set(b.items.map((i) => i.product_id)).size !== b.items.length) throw new HttpError(422, 'Produto repetido na transferência.');
      const t = (await db.query('insert into stock_transfers (company_id, from_branch_id, to_branch_id, note, created_by) values ($1,$2,$3,$4,$5) returning *',
        [a.companyId, from, b.to_branch_id, b.note, a.userId])).rows[0];
      for (const it of b.items) {
        await db.query('insert into stock_transfer_items values ($1,$2,$3)', [t.id, it.product_id, it.qty]);
        const doc = { documentType: 'transferencia', documentRef: t.id };
        await applyMovement(db, a, { ...doc, branchId: from, productId: it.product_id, type: 'transferencia_saida', qty: it.qty, from: 'disponivel', to: null, origin: fromName, destination: toOk.rows[0].name });
        await applyMovement(db, a, { ...doc, branchId: b.to_branch_id, productId: it.product_id, type: 'transferencia_transito', qty: it.qty, from: null, to: 'transito', origin: fromName, destination: toOk.rows[0].name });
      }
      await audit(db, a, 'stock_transfer', t.id, 'create', null, { ...t, items: b.items });
      return t;
    });
    return reply.code(201).send(out);
  });

  app.get('/stock/transfers', async (req) => {
    const a = can(req, 'stock:view');
    const r = await pool.query(
      `select t.*, f.name as from_name, d.name as to_name,
         (select json_agg(json_build_object('product_id', i.product_id, 'sku', p.sku, 'description', p.description, 'qty', i.qty))
            from stock_transfer_items i join products p on p.id = i.product_id where i.transfer_id = t.id) as items
       from stock_transfers t join branches f on f.id = t.from_branch_id join branches d on d.id = t.to_branch_id
      where t.company_id = $1 order by t.created_at desc limit 100`, [a.companyId]);
    return { items: r.rows };
  });

  const finishTransfer = (action: 'receive' | 'cancel') => async (req: import('fastify').FastifyRequest) => {
    const a = can(req, action === 'receive' ? 'stock:create' : 'stock:edit');
    const id = (req.params as { id: string }).id;
    return tx(async (db) => {
      const t = (await db.query('select * from stock_transfers where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
      if (!t) throw new HttpError(404, 'Transferência não encontrada.');
      if (t.status !== 'em_transito') throw new HttpError(409, 'Transferência já finalizada.');
      // recebe quem tem acesso à filial de destino; cancela quem tem acesso à origem
      await resolveBranch(db, a, action === 'receive' ? t.to_branch_id : t.from_branch_id);
      const items = (await db.query('select * from stock_transfer_items where transfer_id = $1', [id])).rows;
      const doc = { documentType: 'transferencia', documentRef: id };
      for (const it of items) {
        const qty = Number(it.qty);
        if (action === 'receive')
          await applyMovement(db, a, { ...doc, branchId: t.to_branch_id, productId: it.product_id, type: 'transferencia_recebimento', qty, from: 'transito', to: 'disponivel' });
        else {
          await applyMovement(db, a, { ...doc, branchId: t.to_branch_id, productId: it.product_id, type: 'transferencia_cancelada', qty, from: 'transito', to: null, reason: 'Cancelamento' });
          await applyMovement(db, a, { ...doc, branchId: t.from_branch_id, productId: it.product_id, type: 'transferencia_cancelada', qty, from: null, to: 'disponivel', reason: 'Cancelamento' });
        }
      }
      const status = action === 'receive' ? 'recebida' : 'cancelada';
      await db.query('update stock_transfers set status = $2, received_by = $3, received_at = now() where id = $1', [id, status, a.userId]);
      await audit(db, a, 'stock_transfer', id, action, { status: t.status }, { status });
      return { status };
    });
  };
  app.post('/stock/transfers/:id/receive', finishTransfer('receive'));
  app.post('/stock/transfers/:id/cancel', finishTransfer('cancel'));

  // ---- Inventário (geral/rotativo)
  app.post('/stock/inventories', async (req, reply) => {
    const a = can(req, 'stock:create');
    const b = z.object({ branch_id: z.string().uuid().nullish(), type: z.enum(['geral', 'rotativo']), note: text(300),
      product_ids: z.array(z.string().uuid()).optional(), category_id: z.string().uuid().nullish() }).parse(req.body);
    const inv = await tx(async (db) => {
      const branchId = await resolveBranch(db, a, b.branch_id);
      const open = await db.query(`select 1 from inventories where branch_id = $1 and status = 'aberto' and type = 'geral'`, [branchId]);
      if (open.rowCount) throw new HttpError(409, 'Já existe inventário geral aberto nesta filial.');
      if (b.type === 'rotativo' && !b.product_ids?.length && !b.category_id) throw new HttpError(422, 'Inventário rotativo exige produtos ou categoria.');
      const inv = (await db.query('insert into inventories (company_id, branch_id, type, note, created_by) values ($1,$2,$3,$4,$5) returning *', [a.companyId, branchId, b.type, b.note, a.userId])).rows[0];
      const params: unknown[] = [a.companyId, branchId, inv.id]; let filter = '';
      if (b.type === 'rotativo') {
        if (b.product_ids?.length) { params.push(b.product_ids); filter += ` and p.id = any($${params.length})`; }
        if (b.category_id) { params.push(b.category_id); filter += ` and (p.category_id = $${params.length} or p.subcategory_id = $${params.length})`; }
      }
      const n = await db.query(
        `insert into inventory_items (inventory_id, product_id, system_qty)
         select $3, p.id, coalesce((select qty from stock_balances where product_id = p.id and branch_id = $2 and status = 'disponivel'), 0)
           from products p where p.company_id = $1 and p.active ${filter}`, params);
      if (!n.rowCount) throw new HttpError(422, 'Nenhum produto selecionado para o inventário.');
      await audit(db, a, 'inventory', inv.id, 'create', null, { ...inv, items: n.rowCount });
      return inv;
    });
    return reply.code(201).send(inv);
  });

  app.get('/stock/inventories', async (req) => {
    const a = can(req, 'stock:view');
    const r = await pool.query(
      `select i.*, b.name as branch_name, (select count(*)::int from inventory_items where inventory_id = i.id) as items,
              (select count(*)::int from inventory_items where inventory_id = i.id and counted_qty is not null) as counted
         from inventories i join branches b on b.id = i.branch_id where i.company_id = $1 order by i.created_at desc limit 100`, [a.companyId]);
    return { items: r.rows };
  });

  app.get('/stock/inventories/:id', async (req) => {
    const a = can(req, 'stock:view');
    const id = (req.params as { id: string }).id;
    const inv = (await pool.query('select * from inventories where id = $1 and company_id = $2', [id, a.companyId])).rows[0];
    if (!inv) throw new HttpError(404, 'Inventário não encontrado.');
    const items = (await pool.query(
      `select ii.*, p.sku, p.description, p.location, p.cost_avg, (ii.counted_qty - ii.system_qty) as diff
         from inventory_items ii join products p on p.id = ii.product_id where ii.inventory_id = $1 order by p.location nulls last, p.description`, [id])).rows;
    return { ...inv, items };
  });

  app.put('/stock/inventories/:id/count', async (req) => {
    const a = can(req, 'stock:create');
    const id = (req.params as { id: string }).id;
    const b = z.object({ product_id: z.string().uuid(), counted_qty: z.coerce.number().min(0).nullable() }).parse(req.body);
    const r = await pool.query(
      `update inventory_items ii set counted_qty = $3 from inventories i
        where ii.inventory_id = i.id and i.id = $1 and i.company_id = $2 and i.status = 'aberto' and ii.product_id = $4 returning ii.*`,
      [id, a.companyId, b.counted_qty, b.product_id]);
    if (!r.rowCount) throw new HttpError(404, 'Item não encontrado ou inventário fechado.');
    return r.rows[0];
  });

  app.post('/stock/inventories/:id/close', async (req) => {
    const a = can(req, 'stock:approve');          // acerto de inventário exige aprovação do gestor
    const id = (req.params as { id: string }).id;
    return tx(async (db) => {
      const inv = (await db.query('select * from inventories where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0];
      if (!inv) throw new HttpError(404, 'Inventário não encontrado.');
      if (inv.status !== 'aberto') throw new HttpError(409, 'Inventário já finalizado.');
      const items = (await db.query(
        `select ii.*, p.cost_avg from inventory_items ii join products p on p.id = ii.product_id where inventory_id = $1 and counted_qty is not null and counted_qty <> system_qty`, [id])).rows;
      let gain = 0, loss = 0;
      for (const it of items) {
        const diff = Number(it.counted_qty) - Number(it.system_qty);
        const value = Math.abs(diff) * Number(it.cost_avg);
        await applyMovement(db, a, { branchId: inv.branch_id, productId: it.product_id, type: 'inventario', qty: Math.abs(diff),
          from: diff < 0 ? 'disponivel' : null, to: diff > 0 ? 'disponivel' : null, documentType: 'inventario', documentRef: id, reason: `Acerto de inventário (${inv.type})` });
        if (diff > 0) gain += value; else loss += value;
      }
      await db.query(`update inventories set status = 'fechado', closed_by = $2, closed_at = now() where id = $1`, [id, a.userId]);
      const summary = { adjusted: items.length, gain_value: gain.toFixed(2), loss_value: loss.toFixed(2) };
      await audit(db, a, 'inventory', id, 'close', { status: 'aberto' }, { status: 'fechado', ...summary });
      return summary;
    });
  });

  // ---- Análises
  app.get('/stock/idle', async (req) => {
    const a = can(req, 'stock:view');
    const b = (req.query as Record<string, string>).branch_id;
    return { buckets: await idleAnalysis(a.companyId, b === 'all' || !b ? null : await resolveBranch(pool, a, b)) };
  });

  /**
   * Curva ABC configurável. Critérios disponíveis hoje: valor em estoque, quantidade em estoque e
   * saídas no período (proxy de giro). Faturamento/margem dependem das vendas (Fase 3).
   */
  app.get('/stock/abc', async (req) => {
    const a = can(req, 'stock:view');
    const qs = req.query as Record<string, string>;
    const criteria = qs.criteria ?? 'valor_estoque';
    if (['faturamento', 'margem'].includes(criteria)) throw new HttpError(422, 'Critério disponível após o módulo de vendas (Fase 3).');
    if (!['valor_estoque', 'quantidade', 'saidas'].includes(criteria)) throw new HttpError(422, 'Critério inválido.');
    const ca = Math.min(99, Math.max(1, Number(qs.a_pct) || 80)); const cb = Math.min(100, Math.max(ca, Number(qs.b_pct) || 95));
    const branchId = qs.branch_id && qs.branch_id !== 'all' ? await resolveBranch(pool, a, qs.branch_id) : null;
    const params: unknown[] = [a.companyId]; const w = ['p.company_id = $1', 'p.active'];
    let bal = ''; let mov = '';
    if (branchId) { params.push(branchId); bal = `and branch_id = $${params.length}`; mov = bal; }
    for (const f of ['brand_id', 'category_id']) if (qs[f]) { params.push(qs[f]); w.push(`p.${f} = $${params.length}`); }
    params.push(qs.from || '1900-01-01'); const pFrom = params.length; params.push(qs.to || '2999-12-31'); const pTo = params.length;
    const metric = criteria === 'valor_estoque' ? 'coalesce(s.owned,0) * p.cost_avg' : criteria === 'quantidade' ? 'coalesce(s.owned,0)' : 'coalesce(o.out_qty,0)';
    const rows = (await pool.query(`
      with base as (
        select p.id, p.sku, p.description, ${metric} as metric from products p
        left join (select product_id, sum(qty) filter (where status in ('disponivel','reservado','avariado','quarentena')) owned from stock_balances where company_id = $1 ${bal} group by product_id) s on s.product_id = p.id
        left join (select product_id, sum(qty) out_qty from stock_movements where company_id = $1 and type = 'saida' ${mov} and created_at >= $${pFrom} and created_at < ($${pTo}::date + 1) group by product_id) o on o.product_id = p.id
        where ${w.join(' and ')}),
      r as (select *, sum(metric) over () as total, sum(metric) over (order by metric desc, id) as cum from base where metric > 0)
      select id, sku, description, metric, round(metric / total * 100, 2) as share, round(cum / total * 100, 2) as cum_share,
        case when (cum - metric) / total * 100 < $${params.length + 1} then 'A' when (cum - metric) / total * 100 < $${params.length + 2} then 'B' else 'C' end as class
      from r order by metric desc, id limit 1000`, [...params, ca, cb])).rows;
    const summary = ['A', 'B', 'C'].map((c) => ({ class: c, products: rows.filter((r) => r.class === c).length,
      share: rows.filter((r) => r.class === c).reduce((s, r) => s + Number(r.share), 0).toFixed(2) }));
    return { criteria, thresholds: { a: ca, b: cb }, summary, items: rows };
  });

  app.get('/products/:id/stock', async (req) => {
    const a = can(req, 'stock:view');
    const id = (req.params as { id: string }).id;
    const r = await pool.query(
      `select b.id as branch_id, b.name as branch_name, sb.status, sb.qty from stock_balances sb join branches b on b.id = sb.branch_id
        where sb.product_id = $1 and sb.company_id = $2 and sb.qty > 0 order by b.name, sb.status`, [id, a.companyId]);
    return { items: r.rows, statuses: STATUSES };
  });
}
