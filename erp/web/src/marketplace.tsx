import { useEffect, useState } from 'react';
import { api, ApiError, brl, get, getToken, pct, qs } from './api';
import { useAuth } from './auth';
import { ProductPick } from './commercial';
import { DataPage, Modal } from './DataPage';

const Err = ({ e }: { e: string }) => (e ? <div className="err">{e}</div> : null);
const date = (v: any) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '—');
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const useMarketplaces = () => { const [l, setL] = useState<any[]>([]); useEffect(() => { get('/marketplaces?pageSize=100').then((r) => setL(r.items)).catch(() => {}); }, []); return l; };

// ---------------------------------------------------------------- Canais
function Summary({ row }: { row: any }) {
  const [s, setS] = useState<any>(null); useEffect(() => { if (row.id) get(`/marketplaces/${row.id}/summary`).then(setS).catch(() => {}); }, [row.id]);
  if (!row.id || !s) return null;
  return <div className="card" style={{ marginTop: 12 }}><b>Últimos 30 dias</b><div className="muted" style={{ margin: '4px 0' }}>{s.orders} pedido(s) · bruto {brl(s.gross)} · taxas {brl(s.fees)} ({pct(s.fees_pct)}) · <b>margem após taxas {brl(s.margin_after_fees)} ({pct(s.margin_after_fees_pct)})</b></div>
    <div className="muted">A receber: {brl(s.pending_net)} em {s.pending_orders} pedido(s){s.late_payouts > 0 && <span className="pill red" style={{ marginLeft: 6 }}>{s.late_payouts} repasse(s) atrasado(s)</span>} · já recebido {brl(s.received_net)}</div></div>;
}
export const MarketplaceChannels = () => <DataPage title="Marketplaces" subtitle="Cadastre cada canal com comissão, taxa fixa, frete médio e prazo de repasse. A margem dos anúncios e dos pedidos usa esses números. Não há integração automática: pedidos entram por lançamento e os anúncios saem em planilha." path="/marketplaces" perm="marketplace"
  fields={[{ key: 'name', label: 'Nome do canal', required: true }, { key: 'commission_pct', label: 'Comissão (%)', type: 'number', step: '0.01' }, { key: 'fixed_fee', label: 'Taxa fixa por pedido (R$)', type: 'number', step: '0.01' },
    { key: 'shipping_cost', label: 'Frete médio pago por pedido (R$)', type: 'number', step: '0.01' }, { key: 'payout_days', label: 'Repasse em (dias)', type: 'number' }, { key: 'notes', label: 'Observações', type: 'textarea', full: true }, { key: 'active', label: 'Ativo', type: 'checkbox' }]}
  extras={(row) => <Summary row={row} />} />;

// ---------------------------------------------------------------- Anúncios
export function MarketplaceListings() {
  const { can } = useAuth(); const mks = useMarketplaces(); const [mk, setMk] = useState(''); const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  const [f, setF] = useState<any>({ product: null, price: '', external_sku: '', stock_buffer: '0' }); const [eco, setEco] = useState<any>(null);
  useEffect(() => { if (!mk && mks.length) setMk(mks[0].id); }, [mks]); // eslint-disable-line
  const load = () => mk && get(`/marketplaces/${mk}/listings`).then(setD).catch((e) => setErr(e.message)); useEffect(() => { setD(null); load(); }, [mk]); // eslint-disable-line
  useEffect(() => { setEco(null); if (!mk || !f.product || !(Number(f.price) > 0)) return; const t = setTimeout(() => get(`/marketplaces/${mk}/economics` + qs({ product_id: f.product.id, price: f.price })).then(setEco).catch(() => {}), 300); return () => clearTimeout(t); }, [mk, f.product, f.price]);
  const save = async () => { setErr(''); try { await api('PUT', `/marketplaces/${mk}/listings`, { product_id: f.product.id, price: Number(f.price), external_sku: f.external_sku || null, stock_buffer: Number(f.stock_buffer) || 0 }); setF({ product: null, price: '', external_sku: '', stock_buffer: '0' }); await load(); } catch (e) { setErr((e as ApiError).message); } };
  const download = async () => { const r = await fetch(`/api/marketplaces/${mk}/listings/export`, { headers: { authorization: `Bearer ${getToken()}` } }); const b = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'anuncios.csv'; a.click(); };
  return <><h1>Anúncios por marketplace</h1><p className="sub">Preço de cada produto no canal, com a margem que sobra depois de imposto, comissão, taxa fixa, frete e custo. A quantidade publicável desconta a reserva de segurança. Publique pelo painel do marketplace usando a planilha.</p>
    <div className="toolbar"><select style={{ width: 240 }} value={mk} onChange={(e) => setMk(e.target.value)}>{mks.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select><span style={{ flex: 1 }} />{d && d.items.length > 0 && <button onClick={download}>Baixar planilha de publicação (CSV)</button>}</div>
    {!mks.length && <div className="card muted">Cadastre um marketplace em Marketplace → Canais.</div>}<Err e={err} />
    {can('marketplace:edit') && mk && <div className="card" style={{ marginBottom: 12 }}><b>Novo anúncio / alterar preço</b><div className="toolbar" style={{ marginTop: 6 }}><ProductPick value={f.product} onChange={(p) => setF({ ...f, product: p })} />
      <input style={{ width: 110 }} type="number" step="0.01" placeholder="Preço" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /><input style={{ width: 150 }} placeholder="SKU no marketplace" value={f.external_sku} onChange={(e) => setF({ ...f, external_sku: e.target.value })} />
      <input style={{ width: 110 }} type="number" title="Reserva de segurança (não publicar)" placeholder="Reserva" value={f.stock_buffer} onChange={(e) => setF({ ...f, stock_buffer: e.target.value })} /><button className="primary" disabled={!f.product || !(Number(f.price) > 0)} onClick={save}>Salvar</button></div>
      {eco && <div className={`alert ${eco.losing_money ? 'red' : eco.below_min ? 'yellow' : 'green'}`} style={{ marginTop: 8 }}>Margem {brl(eco.margin)} ({pct(eco.margin_pct)}): preço {brl(eco.price)} − custo {brl(eco.cost)} − imposto {brl(eco.tax)} − comissão {brl(eco.commission)} − taxa {brl(eco.fixed_fee)} − frete {brl(eco.shipping)}.
        {eco.price_for_target_margin != null && <> Preço para a margem alvo ({pct(eco.target_margin_pct)}): <b>{brl(eco.price_for_target_margin)}</b>.</>} {eco.losing_money ? 'Este preço dá prejuízo.' : eco.below_min ? `Abaixo da margem mínima (${pct(eco.min_margin_pct)}).` : ''}</div>}</div>}
    {d && <table><thead><tr><th>Produto</th><th>SKU no canal</th><th className="num">Preço</th><th className="num">Margem</th><th className="num">Disponível</th><th className="num">Reserva</th><th className="num">Publicar</th><th /></tr></thead><tbody>
      {d.items.map((l: any) => <tr key={l.id}><td>{l.sku} — {l.description}</td><td>{l.external_sku ?? '—'}</td><td className="num">{brl(l.price)}</td><td className="num" style={{ color: l.losing_money ? 'var(--red)' : undefined }}>{brl(l.margin)} ({pct(l.margin_pct)}){l.losing_money ? ' ▲' : l.below_min ? ' ●' : ''}</td>
        <td className="num">{l.available}</td><td className="num">{l.stock_buffer}</td><td className="num"><b>{l.publish_qty}</b></td><td>{can('marketplace:delete') && <button className="danger" onClick={async () => { if (confirm('Remover anúncio?')) { await api('DELETE', `/marketplaces/${mk}/listings/${l.product_id}`); load(); } }}>remover</button>}</td></tr>)}
      {!d.items.length && <tr><td colSpan={8} className="muted">Nenhum anúncio neste canal.</td></tr>}</tbody></table>}</>;
}

// ---------------------------------------------------------------- Pedidos
function NewOrder({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const mks = useMarketplaces().filter((m) => m.active); const [f, setF] = useState<any>({ marketplace_id: '', external_order_id: '', buyer: '', shipping_cost: '', commission: '' }); const [items, setItems] = useState<any[]>([{ product: null, qty: '1', unit_price: '' }]); const [err, setErr] = useState('');
  useEffect(() => { if (!f.marketplace_id && mks.length) setF((x: any) => ({ ...x, marketplace_id: mks[0].id })); }, [mks]); // eslint-disable-line
  const set = (k: number, p: any) => setItems(items.map((x, i) => (i === k ? { ...x, ...p } : x)));
  const save = async () => { setErr(''); try { await api('POST', '/marketplace-orders', { marketplace_id: f.marketplace_id, external_order_id: f.external_order_id, buyer: f.buyer || null, shipping_cost: f.shipping_cost === '' ? undefined : Number(f.shipping_cost), commission: f.commission === '' ? undefined : Number(f.commission),
    items: items.filter((i) => i.product).map((i) => ({ product_id: i.product.id, qty: Number(i.qty), unit_price: i.unit_price === '' ? undefined : Number(i.unit_price) })) }); onDone(); } catch (e) { setErr((e as ApiError).message); } };
  return <Modal onClose={onClose}><h3 style={{ marginTop: 0 }}>Registrar pedido do marketplace</h3><p className="muted">Gera a venda concluída (baixa o estoque, calcula custo e margem) e o recebível no prazo de repasse do canal. Preço em branco usa o preço do anúncio.</p>
    <div className="toolbar"><select style={{ width: 200 }} value={f.marketplace_id} onChange={(e) => setF({ ...f, marketplace_id: e.target.value })}>{mks.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
      <input placeholder="Nº do pedido no marketplace" value={f.external_order_id} onChange={(e) => setF({ ...f, external_order_id: e.target.value })} /><input placeholder="Comprador (opcional)" value={f.buyer} onChange={(e) => setF({ ...f, buyer: e.target.value })} /></div>
    {items.map((it, k) => <div key={k} className="toolbar"><ProductPick value={it.product} onChange={(p) => set(k, { product: p })} /><input style={{ width: 80 }} type="number" min="1" value={it.qty} onChange={(e) => set(k, { qty: e.target.value })} /><input style={{ width: 120 }} type="number" step="0.01" placeholder="Preço unit." value={it.unit_price} onChange={(e) => set(k, { unit_price: e.target.value })} />
      {items.length > 1 && <button onClick={() => setItems(items.filter((_, i) => i !== k))}>×</button>}</div>)}
    <button onClick={() => setItems([...items, { product: null, qty: '1', unit_price: '' }])}>+ item</button>
    <div className="toolbar" style={{ marginTop: 8 }}><input style={{ width: 200 }} type="number" step="0.01" placeholder="Comissão real (R$) — opcional" value={f.commission} onChange={(e) => setF({ ...f, commission: e.target.value })} /><input style={{ width: 200 }} type="number" step="0.01" placeholder="Frete real (R$) — opcional" value={f.shipping_cost} onChange={(e) => setF({ ...f, shipping_cost: e.target.value })} /></div>
    <Err e={err} /><div className="right"><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!f.external_order_id || !items.some((i) => i.product)} onClick={save}>Registrar pedido</button></div></Modal>;
}
function Receive({ o, onClose, onDone }: { o: any; onClose(): void; onDone(): void }) {
  const [accs, setAccs] = useState<any[]>([]); const [f, setF] = useState<any>({ account_id: '', date: today(), commission: String(o.commission), fixed_fee: String(o.fixed_fee), shipping_cost: String(o.shipping_cost) }); const [err, setErr] = useState('');
  useEffect(() => { get('/bank-accounts').then((r) => { setAccs(r.items.filter((a: any) => a.active)); if (r.items[0]) setF((x: any) => ({ ...x, account_id: r.items[0].id })); }); }, []);
  const fee = Number(f.commission) + Number(f.fixed_fee) + Number(f.shipping_cost);
  const save = async () => { setErr(''); try { await api('POST', `/marketplace-orders/${o.id}/receive`, { account_id: f.account_id, date: f.date, commission: Number(f.commission), fixed_fee: Number(f.fixed_fee), shipping_cost: Number(f.shipping_cost) }); onDone(); } catch (e) { setErr((e as ApiError).message); } };
  return <Modal onClose={onClose}><h3 style={{ marginTop: 0 }}>Repasse do pedido {o.external_order_id}</h3><p className="muted">Informe os valores reais do extrato do marketplace. Bruto {brl(o.gross)} → líquido {brl(Number(o.gross) - fee)}.</p>
    <div className="form-grid"><label>Conta que recebeu<select value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>{accs.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Data<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
      <label>Comissão (R$)<input type="number" step="0.01" value={f.commission} onChange={(e) => setF({ ...f, commission: e.target.value })} /></label><label>Taxa fixa (R$)<input type="number" step="0.01" value={f.fixed_fee} onChange={(e) => setF({ ...f, fixed_fee: e.target.value })} /></label>
      <label>Frete (R$)<input type="number" step="0.01" value={f.shipping_cost} onChange={(e) => setF({ ...f, shipping_cost: e.target.value })} /></label></div>
    <Err e={err} /><div className="right"><button onClick={onClose}>Cancelar</button><button className="primary" onClick={save}>Confirmar recebimento</button></div></Modal>;
}
const ST: Record<string, string> = { a_receber: 'yellow', recebido: 'green', cancelado: 'gray' };
export function MarketplaceOrders() {
  const { can } = useAuth(); const mks = useMarketplaces(); const [f, setF] = useState({ marketplace_id: '', status: '', late: false }); const [d, setD] = useState<any>({ items: [] }); const [err, setErr] = useState(''); const [creating, setCreating] = useState(false); const [recv, setRecv] = useState<any>(null);
  const load = () => get('/marketplace-orders' + qs({ marketplace_id: f.marketplace_id, status: f.status, late: f.late || '' })).then(setD).catch((e) => setErr(e.message)); useEffect(() => { load(); }, [f]); // eslint-disable-line
  const open = d.items.filter((o: any) => o.status === 'a_receber'); const pend = open.reduce((s: number, o: any) => s + Number(o.expected_net), 0);
  return <><h1>Pedidos do marketplace</h1><p className="sub">Cada pedido vira venda (estoque, custo, margem e relatórios) e um recebível com vencimento no repasse esperado. Ao receber, informe as taxas reais: a diferença entra como despesa.</p>
    <div className="toolbar"><select style={{ width: 200 }} value={f.marketplace_id} onChange={(e) => setF({ ...f, marketplace_id: e.target.value })}><option value="">Todos os canais</option>{mks.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
      <select style={{ width: 160 }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Todos</option><option value="a_receber">A receber</option><option value="recebido">Recebido</option><option value="cancelado">Cancelado</option></select>
      <label className="chk" style={{ margin: 0 }}><input type="checkbox" checked={f.late} onChange={(e) => setF({ ...f, late: e.target.checked })} />repasse atrasado</label><span style={{ flex: 1 }} /><span className="muted">A receber (líquido): <b>{brl(pend)}</b></span>
      {can('marketplace:create') && <button className="primary" onClick={() => setCreating(true)}>+ Registrar pedido</button>}</div>
    <Err e={err} />
    <table><thead><tr><th>Pedido</th><th>Canal</th><th>Venda</th><th className="num">Bruto</th><th className="num">Taxas e frete</th><th className="num">Líquido</th><th>Repasse</th><th>Status</th><th /></tr></thead><tbody>
      {d.items.map((o: any) => <tr key={o.id}><td>{o.external_order_id}</td><td>{o.marketplace_name}</td><td>nº {o.sale_number}</td><td className="num">{brl(o.gross)}</td><td className="num">{brl(Number(o.commission) + Number(o.fixed_fee) + Number(o.shipping_cost))}</td><td className="num">{brl(o.received_net ?? o.expected_net)}</td>
        <td>{date(o.payout_date)} {o.late && <span className="pill red">atrasado</span>}</td><td><span className={`pill ${ST[o.status]}`}>{o.status.replace('_', ' ')}</span></td>
        <td style={{ whiteSpace: 'nowrap' }}>{o.status === 'a_receber' && can('finance:edit') && <button className="primary" onClick={() => setRecv(o)}>Receber</button>}{' '}{o.status === 'a_receber' && can('marketplace:approve') && <button className="danger" onClick={async () => { const reason = prompt('Motivo do cancelamento:'); if (reason) { try { await api('POST', `/marketplace-orders/${o.id}/cancel`, { reason }); load(); } catch (e) { setErr((e as ApiError).message); } } }}>cancelar</button>}</td></tr>)}
      {!d.items.length && <tr><td colSpan={9} className="muted">Nenhum pedido.</td></tr>}</tbody></table>
    {creating && <NewOrder onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}{recv && <Receive o={recv} onClose={() => setRecv(null)} onDone={() => { setRecv(null); load(); }} />}</>;
}
