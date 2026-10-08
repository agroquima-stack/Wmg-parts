import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, brl, get, qs } from './api';
import { useAuth } from './auth';
import { Modal } from './DataPage';

const n = (v: any) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const OPS: [string, string, boolean, boolean][] = [   // [op, rótulo, pede custo, pede motivo]
  ['entrada', 'Entrada', true, false], ['entrada_consignado', 'Entrada consignada', false, false], ['saida', 'Saída', false, true],
  ['ajuste_entrada', 'Ajuste (+)', false, true], ['ajuste_saida', 'Ajuste (−)', false, true], ['reserva', 'Reservar', false, false],
  ['liberacao', 'Liberar reserva', false, false], ['bloqueio', 'Bloquear (quarentena)', false, true], ['desbloqueio', 'Desbloquear', false, false], ['avaria', 'Registrar avaria', false, true]];

function useBranches() {
  const { me } = useAuth(); return me?.branches ?? [];
}

function MoveModal({ product, branchId, onClose, onDone }: { product: any; branchId: string; onClose(): void; onDone(): void }) {
  const [op, setOp] = useState('entrada'); const [qty, setQty] = useState(''); const [cost, setCost] = useState(String(product.cost_avg ?? ''));
  const [doc, setDoc] = useState(''); const [reason, setReason] = useState(''); const [err, setErr] = useState('');
  const def = OPS.find((o) => o[0] === op)!;
  const save = async () => {
    try {
      await api('POST', '/stock/movements', { op, product_id: product.id, branch_id: branchId, qty, unit_cost: def[2] && cost ? cost : undefined, document_ref: doc || undefined, reason: reason || undefined });
      onDone();
    } catch (e) { setErr((e as ApiError).message); }
  };
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>Movimentar estoque</h2><p className="muted">{product.sku} — {product.description}</p>
    <div className="form"><div><label>Operação</label><select value={op} onChange={(e) => setOp(e.target.value)}>{OPS.map((o) => <option key={o[0]} value={o[0]}>{o[1]}</option>)}</select></div>
      <div><label>Quantidade</label><input type="number" min="0" step="1" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus /></div>
      {def[2] && <div><label>Custo unitário (atualiza custo médio global)</label><input type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} /></div>}
      <div><label>Documento (NF, etc.)</label><input value={doc} onChange={(e) => setDoc(e.target.value)} /></div>
      {def[3] && <div className="full"><label>Motivo *</label><input value={reason} onChange={(e) => setReason(e.target.value)} /></div>}</div>
    {err && <div className="err">{err}</div>}<div className="right"><button onClick={onClose}>Cancelar</button><button className="primary" onClick={save}>Confirmar</button></div></Modal>;
}

export function StockPage() {
  const { can, me } = useAuth(); const branches = useBranches();
  const [branch, setBranch] = useState(me?.branchId ?? 'all'); const [q, setQ] = useState(''); const [filter, setFilter] = useState(''); const [page, setPage] = useState(1);
  const [d, setD] = useState<any>({ items: [], total: 0, pageSize: 50 }); const [sel, setSel] = useState<any>(null); const [hist, setHist] = useState<any>(null);
  const load = useCallback(() => get('/stock/balances' + qs({ branch_id: branch, q, filter, page })).then(setD), [branch, q, filter, page]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => setPage(1), [q, filter, branch]);
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  return <>
    <h1>Estoque</h1><p className="sub">Saldos por status. “Todas as filiais” mostra o consolidado da matriz.</p>
    <div className="toolbar"><input placeholder="Produto, SKU ou código…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select style={{ width: 200 }} value={branch} onChange={(e) => setBranch(e.target.value)}><option value="all">Todas as filiais</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      <select style={{ width: 190 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="">Todos</option><option value="below_min">Abaixo do mínimo</option><option value="zero">Sem estoque</option><option value="excess">Acima do máximo</option><option value="with_stock">Com estoque</option></select>
      <span className="muted">{d.total} produtos</span></div>
    <table><thead><tr><th>SKU</th><th>Produto</th><th>Local</th><th className="num">Disponível</th><th className="num">Reserv.</th><th className="num">Trânsito</th><th className="num">Avar.</th><th className="num">Quarent.</th><th className="num">Consig.</th><th className="num">Mín/Máx</th><th className="num">Valor</th><th /></tr></thead><tbody>
      {d.items.map((r: any) => { const low = Number(r.min_stock) > 0 && Number(r.disponivel) < Number(r.min_stock); const hi = Number(r.max_stock) > 0 && Number(r.disponivel) > Number(r.max_stock);
        return <tr key={r.id}><td>{r.sku}</td><td>{r.description}</td><td>{r.location}</td>
          <td className="num"><span className={`pill ${Number(r.disponivel) === 0 ? 'red' : low ? 'yellow' : hi ? 'gray' : 'green'}`}>{n(r.disponivel)}</span></td>
          <td className="num">{n(r.reservado)}</td><td className="num">{n(r.transito)}</td><td className="num">{n(r.avariado)}</td><td className="num">{n(r.quarentena)}</td><td className="num">{n(r.consignado)}</td>
          <td className="num muted">{n(r.min_stock)} / {n(r.max_stock)}</td><td className="num">{brl(r.stock_value)}</td>
          <td style={{ whiteSpace: 'nowrap' }}><button onClick={() => setHist(r)}>histórico</button> {can('stock:create') && d.branch_id && <button onClick={() => setSel(r)}>movimentar</button>}</td></tr>; })}</tbody></table>
    {branch === 'all' && can('stock:create') && <p className="muted">Para movimentar, selecione uma filial.</p>}
    <div className="pager"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>{page} / {pages}<button disabled={page >= pages} onClick={() => setPage(page + 1)}>›</button></div>
    {sel && d.branch_id && <MoveModal product={sel} branchId={d.branch_id} onClose={() => setSel(null)} onDone={() => { setSel(null); load(); }} />}
    {hist && <History product={hist} onClose={() => setHist(null)} />}
  </>;
}

function History({ product, onClose }: { product: any; onClose(): void }) {
  const [d, setD] = useState<any>({ items: [] }); useEffect(() => { get('/stock/movements' + qs({ product_id: product.id, pageSize: 100 })).then(setD); }, [product]);
  return <Modal onClose={onClose}><h3 style={{ marginTop: 0 }}>Histórico — {product.sku} {product.description}</h3><MovementsTable items={d.items} /><div className="right"><button onClick={onClose}>Fechar</button></div></Modal>;
}
function MovementsTable({ items }: { items: any[] }) {
  return <table><thead><tr><th>Data/hora</th><th>Filial</th><th>Tipo</th><th>De → Para</th><th className="num">Anterior</th><th className="num">Qtd</th><th className="num">Posterior</th><th>Documento</th><th>Usuário</th><th>Motivo</th></tr></thead><tbody>
    {items.map((m) => <tr key={m.id}><td>{new Date(m.created_at).toLocaleString('pt-BR')}</td><td>{m.branch_name}</td><td>{m.type}</td><td>{m.from_status ?? 'externo'} → {m.to_status ?? 'externo'}</td>
      <td className="num">{n(m.qty_before)}</td><td className="num">{n(m.qty)}</td><td className="num">{n(m.qty_after)}</td><td>{m.document_ref}</td><td>{m.user_name}</td><td>{m.reason}</td></tr>)}
    {!items.length && <tr><td colSpan={10} className="muted">Sem movimentações.</td></tr>}</tbody></table>;
}

export function Movements() {
  const [f, setF] = useState({ type: '', from: '', to: '' }); const [d, setD] = useState<any>({ items: [], total: 0 });
  useEffect(() => { get('/stock/movements' + qs({ ...f, pageSize: 100 })).then(setD); }, [f]);
  return <><h1>Movimentações</h1><p className="sub">Histórico imutável de todo o estoque.</p>
    <div className="toolbar"><input placeholder="Tipo (entrada, saida, ajuste…)" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} />
      <input type="date" style={{ maxWidth: 160 }} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><input type="date" style={{ maxWidth: 160 }} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
      <span className="muted">{d.total} registros</span></div>
    <MovementsTable items={d.items.map((m: any) => ({ ...m, reason: m.reason ?? '', description: m.description }))} /></>;
}

export function Transfers() {
  const { can, me } = useAuth(); const branches = useBranches(); const [list, setList] = useState<any[]>([]); const [open, setOpen] = useState(false); const [err, setErr] = useState('');
  const load = () => get('/stock/transfers').then((r) => setList(r.items)); useEffect(() => { load(); }, []);
  const act = async (id: string, a: string) => { setErr(''); try { await api('POST', `/stock/transfers/${id}/${a}`); load(); } catch (e) { setErr((e as Error).message); } };
  return <><h1>Transferências</h1><p className="sub">Saída na origem → em trânsito → recebimento no destino.</p>
    {err && <div className="err">{err}</div>}
    <div className="toolbar"><span style={{ flex: 1 }} />{can('stock:create') && <button className="primary" onClick={() => setOpen(true)}>+ Nova transferência</button>}</div>
    <table><thead><tr><th>Data</th><th>Origem</th><th>Destino</th><th>Itens</th><th>Status</th><th /></tr></thead><tbody>
      {list.map((t) => <tr key={t.id}><td>{new Date(t.created_at).toLocaleString('pt-BR')}</td><td>{t.from_name}</td><td>{t.to_name}</td>
        <td>{t.items?.map((i: any) => <div key={i.product_id}>{n(i.qty)} × {i.sku} {i.description}</div>)}</td>
        <td><span className={`pill ${t.status === 'recebida' ? 'green' : t.status === 'cancelada' ? 'gray' : 'yellow'}`}>{t.status}</span></td>
        <td>{t.status === 'em_transito' && <><button onClick={() => act(t.id, 'receive')}>Receber</button> {can('stock:edit') && <button className="danger" onClick={() => act(t.id, 'cancel')}>Cancelar</button>}</>}</td></tr>)}</tbody></table>
    {open && <NewTransfer branches={branches} from={me?.branchId ?? ''} onClose={() => setOpen(false)} onDone={() => { setOpen(false); load(); }} />}</>;
}
function NewTransfer({ branches, from, onClose, onDone }: { branches: any[]; from: string; onClose(): void; onDone(): void }) {
  const [src, setSrc] = useState(from); const [to, setTo] = useState(''); const [q, setQ] = useState(''); const [res, setRes] = useState<any[]>([]);
  const [items, setItems] = useState<{ p: any; qty: string }[]>([]); const [err, setErr] = useState('');
  useEffect(() => { if (q.length < 2) return setRes([]); const t = setTimeout(() => get('/stock/balances' + qs({ branch_id: src, q, filter: 'with_stock', pageSize: 6 })).then((r) => setRes(r.items)), 250); return () => clearTimeout(t); }, [q, src]);
  const save = async () => { try { await api('POST', '/stock/transfers', { from_branch_id: src, to_branch_id: to, items: items.map((i) => ({ product_id: i.p.id, qty: i.qty })) }); onDone(); } catch (e) { setErr((e as Error).message); } };
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>Nova transferência</h2>
    <div className="form"><div><label>Origem</label><select value={src} onChange={(e) => { setSrc(e.target.value); setItems([]); }}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
      <div><label>Destino</label><select value={to} onChange={(e) => setTo(e.target.value)}><option value="">—</option>{branches.filter((b) => b.id !== src).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
      <div className="full"><label>Adicionar produto (com saldo na origem)</label><input value={q} onChange={(e) => setQ(e.target.value)} />
        {res.map((r) => <div key={r.id} style={{ padding: '3px 0' }}><button onClick={() => { if (!items.find((i) => i.p.id === r.id)) setItems([...items, { p: r, qty: '1' }]); setQ(''); }}>+</button> {r.sku} {r.description} <span className="muted">(disp. {n(r.disponivel)})</span></div>)}</div></div>
    <table style={{ marginTop: 10 }}><tbody>{items.map((i, k) => <tr key={i.p.id}><td>{i.p.sku} {i.p.description}</td><td style={{ width: 110 }}><input type="number" value={i.qty} onChange={(e) => setItems(items.map((x, y) => (y === k ? { ...x, qty: e.target.value } : x)))} /></td><td><button onClick={() => setItems(items.filter((_, y) => y !== k))}>×</button></td></tr>)}</tbody></table>
    {err && <div className="err">{err}</div>}<div className="right"><button onClick={onClose}>Cancelar</button><button className="primary" disabled={!to || !items.length} onClick={save}>Enviar</button></div></Modal>;
}

export function Inventories() {
  const { can, me } = useAuth(); const [list, setList] = useState<any[]>([]); const [open, setOpen] = useState<any>(null); const [err, setErr] = useState(''); const [cat, setCat] = useState(''); const [type, setType] = useState('geral'); const [cats, setCats] = useState<any[]>([]);
  const load = () => get('/stock/inventories').then((r) => setList(r.items)); useEffect(() => { load(); get('/categories?pageSize=200').then((r) => setCats(r.items)).catch(() => {}); }, []);
  const create = async () => { setErr(''); try { const i = await api('POST', '/stock/inventories', { type, branch_id: me?.branchId, category_id: type === 'rotativo' ? cat || null : undefined }); load(); setOpen(i.id); } catch (e) { setErr((e as Error).message); } };
  return <><h1>Inventário</h1><p className="sub">Geral ou rotativo (por categoria). O acerto exige aprovação de quem tem permissão <code>stock:approve</code>.</p>
    {err && <div className="err">{err}</div>}
    {can('stock:create') && <div className="toolbar"><select style={{ width: 150 }} value={type} onChange={(e) => setType(e.target.value)}><option value="geral">Geral</option><option value="rotativo">Rotativo</option></select>
      {type === 'rotativo' && <select style={{ width: 220 }} value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Categoria…</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      <button className="primary" onClick={create}>Abrir inventário na filial atual</button></div>}
    <table><thead><tr><th>Abertura</th><th>Filial</th><th>Tipo</th><th>Contados</th><th>Status</th><th /></tr></thead><tbody>
      {list.map((i) => <tr key={i.id}><td>{new Date(i.created_at).toLocaleString('pt-BR')}</td><td>{i.branch_name}</td><td>{i.type}</td><td>{i.counted}/{i.items}</td><td><span className={`pill ${i.status === 'aberto' ? 'yellow' : 'green'}`}>{i.status}</span></td><td><button onClick={() => setOpen(i.id)}>abrir</button></td></tr>)}</tbody></table>
    {open && <Count id={open} onClose={() => { setOpen(null); load(); }} />}</>;
}
function Count({ id, onClose }: { id: string; onClose(): void }) {
  const { can } = useAuth(); const [d, setD] = useState<any>(null); const [msg, setMsg] = useState('');
  const load = () => get('/stock/inventories/' + id).then(setD); useEffect(() => { load(); }, [id]);
  if (!d) return null; const openInv = d.status === 'aberto';
  const count = async (pid: string, v: string) => { await api('PUT', `/stock/inventories/${id}/count`, { product_id: pid, counted_qty: v === '' ? null : v }); load(); };
  const close = async () => { if (!confirm('Fechar inventário e ajustar os saldos?')) return; try { const r = await api('POST', `/stock/inventories/${id}/close`); setMsg(`Ajustados ${r.adjusted} itens. Sobras R$ ${r.gain_value} · Perdas R$ ${r.loss_value}`); load(); } catch (e) { setMsg((e as Error).message); } };
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>Inventário {d.type} — {d.status}</h2>
    <table><thead><tr><th>Local</th><th>SKU</th><th>Produto</th><th className="num">Sistema</th><th className="num">Contado</th><th className="num">Diferença</th></tr></thead><tbody>
      {d.items.map((i: any) => <tr key={i.product_id}><td>{i.location}</td><td>{i.sku}</td><td>{i.description}</td><td className="num">{n(i.system_qty)}</td>
        <td style={{ width: 110 }}>{openInv ? <input type="number" defaultValue={i.counted_qty ?? ''} onBlur={(e) => e.target.value !== String(i.counted_qty ?? '') && count(i.product_id, e.target.value)} /> : <span className="num">{i.counted_qty == null ? '—' : n(i.counted_qty)}</span>}</td>
        <td className="num">{i.diff == null ? '—' : <span className={`pill ${Number(i.diff) === 0 ? 'green' : 'red'}`}>{n(i.diff)}</span>}</td></tr>)}</tbody></table>
    {msg && <div className="err">{msg}</div>}
    <div className="right"><button onClick={onClose}>Fechar janela</button>{openInv && can('stock:approve') && <button className="primary" onClick={close}>Aprovar e fechar inventário</button>}</div></Modal>;
}

export function StockAnalysis() {
  const { me } = useAuth(); const branches = useBranches(); const [branch, setBranch] = useState('all'); const [idle, setIdle] = useState<any[]>([]);
  const [crit, setCrit] = useState('valor_estoque'); const [abc, setAbc] = useState<any>(null); const [err, setErr] = useState(''); const [ap, setAp] = useState('80'); const [bp, setBp] = useState('95');
  useEffect(() => { get('/stock/idle' + qs({ branch_id: branch })).then((r) => setIdle(r.buckets)); }, [branch]);
  useEffect(() => { setErr(''); get('/stock/abc' + qs({ criteria: crit, branch_id: branch, a_pct: ap, b_pct: bp })).then(setAbc).catch((e) => setErr(e.message)); }, [crit, branch, ap, bp]);
  void me;
  return <><h1>Análises de estoque</h1><p className="sub">Capital parado e curva ABC.</p>
    <div className="toolbar"><select style={{ width: 200 }} value={branch} onChange={(e) => setBranch(e.target.value)}><option value="all">Todas as filiais</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
    <h3>Produtos parados (dias desde a última saída; sem saída, desde a entrada)</h3>
    <table><thead><tr><th>Faixa (dias)</th><th className="num">Produtos</th><th className="num">Qtd</th><th className="num">Custo</th><th className="num">Valor de venda</th><th className="num">Margem potencial</th><th>Sugestão</th></tr></thead><tbody>
      {idle.map((b) => <tr key={b.bucket}><td>{b.bucket}</td><td className="num">{b.products}</td><td className="num">{n(b.qty)}</td><td className="num">{brl(b.cost_value)}</td><td className="num">{brl(b.sale_value)}</td><td className="num">{brl(b.potential_margin)}</td><td className="muted">{b.suggestion}</td></tr>)}</tbody></table>
    <h3 style={{ marginTop: 24 }}>Curva ABC</h3>
    <div className="toolbar"><select style={{ width: 240 }} value={crit} onChange={(e) => setCrit(e.target.value)}><option value="valor_estoque">Valor em estoque</option><option value="quantidade">Quantidade em estoque</option><option value="saidas">Saídas (giro)</option>
      <option value="faturamento">Faturamento (Fase 3)</option><option value="margem">Margem (Fase 3)</option></select>
      <label className="chk" style={{ margin: 0 }}>A até <input style={{ width: 70 }} value={ap} onChange={(e) => setAp(e.target.value)} />%</label><label className="chk" style={{ margin: 0 }}>B até <input style={{ width: 70 }} value={bp} onChange={(e) => setBp(e.target.value)} />%</label></div>
    {err && <div className="err">{err}</div>}
    {abc && <><div className="grid kpis" style={{ marginBottom: 10 }}>{abc.summary.map((s: any) => <div key={s.class} className="card kpi"><div className="v">{s.class}</div><div className="l">{s.products} produtos · {s.share}% do total</div></div>)}</div>
      <table><thead><tr><th>Classe</th><th>SKU</th><th>Produto</th><th className="num">Valor/Qtd</th><th className="num">%</th><th className="num">% acum.</th></tr></thead><tbody>
        {abc.items.slice(0, 100).map((r: any) => <tr key={r.id}><td><span className={`pill ${r.class === 'A' ? 'green' : r.class === 'B' ? 'yellow' : 'gray'}`}>{r.class}</span></td><td>{r.sku}</td><td>{r.description}</td><td className="num">{n(r.metric)}</td><td className="num">{r.share}</td><td className="num">{r.cum_share}</td></tr>)}</tbody></table></>}</>;
}
