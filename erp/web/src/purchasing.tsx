import { useEffect, useRef, useState } from 'react';
import { api, ApiError, brl, get, pct, qs } from './api';
import { useAuth } from './auth';
import { Modal } from './DataPage';
import { Pill, ProductPick } from './commercial';

const n = (v: any) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const date = (v: any) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '—');
const FLAG: Record<string, string> = { sem_produto: 'sem produto', quantidade_menor: 'qtd menor', quantidade_maior: 'qtd maior', fora_do_pedido: 'fora do pedido', acima_do_pedido: 'acima do pedido', preco_divergente: 'preço ≠ pedido' };
const PO_COLOR: Record<string, string> = { recebido: 'green', aprovado: 'yellow', enviado: 'yellow', parcial: 'yellow', aguardando_aprovacao: 'red', rascunho: 'gray', cancelado: 'gray', em_conferencia: 'yellow', concluido: 'green', aberta: 'yellow', fechada: 'green', cancelada: 'gray' };
const Tag = ({ s }: { s: string }) => <span className={`pill ${PO_COLOR[s] ?? 'gray'}`}>{s.replaceAll('_', ' ')}</span>;
void Pill;

function SupplierSelect({ value, onChange, width = 240 }: { value: string; onChange: (v: string) => void; width?: number }) {
  const [l, setL] = useState<any[]>([]); useEffect(() => { get('/suppliers?pageSize=200&active=true').then((r) => setL(r.items)); }, []);
  return <select style={{ width }} value={value} onChange={(e) => onChange(e.target.value)}><option value="">Fornecedor…</option>{l.map((s) => <option key={s.id} value={s.id}>{s.legal_name}</option>)}</select>;
}

// ---------------------------------------------------------------- Sugestão de compra
export function Suggestions() {
  const { can, me } = useAuth(); const [supplier, setSupplier] = useState(''); const [branch, setBranch] = useState(me?.branchId ?? 'all'); const [d, setD] = useState<any>(null); const [sel, setSel] = useState<Record<string, string>>({}); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const load = () => get('/purchasing/suggestions' + qs({ branch_id: branch, supplier_id: supplier })).then((r) => { setD(r); setSel({}); }).catch((e) => setErr(e.message)); useEffect(() => { load(); }, [supplier, branch]);
  const chosen = (d?.items ?? []).filter((i: any) => sel[i.product_id] !== undefined); const missing = chosen.filter((i: any) => !i.supplier_id || i.last_price == null);
  const generate = async () => { setErr(''); try { const r = await api('POST', '/purchase-orders/from-suggestions', { branch_id: branch === 'all' ? null : branch, items: chosen.map((i: any) => ({ product_id: i.product_id, supplier_id: i.supplier_id, qty: Number(sel[i.product_id]), unit_price: i.last_price })) }); setMsg(`${r.orders.length} pedido(s) gerado(s): ${r.orders.map((o: any) => 'nº ' + o.number).join(', ')}.`); load(); } catch (e) { setErr((e as Error).message); } };
  return <><h1>Sugestão de compra</h1><p className="sub">Considera estoque, mínimo/máximo/ideal, venda média, curva ABC, sazonalidade, pedidos pendentes, trânsito e prazo do fornecedor. É uma estimativa: veja a confiança de cada item.</p>
    {msg && <div className="alert green">{msg}</div>}{err && <div className="err">{err}</div>}
    <div className="toolbar"><SupplierSelect value={supplier} onChange={setSupplier} /><select style={{ width: 180 }} value={branch} onChange={(e) => setBranch(e.target.value)}><option value="all">Todas as filiais</option>{me?.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      <span className="muted">{d?.items.length ?? 0} itens · estimado {brl(d?.total_estimated ?? 0)}</span><span style={{ flex: 1 }} />
      {can('purchases:create') && <button className="primary" disabled={!chosen.length || missing.length > 0} onClick={generate} title={missing.length ? 'Itens sem fornecedor/preço: vincule em Fornecedores → Produtos e preços' : ''}>Gerar pedido(s) ({chosen.length})</button>}</div>
    <table><thead><tr><th /><th>Produto</th><th>ABC</th><th className="num">Disp.</th><th className="num">Mín/Máx</th><th className="num">Pedidos</th><th className="num">Venda/dia</th><th className="num">Cobertura</th><th>Fornecedor (prazo)</th><th className="num">Último preço</th><th className="num">Sugerido</th><th>Confiança</th></tr></thead><tbody>
      {d?.items.map((i: any) => <tr key={i.product_id} title={`${i.basis}\n${i.seasonality_note}`}>
        <td><input type="checkbox" style={{ width: 'auto' }} checked={sel[i.product_id] !== undefined} onChange={(e) => { const s = { ...sel }; if (e.target.checked) s[i.product_id] = String(i.suggested_qty); else delete s[i.product_id]; setSel(s); }} /></td>
        <td>{i.sku} {i.description}</td><td><span className={`pill ${i.abc === 'A' ? 'green' : i.abc === 'B' ? 'yellow' : 'gray'}`}>{i.abc}</span></td><td className="num">{n(i.disponivel)}</td><td className="num muted">{n(i.min_stock)}/{n(i.max_stock)}</td><td className="num">{n(i.pending + i.transit)}</td>
        <td className="num">{n(i.avg_daily)}</td><td className="num">{i.coverage_days != null ? `${n(i.coverage_days)} d` : '—'}</td><td>{i.supplier_name ?? <span className="pill red">sem fornecedor</span>} {i.supplier_name && <span className="muted">({i.lead_time_days} d)</span>}</td>
        <td className="num">{i.last_price != null ? brl(i.last_price) : '—'}</td><td className="num">{sel[i.product_id] !== undefined ? <input type="number" style={{ width: 80 }} value={sel[i.product_id]} onChange={(e) => setSel({ ...sel, [i.product_id]: e.target.value })} /> : <b>{n(i.suggested_qty)}</b>}</td>
        <td><span className={`pill ${i.confidence === 'alta' ? 'green' : i.confidence === 'média' ? 'yellow' : 'gray'}`}>{i.confidence}</span></td></tr>)}
      {d && !d.items.length && <tr><td colSpan={12} className="muted">Nenhuma reposição necessária no momento.</td></tr>}</tbody></table>
    <p className="muted">Passe o mouse sobre a linha para ver a base do cálculo e a sazonalidade aplicada.</p></>;
}

// ---------------------------------------------------------------- Pedidos de compra
export function PurchaseOrders() {
  const { can } = useAuth(); const [status, setStatus] = useState(''); const [d, setD] = useState<any>({ items: [] }); const [open, setOpen] = useState<string | null>(null); const [creating, setCreating] = useState(false); const [cfg, setCfg] = useState<any>(null); const [msg, setMsg] = useState('');
  const load = () => get('/purchase-orders' + qs({ status, pageSize: 100 })).then(setD); useEffect(() => { load(); }, [status]); useEffect(() => { get('/purchasing/settings').then(setCfg); }, []);
  return <><h1>Pedidos de compra</h1><p className="sub">Rascunho → aprovado → enviado → recebido (parcial ou total). Aprovação só é exigida acima do limite configurado (hoje: {cfg?.approval_threshold != null ? brl(cfg.approval_threshold) : 'sem limite — emitir já aprova'}).</p>
    {msg && <div className="alert green">{msg}</div>}
    <div className="toolbar"><select style={{ width: 200 }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos</option>{['rascunho', 'aguardando_aprovacao', 'aprovado', 'enviado', 'parcial', 'recebido', 'cancelado'].map((s) => <option key={s} value={s}>{s.replaceAll('_', ' ')}</option>)}</select><span style={{ flex: 1 }} />
      {can('purchases:approve') && <button onClick={async () => { const v = prompt('Limite de aprovação em R$ (vazio = sem aprovação):', cfg?.approval_threshold ?? ''); if (v === null) return; await api('PUT', '/purchasing/settings', { approval_threshold: v === '' ? null : Number(v), review_days: cfg?.review_days ?? 7 }); setCfg(await get('/purchasing/settings')); setMsg('Limite atualizado.'); }}>Limite de aprovação</button>}
      {can('purchases:create') && <button className="primary" onClick={() => setCreating(true)}>+ Novo pedido</button>}</div>
    <table><thead><tr><th>Nº</th><th>Fornecedor</th><th>Entrega prevista</th><th className="num">Total</th><th>Status</th></tr></thead><tbody>
      {d.items.map((p: any) => <tr key={p.id} className="click" onClick={() => setOpen(p.id)}><td>{p.number}</td><td>{p.supplier_name}</td><td>{date(p.expected_date)} {p.late && <span className="pill red">atrasado</span>}</td><td className="num">{brl(p.total)}</td><td><Tag s={p.status} /></td></tr>)}</tbody></table>
    {creating && <NewPO onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}{open && <PODetail id={open} onClose={() => { setOpen(null); load(); }} />}</>;
}
function NewPO({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const [supplier, setSupplier] = useState(''); const [items, setItems] = useState<any[]>([]); const [expected, setExpected] = useState(''); const [freight, setFreight] = useState(''); const [err, setErr] = useState('');
  const add = async (p: any) => { if (!p || items.find((i) => i.product_id === p.id)) return; const c = supplier ? await get(`/purchasing/compare?product_id=${p.id}`).then((r) => r.suppliers.find((s: any) => s.supplier_id === supplier)?.last_price).catch(() => null) : null; setItems([...items, { product_id: p.id, label: `${p.sku} ${p.description}`, qty: '1', unit_price: String(c ?? p.cost_current ?? 0) }]); };
  const total = items.reduce((s, i) => s + Number(i.qty) * Number(i.unit_price), 0) + Number(freight || 0);
  const save = async (submit: boolean) => { try { await api('POST', '/purchase-orders', { supplier_id: supplier, expected_date: expected || null, freight: freight ? Number(freight) : undefined, submit, items: items.map((i) => ({ product_id: i.product_id, qty: Number(i.qty), unit_price: Number(i.unit_price) })) }); onDone(); } catch (e) { setErr((e as Error).message); } };
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>Novo pedido de compra</h2>
    <div className="form"><div><label>Fornecedor *</label><SupplierSelect value={supplier} onChange={setSupplier} width={9999} /></div><div><label>Entrega prevista</label><input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></div><div><label>Frete (R$)</label><input type="number" step="0.01" value={freight} onChange={(e) => setFreight(e.target.value)} /></div></div>
    <div style={{ marginTop: 10 }}><ProductPick value={null} onChange={add} /></div>
    <table style={{ marginTop: 10 }}><thead><tr><th>Produto</th><th style={{ width: 90 }}>Qtd</th><th style={{ width: 120 }}>Preço unit.</th><th className="num">Total</th><th /></tr></thead><tbody>
      {items.map((i, k) => <tr key={i.product_id}><td>{i.label}</td><td><input type="number" value={i.qty} onChange={(e) => setItems(items.map((x, y) => (y === k ? { ...x, qty: e.target.value } : x)))} /></td><td><input type="number" step="0.01" value={i.unit_price} onChange={(e) => setItems(items.map((x, y) => (y === k ? { ...x, unit_price: e.target.value } : x)))} /></td><td className="num">{brl(Number(i.qty) * Number(i.unit_price))}</td><td><button onClick={() => setItems(items.filter((_, y) => y !== k))}>×</button></td></tr>)}</tbody></table>
    <p style={{ textAlign: 'right' }}>Total <b>{brl(total)}</b></p>{err && <div className="err">{err}</div>}
    <div className="right"><button onClick={onClose}>Cancelar</button><button disabled={!supplier || !items.length} onClick={() => save(false)}>Salvar rascunho</button><button className="primary" disabled={!supplier || !items.length} onClick={() => save(true)}>Emitir pedido</button></div></Modal>;
}
function PODetail({ id, onClose }: { id: string; onClose(): void }) {
  const { me, can } = useAuth(); const [p, setP] = useState<any>(null); const [err, setErr] = useState(''); const [rcv, setRcv] = useState(false);
  const load = () => get('/purchase-orders/' + id).then(setP); useEffect(() => { load(); }, [id]); if (!p) return null;
  const act = async (a: string) => { setErr(''); try { await api('POST', `/purchase-orders/${id}/${a}`); await load(); } catch (e) { setErr((e as Error).message); } };
  const receivable = ['aprovado', 'enviado', 'parcial'].includes(p.status);
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>Pedido nº {p.number} <Tag s={p.status} /></h2><p className="muted">{p.supplier_name} · destino {p.branch_name} · entrega {date(p.expected_date)} · pagamento {p.payment_terms_days} dias · criado por {p.created_by_name}</p>
    <table><thead><tr><th>Produto</th><th className="num">Qtd</th><th className="num">Recebido</th><th className="num">Pendente</th><th className="num">Unit.</th><th className="num">Total</th></tr></thead><tbody>
      {p.items.map((i: any) => <tr key={i.id}><td>{i.sku} {i.description}</td><td className="num">{n(i.qty)}</td><td className="num">{n(i.received_qty)}</td><td className="num">{n(i.pending)}</td><td className="num">{brl(i.unit_price)}</td><td className="num">{brl(Number(i.qty) * Number(i.unit_price))}</td></tr>)}</tbody></table>
    <p style={{ textAlign: 'right' }}>Frete {brl(p.freight)} · Desconto {brl(p.discount)} · Total <b>{brl(p.total)}</b></p>
    {p.receivings.length > 0 && <><b>Recebimentos</b>{p.receivings.map((r: any) => <div key={r.id}>NF {r.nf_number} · {brl(r.total_nf)} · <Tag s={r.status} /></div>)}</>}{err && <div className="err">{err}</div>}
    <div className="right">{p.status === 'rascunho' && can('purchases:create') && <button className="primary" onClick={() => act('submit')}>Emitir</button>}
      {p.status === 'aguardando_aprovacao' && can('purchases:approve') && p.created_by !== me?.user.id && <button className="primary" onClick={() => act('approve')}>Aprovar</button>}
      {['aprovado', 'enviado'].includes(p.status) && can('purchases:create') && <button onClick={() => act('send')}>Marcar como enviado</button>}
      {receivable && can('receiving:create') && <button className="primary" onClick={() => setRcv(true)}>Receber mercadoria</button>}
      {!['parcial', 'recebido', 'cancelado'].includes(p.status) && can('purchases:edit') && <button className="danger" onClick={() => act('cancel')}>Cancelar</button>}<button onClick={onClose}>Fechar</button></div>
    {rcv && <ManualReceiving po={p} onClose={() => setRcv(false)} onDone={() => { setRcv(false); load(); }} />}</Modal>;
}

// ---------------------------------------------------------------- Recebimento
function ManualReceiving({ po, onClose, onDone }: { po?: any; onClose(): void; onDone(): void }) {
  const [supplier, setSupplier] = useState(po?.supplier_id ?? ''); const [nf, setNf] = useState(''); const [freight, setFreight] = useState(''); const [err, setErr] = useState('');
  const [items, setItems] = useState<any[]>((po?.items ?? []).filter((i: any) => Number(i.pending) > 0).map((i: any) => ({ product_id: i.product_id, label: `${i.sku} ${i.description}`, qty: String(i.pending), unit_price: String(i.unit_price) })));
  const save = async () => { try { await api('POST', '/receivings', { supplier_id: supplier, po_id: po?.id ?? null, nf_number: nf, freight: freight ? Number(freight) : undefined, items: items.map((i) => ({ product_id: i.product_id, qty: Number(i.qty), unit_price: Number(i.unit_price) })) }); onDone(); } catch (e) { setErr((e as Error).message); } };
  return <Modal onClose={onClose}><h3 style={{ marginTop: 0 }}>Lançar NF manualmente</h3>
    <div className="form"><div><label>Fornecedor</label><SupplierSelect value={supplier} onChange={setSupplier} width={9999} /></div><div><label>Nº da NF *</label><input value={nf} onChange={(e) => setNf(e.target.value)} /></div><div><label>Frete (R$)</label><input type="number" value={freight} onChange={(e) => setFreight(e.target.value)} /></div></div>
    {!po && <div style={{ marginTop: 8 }}><ProductPick value={null} onChange={(p) => p && setItems([...items, { product_id: p.id, label: `${p.sku} ${p.description}`, qty: '1', unit_price: String(p.cost_current ?? 0) }])} /></div>}
    <table style={{ marginTop: 8 }}><tbody>{items.map((i, k) => <tr key={i.product_id}><td>{i.label}</td><td style={{ width: 90 }}><input type="number" value={i.qty} onChange={(e) => setItems(items.map((x, y) => (y === k ? { ...x, qty: e.target.value } : x)))} /></td><td style={{ width: 120 }}><input type="number" step="0.01" value={i.unit_price} onChange={(e) => setItems(items.map((x, y) => (y === k ? { ...x, unit_price: e.target.value } : x)))} /></td></tr>)}</tbody></table>
    {err && <div className="err">{err}</div>}<div className="right"><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!supplier || !nf || !items.length} onClick={save}>Iniciar conferência</button></div></Modal>;
}

export function Receivings() {
  const { can } = useAuth(); const [status, setStatus] = useState(''); const [d, setD] = useState<any>({ items: [] }); const [open, setOpen] = useState<string | null>(null); const [manual, setManual] = useState(false); const [err, setErr] = useState(''); const file = useRef<HTMLInputElement>(null); const [pending, setPending] = useState<string | null>(null);
  const load = () => get('/receivings' + qs({ status, pageSize: 100 })).then(setD); useEffect(() => { load(); }, [status]);
  const send = async (xml: string, create_supplier = false) => { setErr(''); try { const r = await api('POST', '/receivings/import-xml', { xml, create_supplier }); setPending(null); load(); setOpen(r.id); } catch (e) { const x = e as any; if (x.code === 'supplier_not_found' && confirm(`${x.message}\n\nCadastrar este fornecedor a partir do XML?`)) return send(xml, true); setErr((e as Error).message); } };
  return <><h1>Recebimento de mercadoria</h1><p className="sub">Importe o XML da NF-e ou lance manualmente; confira fisicamente; ao concluir o estoque, o custo médio e o contas a pagar são atualizados. Nota normal do Simples: sem crédito de imposto, o custo inclui IPI, frete e despesas.</p>
    {err && <div className="err">{err}</div>}
    <div className="toolbar"><select style={{ width: 200 }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos</option><option value="em_conferencia">Em conferência</option><option value="concluido">Concluído</option><option value="cancelado">Cancelado</option></select><span style={{ flex: 1 }} />
      {can('receiving:create') && <><input ref={file} type="file" accept=".xml,text/xml" style={{ display: 'none' }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const xml = await f.text(); setPending(xml); await send(xml); } e.target.value = ''; }} />
        <button className="primary" onClick={() => file.current?.click()}>Importar XML da NF-e</button><button onClick={() => setManual(true)}>Lançar NF manual</button></>}</div>
    <table><thead><tr><th>Nº</th><th>NF</th><th>Fornecedor</th><th>Pedido</th><th>Emissão</th><th className="num">Total NF</th><th>Origem</th><th>Status</th></tr></thead><tbody>
      {d.items.map((r: any) => <tr key={r.id} className="click" onClick={() => setOpen(r.id)}><td>{r.number}</td><td>{r.nf_number}</td><td>{r.supplier_name}</td><td>{r.po_number ?? '—'}</td><td>{date(r.issue_date)}</td><td className="num">{brl(r.total_nf)}</td><td>{r.source}</td><td><Tag s={r.status} /></td></tr>)}</tbody></table>
    {manual && <ManualReceiving onClose={() => setManual(false)} onDone={() => { setManual(false); load(); }} />}{open && <Conference id={open} onClose={() => { setOpen(null); load(); }} />}{void pending}</>;
}

function Conference({ id, onClose }: { id: string; onClose(): void }) {
  const { can } = useAuth(); const [r, setR] = useState<any>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = () => get('/receivings/' + id).then(setR); useEffect(() => { load(); }, [id]); if (!r) return null;
  const run = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); await load(); } catch (e) { setErr((e as ApiError).message); return e as any; } };
  const finish = async (accept = false) => { const e = await run(async () => { const x = await api('POST', `/receivings/${id}/finish`, { accept_divergences: accept }); setMsg(`Entrada concluída: estoque, custo médio e ${x.payables} título(s) a pagar atualizados.`); }); if (e?.code === 'divergences' && confirm(`Divergências encontradas (${e.divergences.map((f: string) => FLAG[f] ?? f).join(', ')}).\nAceitar e dar entrada com as quantidades conferidas?`)) { setErr(''); await finish(true); } };
  const open = r.status === 'em_conferencia';
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>Recebimento nº {r.number} — NF {r.nf_number} <Tag s={r.status} /></h2><p className="muted">{r.supplier_name}{r.po_number ? ` · pedido ${r.po_number}` : ''} · emissão {date(r.issue_date)} · origem {r.source}</p>
    <table><thead><tr><th>Item da NF</th><th>Produto vinculado</th><th className="num">Qtd NF</th><th className="num">Unit. NF</th><th style={{ width: 100 }}>Conferido</th><th className="num">Custo final</th><th>Alertas</th></tr></thead><tbody>
      {r.items.map((i: any) => <tr key={i.id}><td>{i.description}<div className="muted">{i.supplier_code}</div></td>
        <td>{i.product_id ? `${i.sku} ${i.product_description}` : open ? <ProductPick value={null} onChange={(p) => p && run(() => api('PATCH', `/receivings/${id}/items/${i.id}`, { product_id: p.id }))} /> : '—'}</td>
        <td className="num">{n(i.qty_nf)}</td><td className="num">{brl(i.unit_price_nf)}</td>
        <td>{open ? <input type="number" defaultValue={i.qty_received ?? ''} onBlur={(e) => e.target.value !== String(i.qty_received ?? '') && run(() => api('PATCH', `/receivings/${id}/items/${i.id}`, { qty_received: e.target.value === '' ? null : Number(e.target.value) }))} /> : n(i.qty_received ?? 0)}</td>
        <td className="num">{i.unit_cost_final != null ? brl(i.unit_cost_final) : '—'}</td><td>{i.flags.map((f: string) => <span key={f} className={`pill ${f === 'preco_divergente' || f === 'sem_produto' ? 'red' : 'yellow'}`} style={{ marginRight: 4 }}>{FLAG[f] ?? f}</span>)}</td></tr>)}</tbody></table>
    <div className="grid kpis" style={{ margin: '12px 0' }}>{[['Produtos', r.total_products], ['IPI', r.ipi_total], ['Frete', r.freight], ['Desconto', r.discount], ['Total da NF', r.total_nf]].map(([l, v]) => <div key={l as string} className="card kpi"><div className="v" style={{ fontSize: 18 }}>{brl(v)}</div><div className="l">{l}</div></div>)}</div>
    {r.installments && <p className="muted">Duplicatas: {r.installments.map((p: any) => `${date(p.due_date)} ${brl(p.amount)}`).join(' · ')}</p>}{r.divergence_note && <div className="alert yellow">{r.divergence_note}</div>}
    {msg && <div className="alert green">{msg}</div>}{err && <div className="err">{err}</div>}
    <div className="right">{open && can('receiving:edit') && <><button className="danger" onClick={() => run(() => api('POST', `/receivings/${id}/cancel`))}>Cancelar</button><button onClick={() => run(() => api('POST', `/receivings/${id}/check-all`))}>Conferir tudo (= NF)</button></>}
      {open && can('receiving:create') && <button className="primary" onClick={() => finish(false)}>Concluir entrada</button>}<button onClick={onClose}>Fechar</button></div></Modal>;
}

// ---------------------------------------------------------------- Cotações
export function Quotations() {
  const { can } = useAuth(); const [l, setL] = useState<any[]>([]); const [open, setOpen] = useState<string | null>(null); const [creating, setCreating] = useState(false);
  const load = () => get('/quotations').then((r) => setL(r.items)); useEffect(() => { load(); }, []);
  return <><h1>Cotações de compra</h1><p className="sub">Registre as ofertas dos fornecedores por item, compare preço e prazo e adjudique: o sistema gera um pedido por fornecedor vencedor.</p>
    <div className="toolbar"><span style={{ flex: 1 }} />{can('purchases:create') && <button className="primary" onClick={() => setCreating(true)}>+ Nova cotação</button>}</div>
    <table><thead><tr><th>Nº</th><th>Criada em</th><th>Observação</th><th className="num">Itens</th><th className="num">Ofertas</th><th>Status</th></tr></thead><tbody>
      {l.map((q) => <tr key={q.id} className="click" onClick={() => setOpen(q.id)}><td>{q.number}</td><td>{date(q.created_at)}</td><td>{q.note}</td><td className="num">{q.items}</td><td className="num">{q.offers}</td><td><Tag s={q.status} /></td></tr>)}</tbody></table>
    {creating && <NewQuotation onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); load(); setOpen(id); }} />}{open && <QuotationDetail id={open} onClose={() => { setOpen(null); load(); }} />}</>;
}
function NewQuotation({ onClose, onDone }: { onClose(): void; onDone(id: string): void }) {
  const [items, setItems] = useState<any[]>([]); const [note, setNote] = useState(''); const [err, setErr] = useState('');
  const save = async () => { try { const q = await api('POST', '/quotations', { note: note || null, items: items.map((i) => ({ product_id: i.id, qty: Number(i.qty) })) }); onDone(q.id); } catch (e) { setErr((e as Error).message); } };
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>Nova cotação</h2><label>Observação</label><input value={note} onChange={(e) => setNote(e.target.value)} />
    <div style={{ marginTop: 10 }}><ProductPick value={null} onChange={(p) => p && !items.find((i) => i.id === p.id) && setItems([...items, { id: p.id, label: `${p.sku} ${p.description}`, qty: '1' }])} /></div>
    <table style={{ marginTop: 8 }}><tbody>{items.map((i, k) => <tr key={i.id}><td>{i.label}</td><td style={{ width: 100 }}><input type="number" value={i.qty} onChange={(e) => setItems(items.map((x, y) => (y === k ? { ...x, qty: e.target.value } : x)))} /></td><td><button onClick={() => setItems(items.filter((_, y) => y !== k))}>×</button></td></tr>)}</tbody></table>
    {err && <div className="err">{err}</div>}<div className="right"><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!items.length} onClick={save}>Criar</button></div></Modal>;
}
function QuotationDetail({ id, onClose }: { id: string; onClose(): void }) {
  const { can } = useAuth(); const [q, setQ] = useState<any>(null); const [err, setErr] = useState(''); const [f, setF] = useState<any>({ supplier_id: '', unit_price: '', lead_time_days: '', payment_terms_days: '' }); const [pick, setPick] = useState<Record<string, string>>({}); const [done, setDone] = useState('');
  const load = () => get('/quotations/' + id).then((x) => { setQ(x); setPick(Object.fromEntries(x.items.filter((i: any) => i.best_offer_id).map((i: any) => [i.product_id, i.offers.find((o: any) => o.id === i.best_offer_id).supplier_id]))); }); useEffect(() => { load(); }, [id]); if (!q) return null;
  const open = q.status === 'aberta';
  const addOffer = async (product_id: string) => { setErr(''); try { await api('POST', `/quotations/${id}/offers`, { product_id, supplier_id: f.supplier_id, unit_price: Number(f.unit_price), lead_time_days: f.lead_time_days ? Number(f.lead_time_days) : null, payment_terms_days: f.payment_terms_days ? Number(f.payment_terms_days) : null }); load(); } catch (e) { setErr((e as Error).message); } };
  const award = async () => { setErr(''); try { const r = await api('POST', `/quotations/${id}/award`, { awards: Object.entries(pick).filter(([, s]) => s).map(([product_id, supplier_id]) => ({ product_id, supplier_id })) }); setDone(`Pedidos gerados: ${r.orders.map((o: any) => 'nº ' + o.number).join(', ')}.`); load(); } catch (e) { setErr((e as Error).message); } };
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>Cotação nº {q.number} <Tag s={q.status} /></h2><p className="muted">{q.note}</p>
    {open && can('purchases:edit') && <div className="toolbar"><SupplierSelect value={f.supplier_id} onChange={(v) => setF({ ...f, supplier_id: v })} /><input style={{ width: 110 }} type="number" step="0.01" placeholder="Preço" value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} /><input style={{ width: 110 }} type="number" placeholder="Prazo entrega (d)" value={f.lead_time_days} onChange={(e) => setF({ ...f, lead_time_days: e.target.value })} /><input style={{ width: 110 }} type="number" placeholder="Prazo pgto (d)" value={f.payment_terms_days} onChange={(e) => setF({ ...f, payment_terms_days: e.target.value })} /><span className="muted">→ use “+ oferta” na linha do produto</span></div>}
    {q.items.map((i: any) => <div key={i.product_id} className="card" style={{ marginBottom: 8 }}><b>{i.sku} {i.description}</b> <span className="muted">· {n(i.qty)} un · custo médio atual {brl(i.cost_avg)}</span>{open && can('purchases:edit') && <button style={{ float: 'right' }} disabled={!f.supplier_id || !f.unit_price} onClick={() => addOffer(i.product_id)}>+ oferta</button>}
      <table><tbody>{i.offers.map((o: any) => <tr key={o.id}><td style={{ width: 30 }}>{open ? <input type="radio" style={{ width: 'auto' }} name={i.product_id} checked={pick[i.product_id] === o.supplier_id} onChange={() => setPick({ ...pick, [i.product_id]: o.supplier_id })} /> : o.selected ? '✔' : ''}</td><td>{o.supplier_name} {o.id === i.best_offer_id && <span className="pill green">melhor</span>}</td><td className="num">{brl(o.unit_price)}</td><td className="num muted">{o.lead_time_days ?? '—'} d entrega · {o.payment_terms_days ?? '—'} d pgto</td><td className="num">{brl(Number(o.unit_price) * Number(i.qty))}</td></tr>)}{!i.offers.length && <tr><td className="muted">Sem ofertas.</td></tr>}</tbody></table></div>)}
    {done && <div className="alert green">{done}</div>}{err && <div className="err">{err}</div>}
    <div className="right">{open && can('purchases:edit') && <button className="danger" onClick={() => api('POST', `/quotations/${id}/cancel`).then(load)}>Cancelar cotação</button>}{open && can('purchases:create') && <button className="primary" disabled={!Object.values(pick).some(Boolean)} onClick={award}>Adjudicar e gerar pedidos</button>}<button onClick={onClose}>Fechar</button></div></Modal>;
}

// ---------------------------------------------------------------- Comparação de preços
export function PriceCompare() {
  const [p, setP] = useState<any>(null); const [d, setD] = useState<any>(null);
  useEffect(() => { if (p) get(`/purchasing/compare?product_id=${p.id}`).then(setD); else setD(null); }, [p]);
  return <><h1>Comparar fornecedores</h1><p className="sub">Último preço, variação, média e prazo por fornecedor, com histórico de cotações e notas.</p>
    <div className="toolbar"><ProductPick value={p} onChange={setP} /></div>
    {d && <><table><thead><tr><th>Fornecedor</th><th className="num">Último preço</th><th className="num">Variação</th><th className="num">Média</th><th className="num">Menor</th><th className="num">Maior</th><th className="num">Prazo entrega</th><th className="num">Prazo pgto</th><th>Frete</th></tr></thead><tbody>
      {d.suppliers.map((s: any) => <tr key={s.supplier_id}><td>{s.legal_name} {s.supplier_id === d.cheapest_supplier_id && <span className="pill green">mais barato</span>}</td><td className="num"><b>{brl(s.last_price)}</b></td>
        <td className="num">{s.variation_pct != null ? <span className={`pill ${s.variation_pct > 0 ? 'red' : 'green'}`}>{s.variation_pct > 0 ? '+' : ''}{pct(s.variation_pct)}</span> : '—'}</td><td className="num">{brl(s.avg_price)}</td><td className="num">{brl(s.min_price)}</td><td className="num">{brl(s.max_price)}</td><td className="num">{s.lead_time_days ?? '—'} d</td><td className="num">{s.payment_terms_days} d</td><td>{s.freight_type ?? '—'}</td></tr>)}
      {!d.suppliers.length && <tr><td colSpan={9} className="muted">Sem preços registrados para este produto.</td></tr>}</tbody></table>
      <h3>Histórico</h3><table><tbody>{d.history.map((h: any, k: number) => <tr key={k}><td>{date(h.created_at)}</td><td>{h.legal_name}</td><td className="num">{brl(h.price)}</td><td className="muted">{h.source} {h.ref}</td></tr>)}</tbody></table></>}</>;
}

// ---------------------------------------------------------------- Devolução ao fornecedor
export function SupplierReturns() {
  const { can } = useAuth(); const [l, setL] = useState<any[]>([]); const [open, setOpen] = useState(false); const [supplier, setSupplier] = useState(''); const [reason, setReason] = useState(''); const [items, setItems] = useState<any[]>([]); const [err, setErr] = useState('');
  const load = () => get('/supplier-returns').then((r) => setL(r.items)); useEffect(() => { load(); }, []);
  const save = async () => { try { await api('POST', '/supplier-returns', { supplier_id: supplier, reason, items: items.map((i) => ({ product_id: i.id, qty: Number(i.qty) })) }); setOpen(false); setItems([]); setReason(''); load(); } catch (e) { setErr((e as Error).message); } };
  return <><h1>Devolução ao fornecedor</h1><p className="sub">Baixa o estoque disponível e gera um crédito a abater no contas a pagar do fornecedor.</p>
    <div className="toolbar"><span style={{ flex: 1 }} />{can('purchases:create') && <button className="primary" onClick={() => setOpen(true)}>+ Nova devolução</button>}</div>
    <table><thead><tr><th>Nº</th><th>Data</th><th>Fornecedor</th><th>Motivo</th><th className="num">Crédito</th></tr></thead><tbody>{l.map((r) => <tr key={r.id}><td>{r.number}</td><td>{date(r.created_at)}</td><td>{r.supplier_name}</td><td>{r.reason}</td><td className="num">{brl(r.total)}</td></tr>)}</tbody></table>
    {open && <Modal onClose={() => setOpen(false)}><h2 style={{ marginTop: 0 }}>Nova devolução</h2><div className="form"><div><label>Fornecedor</label><SupplierSelect value={supplier} onChange={setSupplier} width={9999} /></div><div><label>Motivo *</label><input value={reason} onChange={(e) => setReason(e.target.value)} /></div></div>
      <div style={{ marginTop: 8 }}><ProductPick value={null} onChange={(p) => p && !items.find((i) => i.id === p.id) && setItems([...items, { id: p.id, label: `${p.sku} ${p.description}`, qty: '1' }])} /></div>
      <table style={{ marginTop: 8 }}><tbody>{items.map((i, k) => <tr key={i.id}><td>{i.label}</td><td style={{ width: 100 }}><input type="number" value={i.qty} onChange={(e) => setItems(items.map((x, y) => (y === k ? { ...x, qty: e.target.value } : x)))} /></td><td><button onClick={() => setItems(items.filter((_, y) => y !== k))}>×</button></td></tr>)}</tbody></table>
      {err && <div className="err">{err}</div>}<div className="right"><button onClick={() => setOpen(false)}>Cancelar</button><button className="primary" disabled={!supplier || reason.length < 3 || !items.length} onClick={save}>Registrar devolução</button></div></Modal>}</>;
}

// ---------------------------------------------------------------- Produtos e preços do fornecedor (extra do cadastro)
export function SupplierProducts({ id }: { id: string }) {
  const { can } = useAuth(); const [open, setOpen] = useState(false); const [l, setL] = useState<any[]>([]); const [p, setP] = useState<any>(null); const [f, setF] = useState({ supplier_code: '', price: '', lead: '', preferred: false });
  const load = () => get(`/suppliers/${id}/products`).then((r) => setL(r.items)); useEffect(() => { if (open) load(); }, [open]);
  return <div style={{ marginTop: 12 }}><button onClick={() => setOpen(!open)}>{open ? 'Ocultar' : 'Produtos fornecidos e preços'}</button>
    {open && <div style={{ marginTop: 8 }}><table><thead><tr><th>Produto</th><th>Cód. fornecedor</th><th className="num">Último preço</th><th className="num">Média</th><th>Pref.</th><th /></tr></thead><tbody>
      {l.map((x) => <tr key={x.product_id}><td>{x.sku} {x.description}</td><td>{x.supplier_code}</td><td className="num">{x.last_price != null ? brl(x.last_price) : '—'}</td><td className="num">{x.avg_price != null ? brl(x.avg_price) : '—'}</td><td>{x.preferred ? '★' : ''}</td><td>{can('suppliers:edit') && <button onClick={() => api('DELETE', `/suppliers/${id}/products/${x.product_id}`).then(load)}>×</button>}</td></tr>)}</tbody></table>
      {can('suppliers:edit') && <div className="toolbar" style={{ marginTop: 8 }}><ProductPick value={p} onChange={setP} /><input style={{ width: 130 }} placeholder="Cód. do fornecedor" value={f.supplier_code} onChange={(e) => setF({ ...f, supplier_code: e.target.value })} /><input style={{ width: 100 }} type="number" step="0.01" placeholder="Preço" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
        <label className="chk" style={{ margin: 0 }}><input type="checkbox" checked={f.preferred} onChange={(e) => setF({ ...f, preferred: e.target.checked })} />preferencial</label>
        <button disabled={!p} onClick={() => api('PUT', `/suppliers/${id}/products/${p.id}`, { supplier_code: f.supplier_code || null, preferred: f.preferred, price: f.price ? Number(f.price) : undefined }).then(() => { setP(null); setF({ supplier_code: '', price: '', lead: '', preferred: false }); load(); })}>Vincular / atualizar</button></div>}</div>}</div>;
}
