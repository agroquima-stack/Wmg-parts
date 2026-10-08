import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, type Db } from '../db.js';
import { can, HttpError, type Auth } from '../auth.js';
import { audit } from '../audit.js';
import { pageParams } from '../crud.js';
import { nextNumber } from '../sales.js';
import { categoryId } from '../finance.js';
import { getPricingParams } from '../pricing.js';
import { parseNFe } from '../lib/nfe.js';
import { buildFiscalPayload, getFiscalSettings, type Validation } from '../fiscal/build.js';
import { providers } from '../fiscal/providers.js';
import { effectiveRateAnexoI, parseAccessKey } from '../fiscal/rules.js';
import { text } from '../schemas.js';
import { postTaxTrueUp } from '../accounting.js';

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function createDraft(db: Db, a: Auth, saleId: string, o: { model?: '55' | '65'; kind?: 'venda' | 'devolucao_venda'; returnItems?: { product_id: string; qty: number }[]; originalId?: string | null; refKey?: string | null } = {}) {
  const b = await buildFiscalPayload(db, a.companyId, saleId, { model: o.model, kind: o.kind, returnItems: o.returnItems, refKey: o.refKey });
  const row = (await db.query(
    `insert into fiscal_documents (company_id, branch_id, sale_id, original_doc_id, kind, model, environment, series, payload, validation, total, provider, simulated, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [a.companyId, b.sale.branch_id, saleId, o.originalId ?? null, o.kind ?? 'venda', b.model, b.settings.environment, b.payload.ide.serie, JSON.stringify(b.payload), JSON.stringify(b.validation), b.payload.totais.valor_nf, b.settings.provider, providers[b.settings.provider].simulated, a.userId])).rows[0];
  await audit(db, a, 'fiscal_document', row.id, 'create', null, { sale: b.sale.number, model: b.model, kind: row.kind, errors: b.validation.errors.length });
  return row;
}
const dupFriendly = (e: unknown) => { if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'Esta venda já possui nota fiscal ativa (rascunho ou autorizada).', 'duplicate_document'); throw e; };

const loadDoc = async (db: Db, a: Auth, id: string, lock = false) => {
  const d = (await db.query(`select * from fiscal_documents where id = $1 and company_id = $2 ${lock ? 'for update' : ''}`, [id, a.companyId])).rows[0];
  if (!d) throw new HttpError(404, 'Documento fiscal não encontrado.'); return d;
};

/** Estimativa do DAS do mês (competência). Não substitui o PGDAS-D: o valor oficial é informado a partir da guia. */
export async function dasEstimate(db: Db, companyId: string, month: string) {
  const s = await getFiscalSettings(db, companyId);
  const rev = async (from: string, to: string) => Number((await db.query(`select coalesce(sum(total),0) s from sales where company_id = $1 and status = 'concluida' and confirmed_at::date >= $2 and confirmed_at::date < $3`, [companyId, from, to])).rows[0].s);
  const next = (await db.query(`select ($1::date + interval '1 month')::date::text d`, [month])).rows[0].d;
  const revenue = await rev(month, next);
  let rate: number | null; let rbt12: number | null = null; let method: string;
  if (s.das_mode === 'anexo_i') {
    const prev12 = await rev((await db.query(`select ($1::date - interval '12 months')::date::text d`, [month])).rows[0].d, month);
    const first = (await db.query(`select min(confirmed_at)::date::text d from sales where company_id = $1 and status = 'concluida'`, [companyId])).rows[0].d;
    const monthsHist = first ? Math.max(0, (await db.query(`select (extract(year from age($1::date, $2::date)) * 12 + extract(month from age($1::date, $2::date)))::int m`, [month, first])).rows[0].m) : 0;
    rbt12 = s.rbt12_override ?? (monthsHist >= 12 ? prev12 : monthsHist > 0 ? (prev12 / monthsHist) * 12 : revenue * 12);
    const e = effectiveRateAnexoI(rbt12); rate = e ? e.rate : null;
    method = s.rbt12_override != null ? 'Anexo I (comércio) com RBT12 informado' : monthsHist >= 12 ? 'Anexo I (comércio) com RBT12 dos últimos 12 meses' : 'Anexo I (comércio) com RBT12 proporcionalizado (menos de 12 meses de histórico)';
  } else {
    rate = s.das_effective_pct ?? (await getPricingParams(db, companyId)).tax_pct; method = s.das_effective_pct != null ? 'Alíquota efetiva informada' : 'Alíquota efetiva dos parâmetros de precificação';
  }
  const estimated = rate == null ? 0 : r2(revenue * rate / 100);
  const due = (await db.query(`select ((($1::date + interval '1 month') + interval '19 days')::date) d`, [month])).rows[0].d as Date;
  const dow = due.getDay(); if (dow === 6) due.setDate(due.getDate() + 2); else if (dow === 0) due.setDate(due.getDate() + 1);       // sem tratar feriados
  const dueTxt = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
  return { competence: month, revenue: r2(revenue), effective_rate: rate, rbt12: rbt12 != null ? r2(rbt12) : null, estimated, due_date: dueTxt, method, over_limit: rate == null };
}

export async function fiscalRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Configuração
  app.get('/fiscal/settings', async (req) => { const a = can(req, 'fiscal:view'); return { settings: await getFiscalSettings(pool, a.companyId), providers: Object.values(providers).map((p) => ({ name: p.name, label: p.label, can_emit: p.canEmit, simulated: p.simulated })) }; });
  app.put('/fiscal/settings', async (req) => {
    const a = can(req, 'fiscal:approve');
    const b = z.object({ provider: z.enum(['manual', 'simulado']), environment: z.enum(['homologacao', 'producao']), series_nfe: z.coerce.number().int().min(1).max(999), series_nfce: z.coerce.number().int().min(1).max(999), use_nfce_for_counter: z.boolean(),
      cancel_window_hours: z.coerce.number().int().min(1).max(720), das_mode: z.enum(['manual', 'anexo_i']), das_effective_pct: z.coerce.number().min(0).max(33).nullable(), rbt12_override: z.coerce.number().min(0).max(1e9).nullable(), ibs_cbs_enabled: z.boolean() }).parse(req.body);
    if (b.provider === 'simulado' && b.environment === 'producao') throw new HttpError(422, 'O provedor simulado não pode ser usado em produção (sem valor fiscal).');
    const before = await getFiscalSettings(pool, a.companyId);
    await pool.query(`insert into company_settings (company_id, key, value) values ($1,'fiscal',$2) on conflict (company_id, key) do update set value = $2, updated_at = now()`, [a.companyId, JSON.stringify(b)]);
    await audit(pool, a, 'settings', 'fiscal', 'update', before, b); return b;
  });

  // ---------------------------------------------------------------- Documentos
  app.get('/fiscal/pending-sales', async (req) => {
    const a = can(req, 'fiscal:view');
    const r = await pool.query(`select s.id, s.number, s.type, s.total, s.confirmed_at, c.legal_name as customer_name, c.type as customer_type, c.document,
        (select d.status from fiscal_documents d where d.sale_id = s.id and d.kind = 'venda' order by d.created_at desc limit 1) as last_status
      from sales s left join customers c on c.id = s.customer_id where s.company_id = $1 and s.status = 'concluida'
        and not exists (select 1 from fiscal_documents d where d.sale_id = s.id and d.kind = 'venda' and d.status in ('rascunho','autorizada')) order by s.confirmed_at limit 300`, [a.companyId]);
    return { items: r.rows };
  });
  app.post('/fiscal/documents/from-sale', async (req, reply) => {
    const a = can(req, 'fiscal:create'); const b = z.object({ sale_id: z.string().uuid(), model: z.enum(['55', '65']).optional() }).parse(req.body);
    try { return reply.code(201).send(await tx((db) => createDraft(db, a, b.sale_id, { model: b.model }))); } catch (e) { return dupFriendly(e); }
  });
  app.post('/fiscal/documents/prepare-pending', async (req) => {
    const a = can(req, 'fiscal:create'); const pending = (await pool.query(`select s.id from sales s where s.company_id = $1 and s.status = 'concluida' and not exists (select 1 from fiscal_documents d where d.sale_id = s.id and d.kind = 'venda' and d.status in ('rascunho','autorizada')) order by s.confirmed_at limit 100`, [a.companyId])).rows;
    let created = 0, withErrors = 0;
    for (const s of pending) { const d = await tx((db) => createDraft(db, a, s.id)).catch(() => null); if (d) { created++; if (d.validation.errors.length) withErrors++; } }
    return { created, with_errors: withErrors, ready: created - withErrors };
  });
  app.get('/fiscal/documents', async (req) => {
    const a = can(req, 'fiscal:view'); const q = req.query as Record<string, string>; const { page, pageSize, offset } = pageParams(q);
    const p: unknown[] = [a.companyId]; let w = 'd.company_id = $1';
    for (const f of ['status', 'model', 'kind']) if (q[f]) { p.push(q[f]); w += ` and d.${f} = $${p.length}`; }
    if (q.from) { p.push(q.from); w += ` and d.created_at >= $${p.length}`; } if (q.to) { p.push(q.to); w += ` and d.created_at < ($${p.length}::date + 1)`; }
    if (q.q?.trim()) { p.push(q.q.trim()); w += ` and (d.number::text = $${p.length} or d.access_key = $${p.length} or s.number::text = $${p.length} or unaccent(coalesce(c.legal_name,'')) ilike unaccent('%' || $${p.length} || '%'))`; }
    const from = `from fiscal_documents d left join sales s on s.id = d.sale_id left join customers c on c.id = s.customer_id where ${w}`;
    const [items, total] = await Promise.all([pool.query(`select d.id, d.kind, d.model, d.status, d.series, d.number, d.access_key, d.total, d.simulated, d.provider, d.created_at, d.authorized_at, jsonb_array_length(d.validation->'errors') as errors, jsonb_array_length(d.validation->'warnings') as warnings, s.number as sale_number, c.legal_name as customer_name ${from} order by d.created_at desc limit ${pageSize} offset ${offset}`, p), pool.query(`select count(*)::int n ${from}`, p)]);
    return { items: items.rows, total: total.rows[0].n, page, pageSize };
  });
  app.get('/fiscal/documents/:id', async (req) => {
    const a = can(req, 'fiscal:view'); const id = (req.params as { id: string }).id; const d = await loadDoc(pool, a, id);
    const events = (await pool.query('select e.*, u.name as user_name from fiscal_events e left join users u on u.id = e.created_by where e.document_id = $1 order by e.created_at', [id])).rows;
    const sale = d.sale_id ? (await pool.query('select number from sales where id = $1', [d.sale_id])).rows[0] : null; const { xml, ...rest } = d;
    return { ...rest, has_xml: !!xml, sale_number: sale?.number ?? null, events };
  });
  app.post('/fiscal/documents/:id/revalidate', async (req) => {
    const a = can(req, 'fiscal:edit'); const id = (req.params as { id: string }).id;
    return tx(async (db) => {
      const d = await loadDoc(db, a, id, true); if (!['rascunho', 'rejeitada'].includes(d.status)) throw new HttpError(409, `Documento ${d.status} não pode ser revalidado.`);
      const ret = d.kind === 'devolucao_venda' ? d.payload.itens.map((i: any) => ({ product_id: i.product_id, qty: i.quantidade })) : undefined;
      const b = await buildFiscalPayload(db, a.companyId, d.sale_id, { model: d.model, kind: d.kind, returnItems: ret, refKey: d.payload.referencias?.[0]?.refNFe ?? null });
      await db.query(`update fiscal_documents set payload = $2, validation = $3, total = $4, status = 'rascunho', series = $5, environment = $6, provider = $7, simulated = $8 where id = $1`,
        [id, JSON.stringify(b.payload), JSON.stringify(b.validation), b.payload.totais.valor_nf, b.payload.ide.serie, b.settings.environment, b.settings.provider, providers[b.settings.provider].simulated]);
      return { validation: b.validation };
    });
  });
  app.delete('/fiscal/documents/:id', async (req) => {
    const a = can(req, 'fiscal:delete'); const id = (req.params as { id: string }).id; const d = await loadDoc(pool, a, id);
    if (d.status !== 'rascunho') throw new HttpError(409, 'Somente rascunhos podem ser excluídos.');
    await pool.query('delete from fiscal_documents where id = $1', [id]); await audit(pool, a, 'fiscal_document', id, 'delete', { sale: d.sale_id }, null); return { deleted: true };
  });

  app.post('/fiscal/documents/:id/emit', async (req) => {
    const a = can(req, 'fiscal:create'); const id = (req.params as { id: string }).id;
    return tx(async (db) => {
      let d = await loadDoc(db, a, id, true); if (!['rascunho', 'rejeitada'].includes(d.status)) throw new HttpError(409, `Documento ${d.status}.`);
      const settings = await getFiscalSettings(db, a.companyId); const prov = providers[settings.provider];
      if (!prov.canEmit) throw new HttpError(409, 'O provedor configurado é manual: emita a nota no seu sistema/portal e use "Registrar nota emitida".', 'manual_provider');
      if (prov.simulated && settings.environment === 'producao') throw new HttpError(422, 'Provedor simulado não pode ser usado em produção.');
      const ret = d.kind === 'devolucao_venda' ? d.payload.itens.map((i: any) => ({ product_id: i.product_id, qty: i.quantidade })) : undefined;
      const b = await buildFiscalPayload(db, a.companyId, d.sale_id, { model: d.model, kind: d.kind, returnItems: ret, refKey: d.payload.referencias?.[0]?.refNFe ?? null });
      if (b.validation.errors.length) { await db.query('update fiscal_documents set payload = $2, validation = $3 where id = $1', [id, JSON.stringify(b.payload), JSON.stringify(b.validation)]); throw new HttpError(422, 'Corrija os erros do documento antes de emitir.', 'validation_failed', { validation: b.validation }); }
      const series = b.payload.ide.serie;
      const res = await prov.emit({ payload: b.payload, model: d.model, environment: settings.environment, series, nextNumber: () => nextNumber(db, a.companyId, `nf-${d.model}-${series}-${settings.environment}`) });
      if (res.status === 'autorizada') {
        await db.query(`update fiscal_documents set status = 'autorizada', payload = $2, validation = $3, series = $4, number = $5, access_key = $6, protocol = $7, xml = $8, provider = $9, simulated = $10, environment = $11, issued_at = now(), authorized_at = now(), provider_message = $12 where id = $1`,
          [id, JSON.stringify(b.payload), JSON.stringify(b.validation), res.series, res.number, res.access_key, res.protocol, res.xml, prov.name, prov.simulated, settings.environment, res.message]);
        await db.query(`insert into fiscal_events (company_id, document_id, type, protocol, xml, text, created_by) values ($1,$2,'autorizacao',$3,$4,$5,$6)`, [a.companyId, id, res.protocol, res.xml, res.message, a.userId]);
        await audit(db, a, 'fiscal_document', id, 'authorized', null, { number: res.number, key: res.access_key, provider: prov.name, simulated: prov.simulated });
      } else {
        await db.query(`update fiscal_documents set status = 'rejeitada', provider_message = $2 where id = $1`, [id, res.message]);
        await db.query(`insert into fiscal_events (company_id, document_id, type, text, created_by) values ($1,$2,'rejeicao',$3,$4)`, [a.companyId, id, res.message, a.userId]);
      }
      d = await loadDoc(db, a, id); return { status: d.status, number: d.number, access_key: d.access_key, message: d.provider_message, simulated: d.simulated };
    });
  });

  /** Registro de nota emitida fora do sistema (provedor manual): valida chave (DV, CNPJ, modelo, série, número, UF) e, se houver XML, confere chave e total. */
  app.post('/fiscal/documents/:id/register-manual', async (req) => {
    const a = can(req, 'fiscal:create'); const id = (req.params as { id: string }).id;
    const b = z.object({ access_key: z.string().regex(/^\d{44}$/, 'Chave de acesso deve ter 44 dígitos'), protocol: z.string().trim().min(8).max(30), issue_date: z.string().date().optional(), xml: z.string().max(3_000_000).optional() }).parse(req.body);
    return tx(async (db) => {
      const d = await loadDoc(db, a, id, true); if (!['rascunho', 'rejeitada'].includes(d.status)) throw new HttpError(409, `Documento ${d.status}.`);
      if (d.validation.errors.length) throw new HttpError(422, 'Revalide o documento: há erros pendentes.', 'validation_failed', { validation: d.validation });
      const k = parseAccessKey(b.access_key); if (!k) throw new HttpError(422, 'Chave de acesso inválida (dígito verificador não confere).');
      const em = d.payload.emitente;
      if (k.cnpj !== em.cnpj) throw new HttpError(422, 'O CNPJ da chave não é o do emitente deste documento.');
      if (k.model !== d.model) throw new HttpError(422, `A chave é de modelo ${k.model}, mas o documento é modelo ${d.model}.`);
      if (k.uf !== (await import('../fiscal/rules.js')).UF_CODE[em.uf]) throw new HttpError(422, 'A UF da chave não é a UF do emitente.');
      if (b.xml) {
        let n; try { n = parseNFe(b.xml); } catch (e) { throw new HttpError(422, `XML inválido: ${(e as Error).message}`); }
        if (n.key && n.key !== b.access_key) throw new HttpError(422, 'A chave do XML difere da chave informada.');
        if (Math.abs(n.totals.nf - Number(d.total)) > 0.01) throw new HttpError(422, `O valor da nota no XML (R$ ${n.totals.nf.toFixed(2)}) difere do documento (R$ ${Number(d.total).toFixed(2)}).`);
      }
      await db.query(`update fiscal_documents set status = 'autorizada', series = $2, number = $3, access_key = $4, protocol = $5, xml = $6, issued_at = coalesce($7::timestamptz, now()), authorized_at = coalesce($7::timestamptz, now()), provider = 'manual', simulated = false, provider_message = 'Registrada manualmente (emitida fora do sistema)' where id = $1`,
        [id, k.series, k.number, b.access_key, b.protocol, b.xml ?? null, b.issue_date ?? null]);
      await db.query(`insert into fiscal_events (company_id, document_id, type, protocol, xml, text, created_by) values ($1,$2,'registro_manual',$3,$4,'Nota emitida fora do sistema e registrada',$5)`, [a.companyId, id, b.protocol, b.xml ?? null, a.userId]);
      await audit(db, a, 'fiscal_document', id, 'registered_manual', null, { number: k.number, series: k.series, key: b.access_key }); return { status: 'autorizada', number: k.number, series: k.series };
    });
  });

  app.post('/fiscal/documents/:id/cancel', async (req) => {
    const a = can(req, 'fiscal:approve'); const id = (req.params as { id: string }).id;
    const b = z.object({ reason: z.string().trim().min(15, 'A justificativa deve ter ao menos 15 caracteres').max(255), protocol: text(30) }).parse(req.body);
    return tx(async (db) => {
      const d = await loadDoc(db, a, id, true); if (d.status !== 'autorizada') throw new HttpError(409, `Documento ${d.status}.`);
      const settings = await getFiscalSettings(db, a.companyId); const hours = (Date.now() - new Date(d.authorized_at ?? d.issued_at).getTime()) / 3600000;
      if (hours > settings.cancel_window_hours) throw new HttpError(409, `Prazo de cancelamento (${settings.cancel_window_hours} h) expirado. Emita nota de devolução ou solicite cancelamento extemporâneo à SEFAZ do seu estado.`, 'window_expired');
      const prov = providers[d.provider] ?? providers.manual; const ev = d.simulated ? await providers.simulado.cancel({ accessKey: d.access_key, reason: b.reason }) : await prov.cancel({ accessKey: d.access_key, reason: b.reason });
      const protocol = ev?.protocol ?? b.protocol; if (!protocol) throw new HttpError(422, 'Informe o protocolo do evento de cancelamento obtido na SEFAZ/provedor.', 'protocol_required');
      await db.query(`update fiscal_documents set status = 'cancelada', cancel_reason = $2, cancelled_at = now(), cancel_protocol = $3 where id = $1`, [id, b.reason, protocol]);
      await db.query(`insert into fiscal_events (company_id, document_id, type, text, protocol, created_by) values ($1,$2,'cancelamento',$3,$4,$5)`, [a.companyId, id, b.reason, protocol, a.userId]);
      await audit(db, a, 'fiscal_document', id, 'cancelled', { status: 'autorizada' }, { reason: b.reason, protocol }); return { status: 'cancelada', protocol };
    });
  });
  app.post('/fiscal/documents/:id/correction', async (req) => {
    const a = can(req, 'fiscal:edit'); const id = (req.params as { id: string }).id;
    const b = z.object({ text: z.string().trim().min(15, 'O texto da correção deve ter ao menos 15 caracteres').max(1000), protocol: text(30) }).parse(req.body);
    return tx(async (db) => {
      const d = await loadDoc(db, a, id, true); if (d.status !== 'autorizada' || d.kind !== 'venda' || d.model !== '55') throw new HttpError(409, 'Carta de correção só se aplica a NF-e autorizada.');
      const seq = Number((await db.query(`select coalesce(max(seq),0) m from fiscal_events where document_id = $1 and type = 'cce'`, [id])).rows[0].m) + 1; if (seq > 20) throw new HttpError(409, 'Limite de 20 cartas de correção atingido.');
      const prov = d.simulated ? providers.simulado : providers[d.provider] ?? providers.manual; const ev = await prov.correct({ accessKey: d.access_key, text: b.text, seq });
      const protocol = ev?.protocol ?? b.protocol; if (!protocol) throw new HttpError(422, 'Informe o protocolo da CC-e obtido na SEFAZ/provedor.', 'protocol_required');
      await db.query(`insert into fiscal_events (company_id, document_id, type, seq, text, protocol, created_by) values ($1,$2,'cce',$3,$4,$5,$6)`, [a.companyId, id, seq, b.text, protocol, a.userId]);
      await audit(db, a, 'fiscal_document', id, 'cce', null, { seq, text: b.text }); return { seq, protocol, note: 'A CC-e não pode alterar valores, impostos, dados do destinatário que mudem o destinatário, nem datas.' };
    });
  });
  /** Nota de devolução de venda (entrada própria, CFOP 1202/2202) referenciando a nota original. Não movimenta estoque/financeiro: isso é tratado pelo módulo de devoluções. */
  app.post('/fiscal/documents/return', async (req, reply) => {
    const a = can(req, 'fiscal:create'); const b = z.object({ document_id: z.string().uuid(), items: z.array(z.object({ product_id: z.string().uuid(), qty: z.coerce.number().positive() })).min(1), reason: z.string().trim().min(5).max(200) }).parse(req.body);
    const row = await tx(async (db) => {
      const o = await loadDoc(db, a, b.document_id, true); if (o.status !== 'autorizada' || o.kind !== 'venda') throw new HttpError(409, 'A devolução exige uma nota de venda autorizada.');
      const prev = (await db.query(`select payload from fiscal_documents where original_doc_id = $1 and status in ('rascunho','autorizada')`, [o.id])).rows;
      for (const it of b.items) { const done = prev.flatMap((p) => p.payload.itens).filter((i: any) => i.product_id === it.product_id).reduce((s: number, i: any) => s + i.quantidade, 0);
        const sold = o.payload.itens.find((i: any) => i.product_id === it.product_id)?.quantidade ?? 0; if (it.qty + done > sold + 1e-9) throw new HttpError(422, 'Quantidade a devolver excede o saldo ainda não devolvido da nota.'); }
      const d = await createDraft(db, a, o.sale_id, { model: '55', kind: 'devolucao_venda', returnItems: b.items, originalId: o.id, refKey: o.access_key });
      await db.query(`update fiscal_documents set payload = jsonb_set(payload, '{informacoes_complementares}', to_jsonb(($2)::text)) where id = $1`, [d.id, `${o.payload.informacoes_complementares} Devolução ref. NF-e ${o.number}: ${b.reason}`]);
      return d;
    });
    return reply.code(201).send(row);
  });

  // ---------------------------------------------------------------- XMLs (emitidos e recebidos)
  app.get('/fiscal/documents/:id/xml', async (req, reply) => {
    const a = can(req, 'fiscal:view'); const d = await loadDoc(pool, a, (req.params as { id: string }).id);
    if (!d.xml) throw new HttpError(404, 'Documento sem XML armazenado.'); return reply.header('content-type', 'application/xml; charset=utf-8').header('content-disposition', `attachment; filename="NFe-${d.access_key ?? d.id}.xml"`).send(d.xml);
  });
  app.get('/fiscal/xmls', async (req) => {
    const a = can(req, 'fiscal:view'); const q = req.query as Record<string, string>; const from = q.from || '1900-01-01', to = q.to || '2999-12-31';
    const out = (await pool.query(`select 'emitida' as origin, d.id, d.model, d.number, d.access_key, d.status, d.total, coalesce(d.authorized_at, d.created_at) as at, c.legal_name as party, d.simulated
        from fiscal_documents d left join sales s on s.id = d.sale_id left join customers c on c.id = s.customer_id where d.company_id = $1 and d.xml is not null and coalesce(d.authorized_at, d.created_at)::date between $2 and $3`, [a.companyId, from, to])).rows;
    const inn = (await pool.query(`select 'recebida' as origin, r.id, '55' as model, r.nf_number as number, r.nf_key as access_key, r.status, r.total_nf as total, r.created_at as at, s.legal_name as party, false as simulated
        from receivings r join suppliers s on s.id = r.supplier_id where r.company_id = $1 and r.xml is not null and r.created_at::date between $2 and $3`, [a.companyId, from, to])).rows;
    const items = [...out, ...inn].filter((x) => !q.origin || x.origin === q.origin).sort((x, y) => +new Date(y.at) - +new Date(x.at));
    return { items };
  });
  app.get('/fiscal/xmls/received/:id', async (req, reply) => {
    const a = can(req, 'fiscal:view'); const r = (await pool.query('select xml, nf_key, id from receivings where id = $1 and company_id = $2', [(req.params as { id: string }).id, a.companyId])).rows[0];
    if (!r?.xml) throw new HttpError(404, 'XML não encontrado.'); return reply.header('content-type', 'application/xml; charset=utf-8').header('content-disposition', `attachment; filename="NFe-${r.nf_key ?? r.id}.xml"`).send(r.xml);
  });

  // ---------------------------------------------------------------- Impostos (painel do DAS)
  app.get('/taxes/panel', async (req) => {
    const a = can(req, 'fiscal:view'); const year = z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()).parse((req.query as { year?: string }).year);
    const months = []; let totals = { estimated: 0, official: 0, paid: 0 };
    for (let m = 1; m <= 12; m++) {
      const comp = `${year}-${String(m).padStart(2, '0')}-01`; const est = await dasEstimate(pool, a.companyId, comp);
      let ob = (await pool.query(`select o.*, p.status as payable_status from tax_obligations o left join payables p on p.id = o.payable_id where o.company_id = $1 and o.tax = 'DAS' and o.competence = $2`, [a.companyId, comp])).rows[0] ?? null;
      if (ob && ob.payable_status === 'pago' && ob.status !== 'pago') { await pool.query(`update tax_obligations set status = 'pago' where id = $1`, [ob.id]); ob = { ...ob, status: 'pago' }; }
      const value = ob ? Number(ob.amount ?? ob.estimated_amount) : est.estimated;
      if (est.revenue > 0 || ob) { totals.estimated += est.estimated; if (ob?.amount != null) totals.official += Number(ob.amount); if (ob?.status === 'pago') totals.paid += value; }
      months.push({ ...est, obligation: ob ? { id: ob.id, status: ob.status, amount: ob.amount, estimated_amount: ob.estimated_amount, due_date: ob.due_date, guide_ref: ob.guide_ref, receipt_note: ob.receipt_note, payable_id: ob.payable_id } : null, status: ob?.status ?? (est.revenue > 0 ? 'estimado' : 'sem faturamento') });
    }
    return { year, months, totals: { estimated: r2(totals.estimated), official: r2(totals.official), paid: r2(totals.paid) }, settings: await getFiscalSettings(pool, a.companyId),
      disclaimer: 'Valores ESTIMADOS a partir do faturamento das vendas concluídas. O DAS devido é o apurado no PGDAS-D pelo contador; informe o valor oficial da guia para que ele passe a valer.' };
  });
  app.post('/taxes/obligations/generate', async (req, reply) => {
    const a = can(req, 'fiscal:create'); const { competence } = z.object({ competence: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body); const comp = `${competence}-01`;
    return tx(async (db) => {
      const e = await dasEstimate(db, a.companyId, comp);
      if (e.over_limit) throw new HttpError(422, 'RBT12 acima do teto do Simples Nacional (R$ 4,8 milhões): fale com o contador.');
      const ex = (await db.query(`select * from tax_obligations where company_id = $1 and tax = 'DAS' and competence = $2 for update`, [a.companyId, comp])).rows[0];
      if (ex && ex.status !== 'previsto') throw new HttpError(409, 'Obrigação já tem guia/pagamento: não é regenerada.');
      const row = (await db.query(`insert into tax_obligations (company_id, tax, competence, estimated_amount, due_date, revenue, effective_rate, rbt12, method, created_by) values ($1,'DAS',$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (company_id, tax, competence) do update set estimated_amount = excluded.estimated_amount, due_date = excluded.due_date, revenue = excluded.revenue, effective_rate = excluded.effective_rate, rbt12 = excluded.rbt12, method = excluded.method returning *`,
        [a.companyId, comp, e.estimated, e.due_date, e.revenue, e.effective_rate, e.rbt12, e.method, a.userId])).rows[0];
      await audit(db, a, 'tax_obligation', row.id, ex ? 'regenerate' : 'create', ex, row); return reply.code(201).send(row);
    });
  });
  app.patch('/taxes/obligations/:id', async (req) => {
    const a = can(req, 'fiscal:edit'); const id = (req.params as { id: string }).id;
    const b = z.object({ amount: z.coerce.number().min(0).max(1e9).optional(), due_date: z.string().date().optional(), guide_ref: text(80), receipt_note: text(200) }).parse(req.body);
    return tx(async (db) => {
      const o = (await db.query('select * from tax_obligations where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0]; if (!o) throw new HttpError(404, 'Obrigação não encontrada.');
      if (o.status === 'pago' && b.amount != null) throw new HttpError(409, 'Obrigação paga: valor não pode mudar.');
      const status = o.status === 'previsto' && b.amount != null ? 'a_pagar' : o.status;
      const r = (await db.query(`update tax_obligations set amount = coalesce($2, amount), due_date = coalesce($3, due_date), guide_ref = coalesce($4, guide_ref), receipt_note = coalesce($5, receipt_note), status = $6 where id = $1 returning *`, [id, b.amount ?? null, b.due_date ?? null, b.guide_ref ?? null, b.receipt_note ?? null, status])).rows[0];
      if (o.payable_id && (b.amount != null || b.due_date)) await db.query(`update payables set amount = coalesce($2, amount), due_date = coalesce($3, due_date) where id = $1 and status = 'aberto'`, [o.payable_id, b.amount ?? null, b.due_date ?? null]);
      await audit(db, a, 'tax_obligation', id, 'update', o, r); return r;
    });
  });
  /** Gera o título no contas a pagar (categoria Simples Nacional — DAS). O pagamento é feito/baixado no financeiro e reflete aqui. */
  app.post('/taxes/obligations/:id/payable', async (req) => {
    const a = can(req, 'fiscal:edit'); can(req, 'finance:create'); const id = (req.params as { id: string }).id; const { use_estimate } = z.object({ use_estimate: z.boolean().default(false) }).parse(req.body ?? {});
    return tx(async (db) => {
      const o = (await db.query('select * from tax_obligations where id = $1 and company_id = $2 for update', [id, a.companyId])).rows[0]; if (!o) throw new HttpError(404, 'Obrigação não encontrada.');
      if (o.payable_id) throw new HttpError(409, 'Já existe título a pagar para esta obrigação.');
      if (o.amount == null && !use_estimate) throw new HttpError(422, 'Informe o valor oficial da guia (PGDAS-D) ou confirme o uso da estimativa.', 'amount_required');
      const amount = Number(o.amount ?? o.estimated_amount); if (!(amount > 0)) throw new HttpError(422, 'Valor zerado: não há o que pagar.');
      const cc = (await db.query(`select id from cost_centers where company_id = $1 and name = 'Financeiro'`, [a.companyId])).rows[0];
      const p = (await db.query(`insert into payables (company_id, due_date, amount, description, category_id, cost_center_id, competence, doc_number) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [a.companyId, o.due_date, amount, `DAS ${String(o.competence).slice(0, 7)}${o.amount == null ? ' (estimativa)' : ''}`, await categoryId(db, a.companyId, 'Simples Nacional (DAS)'), cc?.id ?? null, o.competence, o.guide_ref])).rows[0];
      await db.query(`update tax_obligations set payable_id = $2, status = 'a_pagar' where id = $1`, [id, p.id]);
      await postTaxTrueUp(db, id);
      await audit(db, a, 'tax_obligation', id, 'payable_created', null, { payable_id: p.id, amount, estimate: o.amount == null }); return { payable_id: p.id, amount };
    });
  });
}
