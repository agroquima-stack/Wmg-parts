import { useEffect, useState } from 'react';
import { api, ApiError, brl, get, qs } from './api';
import { useAuth } from './auth';
import { Modal } from './DataPage';

const Err = ({ e }: { e: string }) => (e ? <div className="err">{e}</div> : null);
const date = (v: any) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '—');
const n = (v: any) => Number(v ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });

// ---------------------------------------------------------------- Nova devolução (a partir de uma venda)
export function ReturnModal({ saleId, onClose, onDone }: { saleId: string; onClose(): void; onDone(): void }) {
  const [d, setD] = useState<any>(null); const [sel, setSel] = useState<Record<string, { qty: string; condition: string }>>({}); const [reason, setReason] = useState(''); const [err, setErr] = useState(''); const [res, setRes] = useState<any>(null);
  useEffect(() => { get(`/sales/${saleId}/returnable`).then(setD).catch((e) => setErr(e.message)); }, [saleId]);
  if (!d) return <Modal onClose={onClose}><Err e={err} /></Modal>;
  const lines = d.items.filter((i: any) => Number(sel[i.sale_item_id]?.qty) > 0); const total = lines.reduce((s: number, i: any) => s + Number(sel[i.sale_item_id].qty) * i.unit_price, 0);
  const save = async () => { setErr(''); try { setRes(await api('POST', '/sale-returns', { sale_id: saleId, reason, items: lines.map((i: any) => ({ sale_item_id: i.sale_item_id, qty: Number(sel[i.sale_item_id].qty), condition: sel[i.sale_item_id].condition || 'revenda' })) })); } catch (e) { setErr((e as ApiError).message); } };
  if (res) return <Modal onClose={() => { onDone(); }}><h3 style={{ marginTop: 0 }}>Devolução nº {res.number} registrada</h3><p>Total devolvido: <b>{brl(res.total)}</b>.</p>
    {Number(res.abated) > 0 && <div className="alert green">{brl(res.abated)} abatidos dos títulos em aberto da venda.</div>}{Number(res.refunded) > 0 && <div className="alert yellow">{brl(res.refunded)} a restituir ao cliente: criado em Contas a pagar.</div>}
    {res.requires_fiscal_return && <div className="alert red">Esta venda tem NF-e autorizada: emita a nota fiscal de devolução em Fiscal → Notas.</div>}<div className="right"><button className="primary" onClick={onDone}>Fechar</button></div></Modal>;
  return <Modal onClose={onClose}><h3 style={{ marginTop: 0 }}>Devolução — venda nº {d.sale.number}</h3><p className="muted">{d.sale.customer_name ?? 'Consumidor final'}. Informe quanto volta de cada item e em que condição. Títulos em aberto são abatidos; o que já foi pago é restituído.</p>
    <table><thead><tr><th>Produto</th><th className="num">Vendido</th><th className="num">Já devolvido</th><th className="num">Devolver</th><th>Condição</th></tr></thead><tbody>{d.items.map((i: any) => <tr key={i.sale_item_id}><td>{i.sku} — {i.description}</td><td className="num">{n(i.qty)}</td><td className="num">{n(i.returned)}</td>
      <td className="num"><input style={{ width: 80 }} type="number" min="0" max={i.remaining} step="1" disabled={i.remaining <= 0} value={sel[i.sale_item_id]?.qty ?? ''} onChange={(e) => setSel({ ...sel, [i.sale_item_id]: { ...sel[i.sale_item_id], condition: sel[i.sale_item_id]?.condition ?? 'revenda', qty: e.target.value } })} /></td>
      <td><select value={sel[i.sale_item_id]?.condition ?? 'revenda'} onChange={(e) => setSel({ ...sel, [i.sale_item_id]: { ...sel[i.sale_item_id], qty: sel[i.sale_item_id]?.qty ?? '', condition: e.target.value } })}><option value="revenda">Volta ao estoque para revenda</option><option value="avariado">Avariado / defeito</option></select></td></tr>)}</tbody></table>
    <input style={{ margin: '8px 0' }} placeholder="Motivo da devolução" value={reason} onChange={(e) => setReason(e.target.value)} /><div>Total a devolver: <b>{brl(total)}</b></div><Err e={err} />
    <div className="right"><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!lines.length || reason.trim().length < 3} onClick={save}>Registrar devolução</button></div></Modal>;
}

export function SaleReturns() {
  const { can } = useAuth(); const [d, setD] = useState<any>({ items: [] }); const [q, setQ] = useState(''); const [open, setOpen] = useState<any>(null); const [err, setErr] = useState('');
  const [pick, setPick] = useState(false); const [sales, setSales] = useState<any[]>([]); const [sq, setSq] = useState(''); const [retSale, setRetSale] = useState<string | null>(null);
  const load = () => get('/sale-returns' + qs({ q })).then(setD).catch((e) => setErr(e.message)); useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [q]); // eslint-disable-line
  useEffect(() => { if (pick) get('/sales' + qs({ status: 'concluida', q: sq, pageSize: 8 })).then((r) => setSales(r.items)); }, [pick, sq]);
  return <><h1>Devoluções de venda</h1><p className="sub">Devolução total ou parcial de vendas concluídas. O estoque volta, o título é abatido (ou o valor é restituído), e a contabilidade, o imposto estimado e a comissão acompanham.</p>
    <div className="toolbar"><input placeholder="Nº, venda ou cliente…" value={q} onChange={(e) => setQ(e.target.value)} /><span style={{ flex: 1 }} />{can('returns:approve') && <button className="primary" onClick={() => setPick(true)}>+ Nova devolução</button>}</div><Err e={err} />
    <table><thead><tr><th>Nº</th><th>Data</th><th>Venda</th><th>Cliente</th><th>Motivo</th><th className="num">Total</th><th className="num">Abatido</th><th className="num">A restituir</th><th /></tr></thead><tbody>
      {d.items.map((r: any) => <tr key={r.id} className="click" onClick={() => get(`/sale-returns/${r.id}`).then(setOpen)}><td>{r.number}</td><td>{date(r.created_at)}</td><td>nº {r.sale_number}</td><td>{r.customer_name ?? '—'}</td><td>{r.reason}</td><td className="num">{brl(r.total)}</td><td className="num">{brl(r.abated)}</td><td className="num">{brl(r.refunded)}</td><td>{r.requires_fiscal_return && <span className="pill red">nota de devolução pendente</span>}</td></tr>)}
      {!d.items.length && <tr><td colSpan={9} className="muted">Nenhuma devolução.</td></tr>}</tbody></table>
    {open && <Modal onClose={() => setOpen(null)}><h3 style={{ marginTop: 0 }}>Devolução nº {open.number} — venda nº {open.sale_number}</h3><p className="muted">{open.customer_name ?? 'Consumidor final'} · {open.reason}</p>
      <table><thead><tr><th>Produto</th><th className="num">Qtd</th><th className="num">Unit.</th><th className="num">Total</th><th>Condição</th></tr></thead><tbody>{open.items.map((i: any) => <tr key={i.id}><td>{i.sku} {i.description}</td><td className="num">{n(i.qty)}</td><td className="num">{brl(i.unit_price)}</td><td className="num">{brl(i.total)}</td><td>{i.condition}</td></tr>)}</tbody></table>
      <p>Abatido de títulos: <b>{brl(open.abated)}</b> · A restituir: <b>{brl(open.refunded)}</b> · Imposto estimado estornado: {brl(open.tax_total)} · Comissão estornada: {brl(open.commission_reversal)}</p><div className="right"><button onClick={() => setOpen(null)}>Fechar</button></div></Modal>}
    {pick && <Modal onClose={() => setPick(false)}><h3 style={{ marginTop: 0 }}>Escolha a venda</h3><input autoFocus placeholder="Nº da venda ou cliente…" value={sq} onChange={(e) => setSq(e.target.value)} />
      <table><tbody>{sales.map((s) => <tr key={s.id} className="click" onClick={() => { setPick(false); setSq(''); setRetSale(s.id); }}><td>nº {s.number}</td><td>{date(s.confirmed_at)}</td><td>{s.customer_name ?? 'Consumidor final'}</td><td className="num">{brl(s.total)}</td></tr>)}</tbody></table></Modal>}
    {retSale && <ReturnModal saleId={retSale} onClose={() => setRetSale(null)} onDone={() => { setRetSale(null); load(); }} />}</>;
}

// ---------------------------------------------------------------- Garantias
const WST: Record<string, [string, string]> = { aberta: ['yellow', 'Aberta'], em_analise: ['yellow', 'Em análise'], recusada: ['gray', 'Recusada'], resolvida: ['green', 'Resolvida'] };
const RES: Record<string, string> = { troca: 'Troca', reembolso: 'Reembolso', reparo: 'Reparo', recusa: 'Recusada' };
function NewClaim({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const [saleQ, setSaleQ] = useState(''); const [sales, setSales] = useState<any[]>([]); const [sale, setSale] = useState<any>(null); const [item, setItem] = useState(''); const [qty, setQty] = useState('1'); const [defect, setDefect] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { if (!sale) get('/sales' + qs({ status: 'concluida', q: saleQ, pageSize: 6 })).then((r) => setSales(r.items)); }, [saleQ, sale]);
  const pickSale = async (s: any) => { const r = await get(`/sales/${s.id}/returnable`); setSale({ ...s, items: r.items }); setItem(r.items[0]?.sale_item_id ?? ''); };
  const save = async () => { setErr(''); try { await api('POST', '/warranty', { sale_item_id: item, qty: Number(qty), defect }); onDone(); } catch (e) { setErr((e as ApiError).message); } };
  return <Modal onClose={onClose}><h3 style={{ marginTop: 0 }}>Nova solicitação de garantia</h3>
    {!sale ? <><input autoFocus placeholder="Venda (nº) ou cliente…" value={saleQ} onChange={(e) => setSaleQ(e.target.value)} /><table><tbody>{sales.map((s) => <tr key={s.id} className="click" onClick={() => pickSale(s)}><td>nº {s.number}</td><td>{date(s.confirmed_at)}</td><td>{s.customer_name ?? 'Consumidor final'}</td><td className="num">{brl(s.total)}</td></tr>)}</tbody></table></>
      : <><p className="muted">Venda nº {sale.number} · {sale.customer_name ?? 'Consumidor final'} <button onClick={() => setSale(null)}>trocar</button></p>
        <div className="toolbar"><select value={item} onChange={(e) => setItem(e.target.value)}>{sale.items.map((i: any) => <option key={i.sale_item_id} value={i.sale_item_id}>{i.sku} — {i.description}</option>)}</select><input style={{ width: 90 }} type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
        <textarea rows={3} style={{ width: '100%' }} placeholder="Descreva o defeito" value={defect} onChange={(e) => setDefect(e.target.value)} /></>}
    <Err e={err} /><div className="right"><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!sale || defect.trim().length < 5} onClick={save}>Abrir solicitação</button></div></Modal>;
}
function ClaimDetail({ c, onClose, onDone }: { c: any; onClose(): void; onDone(): void }) {
  const { can } = useAuth(); const [note, setNote] = useState(''); const [goodwill, setGoodwill] = useState(false); const [err, setErr] = useState(''); const [sups, setSups] = useState<any[]>([]); const [sup, setSup] = useState({ supplier_id: '', amount: '' });
  useEffect(() => { get('/suppliers?pageSize=100').then((r) => setSups(r.items)).catch(() => {}); }, []);
  const run = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); onDone(); } catch (e) { setErr((e as ApiError).message); } };
  const open = ['aberta', 'em_analise'].includes(c.status); const [cls, label] = WST[c.status];
  return <Modal onClose={onClose}><h3 style={{ marginTop: 0 }}>Garantia nº {c.number} <span className={`pill ${cls}`}>{label}</span> {c.resolution && <span className="pill gray">{RES[c.resolution]}</span>}</h3>
    <p><b>{c.sku}</b> — {c.description} · {n(c.qty)} un. · {c.customer_name ?? 'sem cliente'}{c.sale_number && <> · venda nº {c.sale_number}</>}</p>
    <p className="muted">Defeito: {c.defect}</p>
    <div className={`alert ${c.in_warranty === false ? 'red' : c.in_warranty ? 'green' : 'yellow'}`}>{c.in_warranty == null ? 'Sem data de compra: prazo de garantia não verificado.' : c.in_warranty ? `Dentro do prazo de garantia (${c.warranty_days} dias; compra em ${date(c.purchased_txt)}).` : `Fora do prazo de garantia (${c.warranty_days} dias; compra em ${date(c.purchased_txt)}).`}</div>
    {c.decision_note && <p>Decisão: {c.decision_note}</p>}
    {open && can('returns:approve') && <div className="card" style={{ marginTop: 8 }}><b>Decidir</b><input style={{ margin: '6px 0' }} placeholder="Justificativa (obrigatória)" value={note} onChange={(e) => setNote(e.target.value)} />
      {c.in_warranty === false && <label className="chk"><input type="checkbox" checked={goodwill} onChange={(e) => setGoodwill(e.target.checked)} />Concessão comercial (atender mesmo fora do prazo)</label>}
      <div className="toolbar">{['troca', 'reembolso', 'reparo'].map((r) => <button key={r} className="primary" disabled={note.trim().length < 3} onClick={() => run(() => api('POST', `/warranty/${c.id}/resolve`, { resolution: r, note, goodwill }))}>{RES[r]}</button>)}
        <button className="danger" disabled={note.trim().length < 3} onClick={() => run(() => api('POST', `/warranty/${c.id}/resolve`, { resolution: 'recusa', note }))}>Recusar</button>{c.status === 'aberta' && can('returns:edit') && <button onClick={() => run(() => api('POST', `/warranty/${c.id}/analysis`, { note }))}>Marcar em análise</button>}</div>
      <p className="muted">Troca: sai uma unidade nova e a defeituosa entra como avariada. Reembolso: gera devolução da venda (abate o título ou restitui).</p></div>}
    {Number(c.defective_pending) > 0 && can('returns:approve') && <div className="card" style={{ marginTop: 8 }}><b>Unidade defeituosa aguardando o fornecedor</b> ({n(c.defective_pending)} un. em estoque avariado)
      <div className="toolbar" style={{ marginTop: 6 }}><select value={sup.supplier_id} onChange={(e) => setSup({ ...sup, supplier_id: e.target.value })}><option value="">Fornecedor…</option>{sups.map((s) => <option key={s.id} value={s.id}>{s.legal_name}</option>)}</select><input style={{ width: 120 }} type="number" step="0.01" placeholder="Crédito (R$)" value={sup.amount} onChange={(e) => setSup({ ...sup, amount: e.target.value })} />
        <button className="primary" disabled={!sup.supplier_id || !(Number(sup.amount) > 0)} onClick={() => run(() => api('POST', `/warranty/${c.id}/supplier`, { outcome: 'credito', supplier_id: sup.supplier_id, amount: Number(sup.amount) }))}>Fornecedor deu crédito</button>
        <button className="danger" onClick={() => confirm('Registrar a recusa do fornecedor? A perda será reconhecida.') && run(() => api('POST', `/warranty/${c.id}/supplier`, { outcome: 'recusado' }))}>Fornecedor recusou</button></div></div>}
    {c.supplier_status !== 'nenhum' && <p className="muted">Fornecedor: {c.supplier_status === 'credito' ? `crédito de ${brl(c.supplier_amount)} (${c.supplier_name ?? ''})` : 'recusou — perda reconhecida'}.</p>}
    <Err e={err} /><div className="right"><button onClick={onClose}>Fechar</button></div></Modal>;
}
export function Warranty() {
  const { can } = useAuth(); const [d, setD] = useState<any>({ items: [] }); const [f, setF] = useState({ status: '', pending: false }); const [open, setOpen] = useState<any>(null); const [creating, setCreating] = useState(false); const [err, setErr] = useState(''); const [days, setDays] = useState<number | null>(null);
  const load = () => get('/warranty' + qs({ status: f.status, pending_supplier: f.pending || '' })).then(setD).catch((e) => setErr(e.message)); useEffect(() => { load(); }, [f]); // eslint-disable-line
  useEffect(() => { get('/warranty/settings').then((s) => setDays(s.default_warranty_days)).catch(() => {}); }, []);
  return <><h1>Garantias</h1><p className="sub">Solicitações de garantia com prazo conferido pela data da venda. A decisão (troca, reembolso, reparo ou recusa) mexe no estoque e na contabilidade; a unidade defeituosa fica em estoque avariado até o fornecedor dar crédito ou recusar.</p>
    <div className="toolbar"><select style={{ width: 170 }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Todas</option>{Object.entries(WST).map(([k, v]) => <option key={k} value={k}>{v[1]}</option>)}</select>
      <label className="chk" style={{ margin: 0 }}><input type="checkbox" checked={f.pending} onChange={(e) => setF({ ...f, pending: e.target.checked })} />aguardando fornecedor</label><span style={{ flex: 1 }} />
      {days != null && can('returns:approve') && <span className="muted">Prazo padrão: <input style={{ width: 70 }} type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} onBlur={() => api('PUT', '/warranty/settings', { default_warranty_days: days }).catch((e) => setErr(e.message))} /> dias (o produto pode ter prazo próprio)</span>}
      {can('returns:create') && <button className="primary" onClick={() => setCreating(true)}>+ Nova garantia</button>}</div><Err e={err} />
    <table><thead><tr><th>Nº</th><th>Abertura</th><th>Produto</th><th>Cliente</th><th>Prazo</th><th>Situação</th><th>Fornecedor</th></tr></thead><tbody>
      {d.items.map((c: any) => { const [cls, label] = WST[c.status]; return <tr key={c.id} className="click" onClick={() => setOpen(c)}><td>{c.number}</td><td>{date(c.created_at)}</td><td>{c.sku} — {c.description}</td><td>{c.customer_name ?? '—'}</td>
        <td>{c.in_warranty == null ? <span className="muted">sem data</span> : c.in_warranty ? <span className="pill green">no prazo</span> : <span className="pill red">fora do prazo</span>}</td><td><span className={`pill ${cls}`}>{label}</span> {c.resolution && RES[c.resolution]}</td>
        <td>{Number(c.defective_pending) > 0 ? <span className="pill yellow">aguardando</span> : c.supplier_status === 'credito' ? 'crédito' : c.supplier_status === 'recusado' ? 'recusou' : '—'}</td></tr>; })}
      {!d.items.length && <tr><td colSpan={7} className="muted">Nenhuma solicitação.</td></tr>}</tbody></table>
    {open && <ClaimDetail c={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); load(); }} />}{creating && <NewClaim onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}</>;
}

// ---------------------------------------------------------------- Fechamento contábil
const LEVEL: Record<string, string> = { bloqueio: 'Impede o fechamento', alerta: 'Alerta' };
export function PeriodClosing() {
  const { can } = useAuth(); const [d, setD] = useState<any>(null); const [sel, setSel] = useState<string | null>(null); const [ck, setCk] = useState<any>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [note, setNote] = useState('');
  const load = () => get('/accounting/periods').then((r) => { setD(r); setSel((s) => s ?? [...r.items].reverse().find((x: any) => x.status === 'aberto')?.period ?? r.items[0]?.period ?? null); }).catch((e) => setErr(e.message)); useEffect(() => { load(); }, []);
  useEffect(() => { setCk(null); setMsg(''); if (sel) get(`/accounting/periods/${sel}/checks`).then(setCk).catch((e) => setErr(e.message)); }, [sel, d]);
  if (!d) return <Err e={err} />; const cur = d.items.find((x: any) => x.period === sel);
  const run = async (fn: () => Promise<any>, ok: string) => { setErr(''); setMsg(''); try { await fn(); setMsg(ok); setNote(''); await load(); } catch (e) { setErr((e as ApiError).message); } };
  const fmt = (p: string) => `${p.slice(5, 7)}/${p.slice(0, 4)}`; const latestClosed = d.items.find((x: any) => x.status === 'fechado')?.period;
  return <><h1>Fechamento de período</h1><p className="sub">Fechar um mês trava os lançamentos daquela data e competência (o banco recusa novos lançamentos), guarda uma fotografia da DRE e do balanço e uma impressão digital para conferência futura. Reabrir exige motivo e fica na auditoria.</p>
    <Err e={err} />{msg && <div className="ok">{msg}</div>}
    <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      <table><thead><tr><th>Mês</th><th>Situação</th></tr></thead><tbody>{d.items.map((x: any) => <tr key={x.period} className="click" style={sel === x.period ? { background: 'var(--blue-bg, #e8f0fe)' } : {}} onClick={() => setSel(x.period)}><td>{fmt(x.period)}</td>
        <td>{x.status === 'fechado' ? <span className="pill green">🔒 fechado</span> : x.status === 'em_andamento' ? <span className="pill gray">em andamento</span> : <span className="pill yellow">aberto</span>}</td></tr>)}</tbody></table>
      {cur && <div>
        <h3 style={{ marginTop: 0 }}>{fmt(cur.period)}</h3>
        {cur.status === 'fechado' && <div className="card" style={{ marginBottom: 12 }}><div className="muted">Fechado em {date(cur.closed_at)} por {cur.closed_by_name}{cur.note ? ` — ${cur.note}` : ''} · {cur.entries_count} lançamento(s) · débitos {brl(cur.total_debits)}</div>
          {cur.snapshot && <div style={{ marginTop: 6 }}>Receita bruta {brl(cur.snapshot.dre.receita_bruta)} · Lucro bruto {brl(cur.snapshot.dre.lucro_bruto)} · <b>Resultado {brl(cur.snapshot.dre.lucro_liquido)}</b> · Ativo {brl(cur.snapshot.balance.ativo)} · Passivo {brl(cur.snapshot.balance.passivo)} · PL {brl(cur.snapshot.balance.patrimonio_liquido)}</div>}
          {cur.reopened_at && <div className="muted">Já foi reaberto em {date(cur.reopened_at)} por {cur.reopened_by_name}: {cur.reopen_reason}</div>}
          <div className="toolbar" style={{ marginTop: 8 }}><button onClick={async () => { const v = await get(`/accounting/periods/${cur.period}/verify`); setMsg(v.intact ? '✔ Os lançamentos do período estão idênticos aos do fechamento.' : '✖ Os lançamentos do período diferem do fechamento!'); }}>Conferir integridade</button>
            {can('accounting:approve') && cur.period === latestClosed && <><input style={{ maxWidth: 320 }} placeholder="Motivo da reabertura (mín. 10 caracteres)" value={note} onChange={(e) => setNote(e.target.value)} /><button className="danger" disabled={note.trim().length < 10} onClick={() => run(() => api('POST', `/accounting/periods/${cur.period}/reopen`, { reason: note }), `Período ${fmt(cur.period)} reaberto.`)}>Reabrir</button></>}</div></div>}
        {ck && <><table style={{ tableLayout: 'fixed', width: '100%' }}><colgroup><col style={{ width: '38%' }} /><col style={{ width: '16%' }} /><col /></colgroup><thead><tr><th>Verificação</th><th>Tipo</th><th>Resultado</th></tr></thead><tbody>{ck.checks.map((c: any) => <tr key={c.key}><td>{c.label}</td><td className="muted">{LEVEL[c.level]}</td><td>{c.ok ? <span className="pill green">✔ ok</span> : <span className={`pill ${c.level === 'bloqueio' ? 'red' : 'yellow'}`}>{c.level === 'bloqueio' ? '✖' : '●'} {c.detail}</span>}</td></tr>)}</tbody></table>
          {cur.status !== 'fechado' && can('accounting:approve') && <div className="toolbar" style={{ marginTop: 10 }}><input style={{ maxWidth: 360 }} placeholder="Observação do fechamento (opcional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="primary" disabled={!ck.blocking_ok} onClick={() => run(() => api('POST', `/accounting/periods/${cur.period}/close`, { note: note || undefined }), `Período ${fmt(cur.period)} fechado.`)}>Fechar {fmt(cur.period)}</button>{ck.warnings > 0 && <span className="muted">{ck.warnings} alerta(s) não impedem o fechamento, mas ficam registrados.</span>}</div>}</>}
      </div>}</div></>;
}
