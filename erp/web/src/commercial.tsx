import { useEffect, useRef, useState } from 'react';
import { api, ApiError, brl, get, pct, qs } from './api';
import { useAuth } from './auth';
import { DataPage, Modal } from './DataPage';

const n = (v: any) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const date = (v: any) => (v ? new Date(v).toLocaleDateString('pt-BR') : '—');
const STATUS_COLOR: Record<string, string> = { concluida: 'green', aberto: 'yellow', aguardando_aprovacao: 'red', cancelada: 'gray', convertido: 'green', aprovado: 'green', enviado: 'yellow', visualizado: 'yellow', rascunho: 'gray', recusado: 'red', expirado: 'gray', pendente: 'yellow' };
export const Pill = ({ s }: { s: string }) => <span className={`pill ${STATUS_COLOR[s] ?? 'gray'}`}>{s.replace('_', ' ')}</span>;
const METHODS: [string, string][] = [['dinheiro', 'Dinheiro'], ['pix', 'Pix'], ['cartao_debito', 'Cartão débito'], ['cartao_credito', 'Cartão crédito'], ['boleto', 'Boleto'], ['crediario', 'Crediário']];

export function CustomerPicker({ value, onChange, required }: { value: any; onChange: (c: any) => void; required?: boolean }) {
  const [q, setQ] = useState(''); const [res, setRes] = useState<any[]>([]);
  useEffect(() => { if (q.length < 2) return setRes([]); const t = setTimeout(() => get('/customers' + qs({ q, pageSize: 6, status: 'ativo' })).then((r) => setRes(r.items)), 250); return () => clearTimeout(t); }, [q]);
  if (value) return <div><b>{value.legal_name}</b> <span className="muted">{value.price_table}</span> <button onClick={() => onChange(null)}>trocar</button></div>;
  return <div style={{ position: 'relative' }}><input placeholder={required ? 'Cliente (obrigatório)…' : 'Cliente (opcional — consumidor final)…'} value={q} onChange={(e) => setQ(e.target.value)} />
    {res.length > 0 && <div className="results">{res.map((c) => <a key={c.id} href="#" onClick={(e) => { e.preventDefault(); onChange(c); setQ(''); }}><b>{c.legal_name}</b><small>{c.document} · {c.city} · tabela {c.price_table}</small></a>)}</div>}</div>;
}

export interface CartItem { product_id: string; sku: string; description: string; qty: number; discount_pct: number; price: number; disponivel: number }

/** Carrinho com busca PDV (código, EAN, descrição, aplicação). Enter adiciona o resultado exato/primeiro. */
export function Cart({ customer, items, setItems, channel, onPreview }: { customer: any; items: CartItem[]; setItems: (i: CartItem[]) => void; channel: string; onPreview?: (p: any) => void }) {
  const [q, setQ] = useState(''); const [res, setRes] = useState<any[]>([]); const [preview, setPreview] = useState<any>(null); const [err, setErr] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const search = async (text: string) => get('/pdv/search' + qs({ q: text, customer_id: customer?.id, channel })).then((r) => r.items);
  useEffect(() => { if (!q.trim()) return setRes([]); const t = setTimeout(() => search(q).then(setRes).catch((e) => setErr(e.message)), 200); return () => clearTimeout(t); }, [q, customer]);
  const add = (p: any) => {
    setErr('');
    if (items.find((i) => i.product_id === p.id)) setItems(items.map((i) => (i.product_id === p.id ? { ...i, qty: i.qty + 1 } : i)));
    else setItems([...items, { product_id: p.id, sku: p.sku, description: p.description, qty: 1, discount_pct: 0, price: p.price, disponivel: Number(p.disponivel) }]);
    setQ(''); setRes([]); ref.current?.focus();
  };
  const onKey = async (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || !q.trim()) return;
    const r = res.length && res[0] ? res : await search(q);
    const pick = r.find((x: any) => x.exact) ?? (r.length === 1 ? r[0] : null);
    if (pick) add(pick); else if (!r.length) setErr('Nenhum produto encontrado.');
  };
  useEffect(() => {
    if (!items.length) { setPreview(null); onPreview?.(null); return; }
    const t = setTimeout(() => api('POST', '/sales/preview', { customer_id: customer?.id ?? null, channel, items: items.map((i) => ({ product_id: i.product_id, qty: i.qty, discount_pct: i.discount_pct })) })
      .then((p) => { setPreview(p); onPreview?.(p); setErr(''); }).catch((e) => setErr((e as ApiError).message)), 250);
    return () => clearTimeout(t);
  }, [items, customer, channel]);
  const upd = (id: string, patch: Partial<CartItem>) => setItems(items.map((i) => (i.product_id === id ? { ...i, ...patch } : i)));
  const line = (id: string) => preview?.lines.find((l: any) => l.product_id === id);
  return <div>
    <input ref={ref} autoFocus placeholder="Leia o código de barras ou digite código / descrição / “pastilha cg 160 2020”… (Enter)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
    {res.length > 0 && <div className="card" style={{ marginTop: 6, padding: 6 }}>{res.map((p) => <div key={p.id} style={{ padding: '5px 4px', borderBottom: '1px solid var(--line)' }}>
      <button onClick={() => add(p)}>+ {brl(p.price)}</button> <b>{p.sku}</b> {p.description} <span className="muted">{p.brand_name} · {p.manufacturer_code ?? ''} · {p.location ?? ''}</span>{' '}
      <span className={`pill ${Number(p.disponivel) > 0 ? 'green' : 'red'}`}>{n(p.disponivel)} em estoque</span> {p.price_source !== 'varejo' && <span className="pill gray">{p.price_source}</span>}
      {p.equivalents?.length > 0 && <div style={{ marginLeft: 30 }} className="muted">Sem estoque. Equivalentes: {p.equivalents.filter((e: any) => Number(e.disponivel) > 0).map((e: any) =>
        <a key={e.id} href="#" style={{ marginRight: 10 }} onClick={(ev) => { ev.preventDefault(); add({ ...e, price: e.sale_price, disponivel: e.disponivel }); }}>{e.brand_name} {e.manufacturer_code ?? e.sku} ({n(e.disponivel)} un · {brl(e.sale_price)})</a>)}</div>}</div>)}</div>}
    {err && <div className="err">{err}</div>}
    <table style={{ marginTop: 10 }}><thead><tr><th>Produto</th><th className="num">Preço</th><th style={{ width: 80 }}>Qtd</th><th style={{ width: 80 }}>Desc. %</th><th className="num">Unit.</th><th className="num">Total</th><th className="num">Margem</th><th /></tr></thead><tbody>
      {items.map((i) => { const l = line(i.product_id); const bad = l && l.margin_after_pct < l.min_margin_pct;
        return <tr key={i.product_id}><td>{i.sku} {i.description}{i.qty > i.disponivel && <div className="err" style={{ margin: 0 }}>Estoque insuficiente ({n(i.disponivel)})</div>}</td>
          <td className="num">{brl(l?.list_price ?? i.price)}</td>
          <td><input type="number" min="1" value={i.qty} onChange={(e) => upd(i.product_id, { qty: Number(e.target.value) })} /></td>
          <td><input type="number" min="0" max="99" step="0.5" value={i.discount_pct} onChange={(e) => upd(i.product_id, { discount_pct: Number(e.target.value) })} /></td>
          <td className="num">{l ? brl(l.unit_price) : '…'}</td><td className="num">{l ? brl(l.total) : '…'}</td>
          <td className="num">{l && <span className={`pill ${bad ? 'red' : 'green'}`} title={`antes do desconto ${pct(l.margin_before_pct)} · mínima ${pct(l.min_margin_pct)}`}>{pct(l.margin_after_pct)}</span>}</td>
          <td><button onClick={() => setItems(items.filter((x) => x.product_id !== i.product_id))}>×</button></td></tr>; })}
      {!items.length && <tr><td colSpan={8} className="muted">Carrinho vazio.</td></tr>}</tbody></table>
  </div>;
}

function PreviewBox({ p }: { p: any }) {
  if (!p) return null; const t = p.totals;
  return <div className="card" style={{ marginTop: 10 }}>
    <div className="grid kpis"><div><div className="l muted">Subtotal (tabela)</div><b>{brl(t.subtotal)}</b></div><div><div className="l muted">Descontos (impacto)</div><b>{brl(t.discount_total)}</b></div>
      <div><div className="l muted">Total</div><b style={{ fontSize: 22 }}>{brl(t.total)}</b></div><div><div className="l muted">Margem líquida estimada</div><b>{brl(t.margin_total)} ({pct(t.margin_pct)})</b></div></div>
    {p.violations.map((v: any, i: number) => <div key={i} className="alert red" style={{ marginTop: 8 }}>{v.message}</div>)}
    {p.violations.length > 0 && <div className={`alert ${p.can_approve ? 'yellow' : 'red'}`}>{p.can_approve ? 'Você pode aprovar: a venda será liberada e o desvio ficará registrado na auditoria.' : `Acima da sua alçada (${p.discount_limit_pct}%): a venda será enviada para aprovação do gestor.`}</div>}
    {p.warnings.map((w: string, i: number) => <div key={i} className="alert yellow" style={{ marginTop: 8 }}>{w}</div>)}</div>;
}

// ---------------------------------------------------------------- PDV / nova venda
export function PDV() {
  const { me } = useAuth(); const [customer, setCustomer] = useState<any>(null); const [items, setItems] = useState<CartItem[]>([]); const [preview, setPreview] = useState<any>(null);
  const [type, setType] = useState('balcao'); const [pays, setPays] = useState<{ method: string; amount: string; installments: string }[]>([{ method: 'pix', amount: '', installments: '1' }]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; sugg?: any[] } | null>(null); const [busy, setBusy] = useState(false);
  const total = preview?.totals.total ?? 0; const paid = pays.reduce((s, p) => s + (Number(p.amount) || 0), 0); const channel = type === 'recorrente' ? 'b2b' : type;
  const reset = () => { setItems([]); setCustomer(null); setPays([{ method: 'pix', amount: '', installments: '1' }]); setPreview(null); };
  const submit = async (confirm: boolean) => {
    setBusy(true); setMsg(null);
    try {
      const payments = pays.filter((p) => Number(p.amount) > 0).map((p) => ({ method: p.method, amount: Number(p.amount), installments: Number(p.installments) || 1 }));
      const r = await api('POST', '/sales', { type, customer_id: customer?.id ?? null, branch_id: me?.branchId, items: items.map((i) => ({ product_id: i.product_id, qty: i.qty, discount_pct: i.discount_pct })), confirm, payments: confirm ? payments : undefined });
      setMsg({ ok: true, text: r.status === 'concluida' ? `Venda nº ${r.number} concluída — ${brl(r.total)}.` : r.status === 'aguardando_aprovacao' ? `Pedido nº ${r.number} enviado para aprovação do gestor (estoque reservado).` : `Pedido nº ${r.number} salvo e estoque reservado.` });
      reset();
    } catch (e) { setMsg({ ok: false, text: (e as ApiError).message, sugg: (e as any).suggestions }); } finally { setBusy(false); }
  };
  return <><h1>PDV / Nova venda</h1><p className="sub">Busca por código, código de barras, SKU, fabricante, original, descrição ou aplicação.</p>
    {msg && <div className={`alert ${msg.ok ? 'green' : 'red'}`}>{msg.text}</div>}
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', marginBottom: 12 }}>
      <div><label>Cliente</label><CustomerPicker value={customer} onChange={setCustomer} required={type !== 'balcao'} /></div>
      <div><label>Tipo de venda</label><select value={type} onChange={(e) => setType(e.target.value)}>{[['balcao', 'Balcão'], ['atacado', 'Atacado'], ['b2b', 'B2B'], ['externo', 'Vendedor externo'], ['online', 'Online']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div></div>
    <Cart customer={customer} items={items} setItems={setItems} channel={channel} onPreview={setPreview} /><PreviewBox p={preview} />
    <div className="card" style={{ marginTop: 10 }}><b>Pagamento</b> <span className="muted">(múltiplas formas)</span>
      {pays.map((p, k) => <div key={k} className="toolbar" style={{ marginTop: 6 }}>
        <select style={{ width: 170 }} value={p.method} onChange={(e) => setPays(pays.map((x, y) => (y === k ? { ...x, method: e.target.value } : x)))}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <input style={{ width: 130 }} type="number" step="0.01" placeholder="Valor" value={p.amount} onChange={(e) => setPays(pays.map((x, y) => (y === k ? { ...x, amount: e.target.value } : x)))} />
        {['cartao_credito', 'boleto', 'crediario'].includes(p.method) && <input style={{ width: 90 }} type="number" min="1" max="24" title="Parcelas" value={p.installments} onChange={(e) => setPays(pays.map((x, y) => (y === k ? { ...x, installments: e.target.value } : x)))} />}
        <button onClick={() => setPays(pays.map((x, y) => (y === k ? { ...x, amount: String(Math.max(0, total - (paid - (Number(x.amount) || 0))).toFixed(2)) } : x)))}>restante</button>
        {pays.length > 1 && <button onClick={() => setPays(pays.filter((_, y) => y !== k))}>×</button>}</div>)}
      <div className="toolbar"><button onClick={() => setPays([...pays, { method: 'dinheiro', amount: '', installments: '1' }])}>+ forma</button><span className={Math.abs(paid - total) < 0.01 ? 'pill green' : 'pill yellow'}>pago {brl(paid)} / total {brl(total)}</span></div></div>
    <div className="right"><button onClick={reset}>Limpar</button><button disabled={busy || !items.length} onClick={() => submit(false)}>Salvar como pedido</button>
      <button className="primary" disabled={busy || !items.length || preview?.needs_approval} onClick={() => submit(true)}>Finalizar venda</button>
      {preview?.needs_approval && <button className="primary" disabled={busy} onClick={() => submit(false)}>Enviar para aprovação</button>}</div>
    {msg?.sugg?.length ? <div className="card" style={{ marginTop: 10 }}><b>Equivalentes disponíveis</b>{msg.sugg.map((s) => <div key={s.id}>{s.brand_name} {s.manufacturer_code ?? s.sku} — {s.description} · {n(s.disponivel)} un · {brl(s.sale_price)}</div>)}</div> : null}</>;
}

// ---------------------------------------------------------------- Vendas
export function Sales({ pending }: { pending?: boolean }) {
  const [status, setStatus] = useState(pending ? 'aguardando_aprovacao' : ''); const [q, setQ] = useState(''); const [d, setD] = useState<any>({ items: [], total: 0 }); const [open, setOpen] = useState<string | null>(null);
  const load = () => get('/sales' + qs({ status, q, pageSize: 100 })).then(setD); useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [status, q]);
  return <><h1>Vendas</h1><p className="sub">Pedidos e vendas concluídas. Cada venda gera estoque, recebíveis, comissão e margem.</p>
    <div className="toolbar"><input placeholder="Nº ou cliente…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select style={{ width: 200 }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos os status</option>{['aguardando_aprovacao', 'aberto', 'concluida', 'cancelada'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select><span className="muted">{d.total} vendas</span></div>
    <table><thead><tr><th>Nº</th><th>Data</th><th>Cliente</th><th>Vendedor</th><th>Tipo</th><th className="num">Total</th><th className="num">Margem</th><th>Status</th></tr></thead><tbody>
      {d.items.map((s: any) => <tr key={s.id} className="click" onClick={() => setOpen(s.id)}><td>{s.number}</td><td>{date(s.confirmed_at ?? s.created_at)}</td><td>{s.customer_name ?? <span className="muted">Consumidor final</span>}</td><td>{s.seller_name}</td><td>{s.type}</td>
        <td className="num">{brl(s.total)}</td><td className="num">{s.status === 'concluida' ? pct(Number(s.total) > 0 ? Number(s.margin_total) / Number(s.total) * 100 : 0) : '—'}</td><td><Pill s={s.status} /></td></tr>)}</tbody></table>
    {open && <SaleDetail id={open} onClose={() => { setOpen(null); load(); }} />}</>;
}

function SaleDetail({ id, onClose }: { id: string; onClose(): void }) {
  const { me, can } = useAuth(); const [s, setS] = useState<any>(null); const [err, setErr] = useState(''); const [pays, setPays] = useState<any[]>([]);
  const load = () => get('/sales/' + id).then((x) => { setS(x); setPays([{ method: 'pix', amount: String(x.total), installments: '1' }]); }); useEffect(() => { load(); }, [id]);
  if (!s) return null;
  const run = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); await load(); } catch (e) { setErr((e as ApiError).message); } };
  const ap = s.approvals.find((a: any) => a.status === 'pendente');
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>Venda nº {s.number} <Pill s={s.status} /></h2>
    <p className="muted">{s.customer_name ?? 'Consumidor final'} · vendedor {s.seller_name} · filial {s.branch_name} · {s.type}</p>
    <table><thead><tr><th>Produto</th><th className="num">Qtd</th><th className="num">Tabela</th><th className="num">Desc.</th><th className="num">Unit.</th><th className="num">Total</th><th className="num">Margem</th></tr></thead><tbody>
      {s.items.map((i: any) => <tr key={i.id}><td>{i.sku} {i.description}</td><td className="num">{n(i.qty)}</td><td className="num">{brl(i.list_price)}</td><td className="num">{pct(i.discount_pct)}</td><td className="num">{brl(i.unit_price)}</td><td className="num">{brl(i.total)}</td><td className="num">{pct(i.margin_pct)}</td></tr>)}</tbody></table>
    <div className="grid kpis" style={{ margin: '12px 0' }}>{[['Total', s.total], ['CMV', s.cost_total], [`Impostos est. (${n(s.tax_pct)}%)`, s.tax_amount], ['Margem', s.margin_total], [`Comissão (${n(s.commission_pct)}%)`, s.commission_amount]].map(([l, v]) => <div key={l as string} className="card kpi"><div className="v" style={{ fontSize: 18 }}>{brl(v)}</div><div className="l">{l}</div></div>)}</div>
    {s.fiscal?.length > 0 || (s.status === 'concluida' && can('fiscal:create')) ? <div className="card" style={{ margin: '8px 0' }}><b>Nota fiscal</b> {s.fiscal.map((f: any) => <span key={f.id} style={{ marginLeft: 8 }}>{f.kind === 'venda' ? '' : 'devolução '}{f.model === '55' ? 'NF-e' : 'NFC-e'} {f.number ?? ''} <Pill s={f.status} /> {f.simulated && <span className="pill red">SIMULADO</span>}</span>)}
      {s.status === 'concluida' && can('fiscal:create') && !s.fiscal.some((f: any) => f.kind === 'venda' && ['rascunho', 'autorizada'].includes(f.status)) && <button style={{ marginLeft: 12 }} onClick={() => run(async () => { await api('POST', '/fiscal/documents/from-sale', { sale_id: id }); alert('Rascunho da nota gerado. Finalize em Fiscal → Notas fiscais.'); })}>Gerar nota fiscal</button>}</div> : null}
    {s.receivables.length > 0 && <><b>Recebíveis</b><table><tbody>{s.receivables.map((r: any) => <tr key={r.id}><td>{r.installment_no}/{r.installments}</td><td>{r.method}</td><td>{date(r.due_date)}</td><td className="num">{brl(r.amount)}</td><td><Pill s={r.status} /></td></tr>)}</tbody></table></>}
    {s.approvals.map((a: any) => <div key={a.id} className={`alert ${a.status === 'aprovado' ? 'green' : a.status === 'recusado' ? 'red' : 'yellow'}`} style={{ marginTop: 8 }}><b>Aprovação {a.status}</b> — solicitada por {a.requested_by_name}{a.decided_by_name ? `, decidida por ${a.decided_by_name}` : ''}{a.note ? ` (${a.note})` : ''}{a.violations.map((v: any, i: number) => <div key={i}>• {v.message}</div>)}</div>)}
    {s.status === 'aberto' && <div className="card" style={{ marginTop: 10 }}><b>Concluir venda</b>{pays.map((p, k) => <div key={k} className="toolbar" style={{ marginTop: 6 }}>
      <select style={{ width: 170 }} value={p.method} onChange={(e) => setPays(pays.map((x, y) => (y === k ? { ...x, method: e.target.value } : x)))}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <input style={{ width: 130 }} type="number" step="0.01" value={p.amount} onChange={(e) => setPays(pays.map((x, y) => (y === k ? { ...x, amount: e.target.value } : x)))} />
      <input style={{ width: 80 }} type="number" min="1" title="Parcelas" value={p.installments} onChange={(e) => setPays(pays.map((x, y) => (y === k ? { ...x, installments: e.target.value } : x)))} /></div>)}
      <button className="primary" onClick={() => run(() => api('POST', `/sales/${id}/confirm`, { payments: pays.map((p) => ({ method: p.method, amount: Number(p.amount), installments: Number(p.installments) || 1 })) }))}>Confirmar pagamento e baixar estoque</button></div>}
    {err && <div className="err">{err}</div>}
    <div className="right">
      {can('sales:create') && s.status !== 'cancelada' && <button onClick={() => run(async () => { const r = await api('POST', `/sales/${id}/repeat`); alert(`Novo pedido nº ${r.number} criado.`); })}>Repetir pedido</button>}
      {s.status !== 'cancelada' && can('sales:edit') && <button className="danger" onClick={() => { const reason = prompt('Motivo do cancelamento:'); if (reason) run(() => api('POST', `/sales/${id}/cancel`, { reason })); }}>Cancelar</button>}
      {ap && can('sales:approve') && ap.requested_by !== me?.user.id && <><button onClick={() => run(() => api('POST', `/approvals/${ap.id}/reject`, { note: prompt('Motivo da recusa:') ?? '' }))}>Recusar</button><button className="primary" onClick={() => run(() => api('POST', `/approvals/${ap.id}/approve`, {}))}>Aprovar</button></>}
      <button onClick={onClose}>Fechar</button></div></Modal>;
}

export function Approvals() {
  const [l, setL] = useState<any[]>([]); const [open, setOpen] = useState<string | null>(null); const [err, setErr] = useState('');
  const load = () => get('/approvals').then((r) => setL(r.items)).catch((e) => setErr(e.message)); useEffect(() => { load(); }, []);
  return <><h1>Aprovações</h1><p className="sub">Descontos acima da alçada do vendedor ou preços abaixo da margem mínima aguardam decisão do gestor.</p>{err && <div className="err">{err}</div>}
    <table><thead><tr><th>Venda</th><th>Cliente</th><th>Solicitante</th><th className="num">Total</th><th className="num">Desconto</th><th className="num">Margem</th><th>Motivo</th><th /></tr></thead><tbody>
      {l.map((a) => <tr key={a.id}><td>{a.number}</td><td>{a.customer_name ?? 'Consumidor final'}</td><td>{a.requested_by_name}</td><td className="num">{brl(a.total)}</td><td className="num">{brl(a.discount_total)}</td><td className="num">{brl(a.margin_total)}</td>
        <td>{a.violations.map((v: any, i: number) => <div key={i}>{v.message}</div>)}</td><td><button onClick={() => setOpen(a.sale_id)}>analisar</button></td></tr>)}
      {!l.length && <tr><td colSpan={8} className="muted">Nenhuma solicitação pendente.</td></tr>}</tbody></table>
    {open && <SaleDetail id={open} onClose={() => { setOpen(null); load(); }} />}</>;
}

// ---------------------------------------------------------------- Orçamentos
export function Quotes() {
  const { can } = useAuth(); const [status, setStatus] = useState(''); const [d, setD] = useState<any>({ items: [] }); const [open, setOpen] = useState<string | null>(null); const [creating, setCreating] = useState(false);
  const load = () => get('/quotes' + qs({ status, pageSize: 100 })).then(setD); useEffect(() => { load(); }, [status]);
  return <><h1>Orçamentos</h1><p className="sub">Rascunho → enviado → visualizado → aprovado → convertido em pedido.</p>
    <div className="toolbar"><select style={{ width: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos</option>{['rascunho', 'enviado', 'visualizado', 'aprovado', 'recusado', 'expirado', 'convertido'].map((s) => <option key={s}>{s}</option>)}</select><span style={{ flex: 1 }} />
      {can('quotes:create') && <button className="primary" onClick={() => setCreating(true)}>+ Novo orçamento</button>}</div>
    <table><thead><tr><th>Nº</th><th>Cliente</th><th>Vendedor</th><th>Validade</th><th className="num">Total</th><th>Status</th></tr></thead><tbody>
      {d.items.map((q: any) => <tr key={q.id} className="click" onClick={() => setOpen(q.id)}><td>{q.number}</td><td>{q.customer_name}</td><td>{q.seller_name}</td><td>{date(q.valid_until)}</td><td className="num">{brl(q.total)}</td><td><Pill s={q.status} /></td></tr>)}</tbody></table>
    {creating && <NewQuote onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); load(); setOpen(id); }} />}
    {open && <QuoteDetail id={open} onClose={() => { setOpen(null); load(); }} />}</>;
}
function NewQuote({ onClose, onDone }: { onClose(): void; onDone(id: string): void }) {
  const [customer, setCustomer] = useState<any>(null); const [items, setItems] = useState<CartItem[]>([]); const [days, setDays] = useState('7'); const [cond, setCond] = useState(''); const [lead, setLead] = useState(''); const [notes, setNotes] = useState(''); const [err, setErr] = useState(''); const [preview, setPreview] = useState<any>(null);
  const save = async () => { try { const q = await api('POST', '/quotes', { customer_id: customer.id, valid_days: Number(days), payment_condition: cond || null, lead_time_days: lead ? Number(lead) : null, notes: notes || null, items: items.map((i) => ({ product_id: i.product_id, qty: i.qty, discount_pct: i.discount_pct })) }); onDone(q.id); } catch (e) { setErr((e as Error).message); } };
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>Novo orçamento</h2>
    <div className="form"><div className="full"><label>Cliente *</label><CustomerPicker value={customer} onChange={setCustomer} required /></div>
      <div><label>Validade (dias)</label><input type="number" value={days} onChange={(e) => setDays(e.target.value)} /></div><div><label>Condição de pagamento</label><input value={cond} onChange={(e) => setCond(e.target.value)} /></div>
      <div><label>Prazo de entrega (dias)</label><input type="number" value={lead} onChange={(e) => setLead(e.target.value)} /></div><div className="full"><label>Observações</label><input value={notes} onChange={(e) => setNotes(e.target.value)} /></div></div>
    <div style={{ marginTop: 12 }}><Cart customer={customer} items={items} setItems={setItems} channel="balcao" onPreview={setPreview} /></div>
    {preview && <div className="alert yellow" style={{ marginTop: 8 }}>Total {brl(preview.totals.total)}{preview.violations.length ? ' — há desvios de alçada: serão avaliados na conversão em pedido.' : ''}</div>}
    {err && <div className="err">{err}</div>}<div className="right"><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!customer || !items.length} onClick={save}>Salvar rascunho</button></div></Modal>;
}
function QuoteDetail({ id, onClose }: { id: string; onClose(): void }) {
  const { can } = useAuth(); const [q, setQ] = useState<any>(null); const [err, setErr] = useState(''); const [link, setLink] = useState<any>(null);
  const load = () => get('/quotes/' + id).then(setQ); useEffect(() => { load(); }, [id]); if (!q) return null;
  const run = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); await load(); } catch (e) { setErr((e as ApiError).message); } };
  const final = ['convertido', 'recusado', 'expirado'].includes(q.status);
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>Orçamento nº {q.number} <Pill s={q.status} /></h2><p className="muted">{q.customer_name} · válido até {date(q.valid_until)} · {q.payment_condition ?? 'sem condição definida'}</p>
    <table><thead><tr><th>Produto</th><th className="num">Qtd</th><th className="num">Unit.</th><th className="num">Total</th></tr></thead><tbody>{q.items.map((i: any) => <tr key={i.id}><td>{i.sku} {i.description}</td><td className="num">{n(i.qty)}</td><td className="num">{brl(i.unit_price)}</td><td className="num">{brl(i.total)}</td></tr>)}</tbody></table>
    <p style={{ textAlign: 'right' }}>Total <b>{brl(q.total)}</b></p>
    {link && <div className="alert green">Link de aprovação: <a href={link.link} target="_blank">{link.link}</a>{link.whatsapp_url && <> · <a href={link.whatsapp_url} target="_blank">enviar por WhatsApp</a></>}<div className="muted">O link só é exibido agora; gerar outro invalida o anterior.</div></div>}
    {err && <div className="err">{err}</div>}
    <div className="right">{!final && can('quotes:edit') && <><button className="danger" onClick={() => run(() => api('POST', `/quotes/${id}/refuse`))}>Marcar recusado</button><button onClick={() => run(async () => setLink(await api('POST', `/quotes/${id}/send`)))}>Enviar / gerar link</button></>}
      {!final && can('sales:create') && <button className="primary" onClick={() => run(async () => { const s = await api('POST', `/quotes/${id}/convert`); alert(`Pedido nº ${s.number} criado${s.status === 'aguardando_aprovacao' ? ' (aguardando aprovação)' : ''}.`); })}>Converter em pedido</button>}<button onClick={onClose}>Fechar</button></div></Modal>;
}

export function PublicQuote({ token }: { token: string }) {
  const [q, setQ] = useState<any>(null); const [err, setErr] = useState(''); const [done, setDone] = useState('');
  useEffect(() => { fetch(`/api/public/quotes/${token}`).then(async (r) => { const j = await r.json(); r.ok ? setQ(j) : setErr(j.error); }); }, [token]);
  const act = async (a: string) => { const r = await fetch(`/api/public/quotes/${token}/${a}`, { method: 'POST' }); const j = await r.json(); r.ok ? setDone(j.message ?? `Orçamento ${j.status}.`) : setErr(j.error); };
  if (err) return <div className="login card"><div className="err">{err}</div></div>; if (!q) return null;
  return <div className="login card" style={{ maxWidth: 640 }}><div className="brand" style={{ padding: 0 }}>{q.company}</div><h2>Orçamento nº {q.number}</h2><p className="muted">Para {q.customer} · válido até {date(q.valid_until)}</p>
    <table><tbody>{q.items.map((i: any, k: number) => <tr key={k}><td>{i.description}</td><td className="num">{n(i.qty)} × {brl(i.unit_price)}</td><td className="num">{brl(i.total)}</td></tr>)}</tbody></table>
    <p style={{ textAlign: 'right', fontSize: 20 }}>Total <b>{brl(q.total)}</b></p>{q.payment_condition && <p className="muted">Pagamento: {q.payment_condition}</p>}{q.notes && <p className="muted">{q.notes}</p>}
    {done ? <div className="alert green">{done}</div> : ['visualizado', 'enviado'].includes(q.status) ? <div className="right"><button onClick={() => act('reject')}>Recusar</button><button className="primary" onClick={() => act('approve')}>APROVAR ORÇAMENTO</button></div> : <div className="alert yellow">Este orçamento está {q.status}.</div>}</div>;
}

// ---------------------------------------------------------------- Preços
export function PriceTables() {
  const { can } = useAuth(); const [sel, setSel] = useState<any>(null); const [rules, setRules] = useState<any[]>([]); const [f, setF] = useState<any>({ scope: 'all', min_qty: '1', mode: 'adjust_pct' }); const [err, setErr] = useState('');
  const [tables, setTables] = useState<any[]>([]); const [opts, setOpts] = useState<Record<string, any[]>>({});
  useEffect(() => { get('/price-tables?pageSize=100').then((r) => setTables(r.items)); get('/brands?pageSize=200').then((r) => setOpts((o) => ({ ...o, brand: r.items }))); get('/categories?pageSize=200').then((r) => setOpts((o) => ({ ...o, category: r.items }))); }, []);
  const loadRules = () => get('/price-rules' + qs({ table_id: sel?.id, pageSize: 200 })).then((r) => setRules(r.items)); useEffect(() => { if (sel) loadRules(); }, [sel]);
  const add = async () => { setErr(''); try { await api('POST', '/price-rules', { table_id: sel.id, scope: f.scope, scope_id: f.scope === 'all' ? null : f.scope_id, channel: f.channel || null, min_qty: Number(f.min_qty) || 1, [f.mode]: Number(f.value) }); loadRules(); } catch (e) { setErr((e as Error).message); } };
  return <><DataPage title="Tabelas de preço" subtitle="Varejo usa o preço do cadastro; as demais aplicam regras. Promoções só reduzem preço." path="/price-tables" perm="pricing" fields={[
    { key: 'name', label: 'Nome (igual ao informado no cliente)', required: true, list: true }, { key: 'kind', label: 'Tipo', type: 'select', options: ['varejo', 'oficina', 'atacado', 'revenda', 'especial', 'marketplace', 'promocao'].map((v) => ({ value: v, label: v })), required: true, list: true },
    { key: 'valid_from', label: 'Vigência início (AAAA-MM-DD)', list: false }, { key: 'valid_to', label: 'Vigência fim', list: false }, { key: 'active', label: 'Ativa', type: 'checkbox', list: true }]} />
    <h2 style={{ marginTop: 28 }}>Regras por tabela</h2><div className="toolbar"><select style={{ width: 240 }} value={sel?.id ?? ''} onChange={(e) => setSel(tables.find((t) => t.id === e.target.value))}><option value="">Escolha a tabela…</option>{tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
    {sel && <><table><thead><tr><th>Escopo</th><th>Cliente</th><th>Canal</th><th className="num">Qtd mín.</th><th className="num">Preço fixo</th><th className="num">Ajuste</th><th /></tr></thead><tbody>
      {rules.map((r) => <tr key={r.id}><td>{r.scope}{r.scope_name ? `: ${r.scope_name}` : ''}</td><td>{r.customer_name ?? '—'}</td><td>{r.channel ?? 'todos'}</td><td className="num">{n(r.min_qty)}</td><td className="num">{r.fixed_price != null ? brl(r.fixed_price) : '—'}</td><td className="num">{r.adjust_pct != null ? `${n(r.adjust_pct)}%` : '—'}</td>
        <td>{can('pricing:delete') && <button className="danger" onClick={() => api('DELETE', `/price-rules/${r.id}`).then(loadRules)}>remover</button>}</td></tr>)}</tbody></table>
      {can('pricing:create') && <div className="toolbar" style={{ marginTop: 8 }}><select style={{ width: 130 }} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value, scope_id: '' })}><option value="all">Todos</option><option value="category">Categoria</option><option value="brand">Marca</option><option value="product">Produto (ID)</option></select>
        {(f.scope === 'category' || f.scope === 'brand') && <select style={{ width: 180 }} value={f.scope_id ?? ''} onChange={(e) => setF({ ...f, scope_id: e.target.value })}><option value="">—</option>{opts[f.scope]?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        {f.scope === 'product' && <input style={{ width: 280 }} placeholder="UUID do produto" value={f.scope_id ?? ''} onChange={(e) => setF({ ...f, scope_id: e.target.value })} />}
        <input style={{ width: 110 }} type="number" placeholder="Qtd mín." value={f.min_qty} onChange={(e) => setF({ ...f, min_qty: e.target.value })} /><select style={{ width: 140 }} value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="adjust_pct">Ajuste %</option><option value="fixed_price">Preço fixo</option></select>
        <input style={{ width: 110 }} type="number" step="0.01" placeholder={f.mode === 'adjust_pct' ? '-10' : '25.90'} value={f.value ?? ''} onChange={(e) => setF({ ...f, value: e.target.value })} /><button className="primary" onClick={add}>Adicionar regra</button></div>}{err && <div className="err">{err}</div>}</>}</>;
}

export function Pricing() {
  const { can } = useAuth(); const [s, setS] = useState<any>(null); const [msg, setMsg] = useState(''); const [rows, setRows] = useState<any>({ items: [] }); const [q, setQ] = useState(''); const [sim, setSim] = useState<any>({ price: '', margin_pct: '' }); const [out, setOut] = useState<any>(null); const [sel, setSel] = useState<string[]>([]);
  const load = () => get('/pricing/settings').then(setS); const loadRows = () => get('/pricing/products' + qs({ q, pageSize: 50 })).then(setRows);
  useEffect(() => { load(); }, []); useEffect(() => { const t = setTimeout(loadRows, 250); return () => clearTimeout(t); }, [q]);
  if (!s) return null; const P = s.params; const F: [string, string][] = [['freight_pct', 'Frete % (s/ custo)'], ['insurance_pct', 'Seguro %'], ['accessory_pct', 'Despesas acessórias %'], ['tax_pct', 'Impostos % — Simples Nacional (alíquota efetiva)'], ['commission_pct', 'Comissão %'], ['card_fee_pct', 'Taxa de cartão %'], ['variable_expenses_pct', 'Despesas variáveis %']];
  const save = async () => { try { await api('PUT', '/pricing/settings', { params: Object.fromEntries(F.map(([k]) => [k, Number(P[k])])), monthly_goal: Number(s.goal.monthly) }); setMsg('Salvo.'); loadRows(); } catch (e) { setMsg((e as Error).message); } };
  const simulate = async () => { try { setOut(await api('POST', '/pricing/simulate', { product_id: sim.product?.id, cost: sim.cost ? Number(sim.cost) : undefined, price: Number(sim.price), margin_pct: sim.margin_pct ? Number(sim.margin_pct) : undefined })); } catch (e) { setMsg((e as Error).message); } };
  return <><h1>Precificação</h1><p className="sub">Preço = custo de aquisição ÷ (1 − impostos − comissão − cartão − despesas − margem). O custo é o custo médio global.</p>
    {!P.configured && <div className="alert yellow">Parâmetros ainda não configurados — informe a alíquota efetiva do Simples (validada pelo contador) e as demais taxas.</div>}
    <div className="card"><div className="form">{F.map(([k, l]) => <div key={k}><label>{l}</label><input type="number" step="0.01" disabled={!can('pricing:edit')} value={P[k]} onChange={(e) => setS({ ...s, params: { ...P, [k]: e.target.value } })} /></div>)}
      <div><label>Meta de faturamento mensal (R$)</label><input type="number" disabled={!can('pricing:edit')} value={s.goal.monthly} onChange={(e) => setS({ ...s, goal: { monthly: e.target.value } })} /></div></div>
      {can('pricing:edit') && <div className="right"><span className="muted">{msg}</span><button className="primary" onClick={save}>Salvar parâmetros</button></div>}</div>
    <h3>Simulador: “se eu vender por R$ X, qual será minha margem?”</h3>
    <div className="card"><div className="toolbar"><ProductPick value={sim.product} onChange={(p) => setSim({ ...sim, product: p })} /><input style={{ width: 120 }} type="number" step="0.01" placeholder="Custo (opcional)" value={sim.cost ?? ''} onChange={(e) => setSim({ ...sim, cost: e.target.value })} />
      <input style={{ width: 130 }} type="number" step="0.01" placeholder="Preço R$" value={sim.price} onChange={(e) => setSim({ ...sim, price: e.target.value })} /><input style={{ width: 150 }} type="number" step="0.1" placeholder="Margem desejada %" value={sim.margin_pct} onChange={(e) => setSim({ ...sim, margin_pct: e.target.value })} /><button className="primary" disabled={!sim.price} onClick={simulate}>Simular</button></div>
      {out && <div className="grid kpis">{[['Custo de aquisição', brl(out.acquisition_cost)], ['Custo real', brl(out.real_cost)], ['Lucro', brl(out.profit)], ['Margem', pct(out.margin_pct)], ['Markup', pct(out.markup_pct)], ['Preço p/ margem desejada', out.suggested_price != null ? brl(out.suggested_price) : '—'], ['Preço mínimo (margem mín.)', out.min_price != null ? brl(out.min_price) : '—']].map(([l, v]) => <div key={l} className="card kpi"><div className="v" style={{ fontSize: 18 }}>{v}</div><div className="l">{l}</div></div>)}</div>}</div>
    <h3>Sugestão por produto</h3><div className="toolbar"><input placeholder="Pesquisar…" value={q} onChange={(e) => setQ(e.target.value)} />{can('pricing:approve') && <button disabled={!sel.length} onClick={() => api('POST', '/pricing/apply', { product_ids: sel }).then((r) => { setMsg(`${r.changed} preço(s) atualizado(s).`); setSel([]); loadRows(); })}>Aplicar sugestão aos selecionados ({sel.length})</button>}</div>
    <table><thead><tr><th /><th>Produto</th><th className="num">Custo médio</th><th className="num">Custo aquis.</th><th className="num">Preço atual</th><th className="num">Margem atual</th><th className="num">Margem desejada</th><th className="num">Preço sugerido</th><th className="num">Preço mínimo</th></tr></thead><tbody>
      {rows.items.map((r: any) => { const low = r.current_margin_pct != null && r.current_margin_pct < Number(r.min_margin_pct); return <tr key={r.id}><td><input type="checkbox" style={{ width: 'auto' }} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td><td>{r.sku} {r.description}</td><td className="num">{brl(r.cost_basis)}</td><td className="num">{brl(r.acquisition_cost)}</td><td className="num">{brl(r.sale_price)}</td>
        <td className="num"><span className={`pill ${low ? 'red' : 'green'}`}>{pct(r.current_margin_pct)}</span></td><td className="num">{pct(r.target_margin_pct)}</td><td className="num"><b>{r.suggested_price != null ? brl(r.suggested_price) : '—'}</b></td><td className="num">{r.computed_min_price != null ? brl(r.computed_min_price) : '—'}</td></tr>; })}</tbody></table></>;
}
export function ProductPick({ value, onChange }: { value: any; onChange: (p: any) => void }) {
  const [q, setQ] = useState(''); const [res, setRes] = useState<any[]>([]);
  useEffect(() => { if (q.length < 2) return setRes([]); const t = setTimeout(() => get('/products' + qs({ q, pageSize: 6 })).then((r) => setRes(r.items)), 250); return () => clearTimeout(t); }, [q]);
  if (value) return <span><b>{value.sku}</b> {value.description} <button onClick={() => onChange(null)}>×</button></span>;
  return <div style={{ position: 'relative', width: 260 }}><input placeholder="Produto (opcional)…" value={q} onChange={(e) => setQ(e.target.value)} />{res.length > 0 && <div className="results">{res.map((p) => <a key={p.id} href="#" onClick={(e) => { e.preventDefault(); onChange(p); setQ(''); }}><b>{p.sku}</b><small>{p.description}</small></a>)}</div>}</div>;
}

// ---------------------------------------------------------------- B2B
export function B2B() {
  const { can } = useAuth(); const [q, setQ] = useState(''); const [l, setL] = useState<any[]>([]); const [open, setOpen] = useState<string | null>(null); const [rec, setRec] = useState<any[]>([]); const [msg, setMsg] = useState('');
  useEffect(() => { const t = setTimeout(() => get('/b2b/customers' + qs({ q, pageSize: 100 })).then((r) => setL(r.items)), 200); return () => clearTimeout(t); }, [q]);
  const loadRec = () => get('/b2b/recurring').then((r) => setRec(r.items)); useEffect(() => { loadRec(); }, []);
  return <><h1>B2B</h1><p className="sub">Carteira empresarial: limite, crédito, última compra e pedidos recorrentes.</p>
    <div className="toolbar"><input placeholder="Cliente ou CNPJ…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
    <table><thead><tr><th>Cliente</th><th>Tabela</th><th>Condição</th><th className="num">Limite</th><th className="num">Utilizado</th><th className="num">Disponível</th><th className="num">Vencido</th><th>Última compra</th><th className="num">Fat. 12m</th></tr></thead><tbody>
      {l.map((c) => <tr key={c.id} className="click" onClick={() => setOpen(c.id)}><td>{c.legal_name}</td><td>{c.price_table}</td><td>{c.payment_condition}</td><td className="num">{brl(c.credit_limit)}</td><td className="num">{brl(c.used)}</td><td className="num">{brl(c.available)}</td>
        <td className="num">{Number(c.overdue) > 0 ? <span className="pill red">{brl(c.overdue)}</span> : '—'}</td><td>{date(c.last_purchase)}</td><td className="num">{brl(c.revenue_12m)}</td></tr>)}</tbody></table>
    <h2 style={{ marginTop: 28 }}>Pedidos recorrentes</h2>{msg && <div className="alert green">{msg}</div>}
    <div className="toolbar">{can('sales:create') && <button className="primary" onClick={() => api('POST', '/b2b/recurring/run-due').then((r) => { setMsg(`${r.results.filter((x: any) => x.ok).length} pedido(s) gerado(s), ${r.results.filter((x: any) => !x.ok).length} com erro.`); loadRec(); })}>Gerar pedidos vencidos</button>}<span className="muted">Não há agendador automático nesta fase; o gestor dispara a geração.</span></div>
    <table><thead><tr><th>Cliente</th><th>A cada</th><th>Próxima</th><th>Itens</th><th>Ativo</th><th /></tr></thead><tbody>{rec.map((r) => <tr key={r.id}><td>{r.customer_name}</td><td>{r.interval_days} dias</td><td>{date(r.next_run)}</td><td>{r.items.length}</td><td><Pill s={r.active ? 'aprovado' : 'cancelada'} /></td>
      <td>{can('sales:create') && <button onClick={() => api('POST', `/b2b/recurring/${r.id}/run`).then(() => { setMsg('Pedido gerado.'); loadRec(); }).catch((e) => setMsg(e.message))}>gerar agora</button>} {can('sales:edit') && <button onClick={() => api('PATCH', `/b2b/recurring/${r.id}`, { active: !r.active }).then(loadRec)}>{r.active ? 'pausar' : 'ativar'}</button>}</td></tr>)}</tbody></table>
    {open && <CustomerPanel id={open} onClose={() => setOpen(null)} />}</>;
}
export function CustomerPanel({ id, onClose }: { id: string; onClose(): void }) {
  const [s, setS] = useState<any>(null); useEffect(() => { get(`/customers/${id}/summary`).then(setS); }, [id]); if (!s) return null;
  const k = (l: string, v: any) => <div className="card kpi"><div className="v" style={{ fontSize: 20 }}>{v}</div><div className="l">{l}</div></div>;
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>{s.customer.legal_name}</h2>
    <div className="grid kpis">{k('Faturamento total', brl(s.revenue))}{k('Últimos 12 meses', brl(s.revenue_12m))}{k('Ticket médio', brl(s.avg_ticket))}{k('Compras', s.sales_count)}{k('Última compra', date(s.last_purchase))}{k('Frequência média', s.avg_days_between ? `${s.avg_days_between} dias` : '—')}{k('Margem gerada', `${brl(s.margin)} (${pct(s.margin_pct)})`)}</div>
    <h3>Crédito</h3><div className="grid kpis">{k('Limite', brl(s.credit.limit))}{k('Utilizado', brl(s.credit.used))}{k('Disponível', brl(s.credit.available))}{k('Inadimplência', s.delinquency.overdue_count ? `${brl(s.delinquency.overdue_amount)} (${s.delinquency.overdue_count})` : 'Nenhuma')}</div>
    <h3>Produtos mais comprados</h3><table><tbody>{s.top_products.map((p: any) => <tr key={p.id}><td>{p.sku} {p.description}</td><td className="num">{n(p.qty)}</td><td className="num">{brl(p.total)}</td></tr>)}{!s.top_products.length && <tr><td className="muted">Sem compras.</td></tr>}</tbody></table>
    <div className="right"><button onClick={onClose}>Fechar</button></div></Modal>;
}
