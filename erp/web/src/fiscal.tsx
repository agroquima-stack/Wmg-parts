import { useEffect, useState } from 'react';
import { api, ApiError, brl, get, getToken, qs } from './api';
import { useAuth } from './auth';
import { Modal } from './DataPage';

const date = (v: any) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '—');
const num = (v: any) => Number(v ?? 0);
const COLOR: Record<string, string> = { autorizada: 'green', rascunho: 'yellow', rejeitada: 'red', cancelada: 'gray', pago: 'green', a_pagar: 'yellow', previsto: 'gray', estimado: 'gray', 'sem faturamento': 'gray' };
const Tag = ({ s }: { s: string }) => <span className={`pill ${COLOR[s] ?? 'gray'}`}>{s.replace('_', ' ')}</span>;
const Err = ({ e }: { e: string }) => (e ? <div className="err">{e}</div> : null);
const KIND: Record<string, string> = { venda: 'Venda', devolucao_venda: 'Devolução de venda' };
const field = (l: string, v: any, set: (s: string) => void, p: Record<string, any> = {}) => <div><label>{l}</label><input value={v ?? ''} onChange={(e) => set(e.target.value)} {...p} /></div>;

async function download(path: string, name: string) {
  const r = await fetch('/api' + path, { headers: { authorization: `Bearer ${getToken()}` } }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Falha no download');
  const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
const SimBanner = () => <div className="alert red" style={{ fontWeight: 700 }}>SIMULADO — SEM VALOR FISCAL. Documento gerado pelo provedor de testes; não foi autorizado pela SEFAZ.</div>;

// ---------------------------------------------------------------- Notas fiscais
export function Invoices() {
  const { can } = useAuth(); const [f, setF] = useState({ status: '', model: '', q: '' }); const [d, setD] = useState<any>({ items: [] }); const [open, setOpen] = useState<string | null>(null);
  const load = () => get('/fiscal/documents' + qs({ ...f, pageSize: 100 })).then(setD); useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [f]);
  return <><h1>Notas fiscais</h1><p className="sub">NF-e (55) e NFC-e (65). Venda para CNPJ ou fora do balcão = NF-e. A emissão depende do provedor configurado; hoje é possível registrar notas emitidas fora do sistema.</p>
    <div className="toolbar"><input placeholder="Nº da nota, chave, pedido ou cliente…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /><select style={{ width: 160 }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Todos os status</option>{['rascunho', 'autorizada', 'rejeitada', 'cancelada'].map((s) => <option key={s}>{s}</option>)}</select>
      <select style={{ width: 120 }} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}><option value="">Modelo</option><option value="55">NF-e 55</option><option value="65">NFC-e 65</option></select></div>
    <table><thead><tr><th>Nº</th><th>Modelo</th><th>Tipo</th><th>Pedido</th><th>Cliente</th><th className="num">Valor</th><th>Pendências</th><th>Status</th></tr></thead><tbody>
      {d.items.map((x: any) => <tr key={x.id} className="click" onClick={() => setOpen(x.id)}><td>{x.number ?? '—'}{x.series ? `/${x.series}` : ''} {x.simulated && <span className="pill red">SIMULADO</span>}</td><td>{x.model === '55' ? 'NF-e' : 'NFC-e'}</td><td>{KIND[x.kind]}</td><td>{x.sale_number}</td><td>{x.customer_name ?? <span className="muted">Consumidor</span>}</td><td className="num">{brl(x.total)}</td>
        <td>{x.errors > 0 ? <span className="pill red">{x.errors} erro(s)</span> : x.status === 'rascunho' ? <span className="pill green">pronta</span> : ''} {x.warnings > 0 && x.status === 'rascunho' && <span className="pill yellow">{x.warnings} alerta(s)</span>}</td><td><Tag s={x.status} /></td></tr>)}
      {!d.items.length && <tr><td colSpan={8} className="muted">Nenhum documento. Use “Vendas sem nota” para gerar.</td></tr>}</tbody></table>
    {open && <InvoiceDetail id={open} can={can} onClose={() => { setOpen(null); load(); }} />}</>;
}

function InvoiceDetail({ id, can, onClose }: { id: string; can: (p: string) => boolean; onClose(): void }) {
  const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState(''); const [modal, setModal] = useState<string | null>(null); const [v, setV] = useState<any>({});
  const load = () => get('/fiscal/documents/' + id).then(setD); useEffect(() => { load(); }, [id]); if (!d) return null;
  const run = async (fn: () => Promise<any>, ok?: string) => { setErr(''); setMsg(''); try { const r = await fn(); if (ok) setMsg(ok); await load(); return r; } catch (e) { const x = e as any; setErr(x.message + (x.validation ? ': ' + x.validation.errors.map((i: any) => i.message).join(' | ') : '')); } };
  const p = d.payload; const errors = d.validation.errors, warnings = d.validation.warnings; const editable = ['rascunho', 'rejeitada'].includes(d.status);
  const set = (k: string) => (s: string) => setV({ ...v, [k]: s });
  return <Modal onClose={onClose}><h2 style={{ marginTop: 0 }}>{KIND[d.kind]} — {d.model === '55' ? 'NF-e' : 'NFC-e'} {d.number ? `nº ${d.number}` : '(rascunho)'} <Tag s={d.status} /></h2>
    {d.simulated && <SimBanner />}<p className="muted">Pedido {d.sale_number} · ambiente {d.environment} · provedor {d.provider} · {p.destinatario ? `${p.destinatario.nome} (${p.destinatario.documento ?? 'sem documento'})` : 'consumidor não identificado'}{d.access_key && <><br />Chave: <code>{d.access_key}</code></>}{d.protocol && <> · protocolo {d.protocol}</>}</p>
    {errors.length > 0 && <div className="alert red"><b>Erros que impedem a emissão</b>{errors.map((e: any, i: number) => <div key={i}>• {e.message}</div>)}</div>}
    {warnings.length > 0 && <div className="alert yellow"><b>Alertas para conferência com o contador</b>{warnings.map((e: any, i: number) => <div key={i}>• {e.message}</div>)}</div>}
    <table><thead><tr><th>#</th><th>Produto</th><th>NCM</th><th>CFOP</th><th>CSOSN</th><th className="num">Qtd</th><th className="num">Unit.</th><th className="num">Desc.</th><th className="num">Total</th></tr></thead><tbody>
      {p.itens.map((i: any) => <tr key={i.n}><td>{i.n}</td><td>{i.sku} {i.descricao}</td><td>{i.ncm ?? <span className="pill red">—</span>}</td><td>{i.cfop}</td><td>{i.csosn}</td><td className="num">{i.quantidade}</td><td className="num">{brl(i.valor_unitario)}</td><td className="num">{brl(i.valor_desconto)}</td><td className="num">{brl(i.valor_produtos - i.valor_desconto)}</td></tr>)}</tbody></table>
    <p style={{ textAlign: 'right' }}>Total da nota <b style={{ fontSize: 20 }}>{brl(p.totais.valor_nf)}</b></p><p className="muted">idDest {p.ide.idDest} · indFinal {p.ide.indFinal} · indPres {p.ide.indPres} · IE dest. {p.destinatario?.indIEDest ?? '—'} · pagamentos {p.pagamentos.map((x: any) => `${x.metodo} ${brl(x.valor)}`).join(', ')}</p><p className="muted">{p.informacoes_complementares}</p>
    {d.events.length > 0 && <><b>Eventos</b>{d.events.map((e: any) => <div key={e.id} className="muted">{new Date(e.created_at).toLocaleString('pt-BR')} · {e.type}{e.seq > 1 || e.type === 'cce' ? ` #${e.seq}` : ''} · {e.text} {e.protocol && `· prot. ${e.protocol}`}</div>)}</>}
    {msg && <div className="alert green">{msg}</div>}<Err e={err} />
    <div className="right">{d.has_xml && <button onClick={() => run(() => download(`/fiscal/documents/${id}/xml`, `NFe-${d.access_key ?? id}.xml`))}>Baixar XML</button>}
      {editable && can('fiscal:edit') && <button onClick={() => run(() => api('POST', `/fiscal/documents/${id}/revalidate`), 'Documento revalidado com os cadastros atuais.')}>Revalidar</button>}
      {editable && can('fiscal:delete') && d.status === 'rascunho' && <button className="danger" onClick={() => confirm('Excluir o rascunho?') && run(() => api('DELETE', `/fiscal/documents/${id}`)).then(onClose)}>Excluir rascunho</button>}
      {editable && can('fiscal:create') && !errors.length && <><button onClick={() => setModal('register')}>Registrar nota emitida</button><button className="primary" onClick={() => run(() => api('POST', `/fiscal/documents/${id}/emit`), 'Documento emitido.')}>Emitir</button></>}
      {d.status === 'autorizada' && d.kind === 'venda' && d.model === '55' && can('fiscal:edit') && <button onClick={() => setModal('cce')}>Carta de correção</button>}
      {d.status === 'autorizada' && d.kind === 'venda' && can('fiscal:create') && <button onClick={() => setModal('return')}>Nota de devolução</button>}
      {d.status === 'autorizada' && can('fiscal:approve') && <button className="danger" onClick={() => setModal('cancel')}>Cancelar nota</button>}<button onClick={onClose}>Fechar</button></div>
    {modal === 'register' && <Modal onClose={() => setModal(null)}><h3 style={{ marginTop: 0 }}>Registrar nota emitida fora do sistema</h3><p className="muted">A chave é validada (dígito verificador, CNPJ, modelo e UF). Anexar o XML é opcional, mas recomendado: é conferido contra a chave e o valor.</p>
      <div className="form"><div className="full">{field('Chave de acesso (44 dígitos) *', v.key, set('key'))}</div>{field('Protocolo de autorização *', v.protocol, set('protocol'))}{field('Data de emissão', v.issue, set('issue'), { type: 'date' })}<div className="full"><label>XML (opcional)</label><input type="file" accept=".xml" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setV({ ...v, xml: await f.text() }); }} /></div></div>
      <Err e={err} /><div className="right"><button onClick={() => setModal(null)}>Cancelar</button><button className="primary" disabled={!v.key || !v.protocol} onClick={async () => { const r = await run(() => api('POST', `/fiscal/documents/${id}/register-manual`, { access_key: v.key.replace(/\D/g, ''), protocol: v.protocol, issue_date: v.issue || undefined, xml: v.xml }), 'Nota registrada.'); if (r) setModal(null); }}>Registrar</button></div></Modal>}
    {modal === 'cancel' && <Modal onClose={() => setModal(null)}><h3 style={{ marginTop: 0 }}>Cancelar nota</h3><p className="muted">Prazo de cancelamento definido nas configurações. Justificativa com no mínimo 15 caracteres.{!d.simulated && ' Se o cancelamento foi feito no portal/provedor, informe o protocolo do evento.'}</p>
      <div className="form"><div className="full">{field('Justificativa *', v.reason, set('reason'))}</div>{!d.simulated && field('Protocolo do cancelamento', v.cprotocol, set('cprotocol'))}</div><Err e={err} /><div className="right"><button onClick={() => setModal(null)}>Voltar</button><button className="danger" disabled={(v.reason ?? '').length < 15} onClick={async () => { const r = await run(() => api('POST', `/fiscal/documents/${id}/cancel`, { reason: v.reason, protocol: v.cprotocol || null }), 'Nota cancelada.'); if (r) setModal(null); }}>Cancelar nota</button></div></Modal>}
    {modal === 'cce' && <Modal onClose={() => setModal(null)}><h3 style={{ marginTop: 0 }}>Carta de correção (CC-e)</h3><p className="muted">Não pode alterar valores, impostos, quantidades, dados que mudem o destinatário nem datas.</p><div className="form"><div className="full">{field('Texto da correção *', v.cce, set('cce'))}</div>{!d.simulated && field('Protocolo', v.ccp, set('ccp'))}</div><Err e={err} /><div className="right"><button onClick={() => setModal(null)}>Voltar</button><button className="primary" disabled={(v.cce ?? '').length < 15} onClick={async () => { const r = await run(() => api('POST', `/fiscal/documents/${id}/correction`, { text: v.cce, protocol: v.ccp || null }), 'CC-e registrada.'); if (r) setModal(null); }}>Registrar</button></div></Modal>}
    {modal === 'return' && <ReturnModal d={d} onClose={() => setModal(null)} />}</Modal>;
}
function ReturnModal({ d, onClose }: { d: any; onClose(): void }) {
  const [q, setQ] = useState<Record<string, string>>({}); const [reason, setReason] = useState(''); const [err, setErr] = useState(''); const [done, setDone] = useState('');
  const go = async () => { setErr(''); try { await api('POST', '/fiscal/documents/return', { document_id: d.id, reason, items: Object.entries(q).filter(([, v]) => num(v) > 0).map(([product_id, v]) => ({ product_id, qty: num(v) })) }); setDone('Rascunho da nota de devolução criado: finalize em Notas fiscais. O estoque e o financeiro da devolução ainda são tratados manualmente.'); } catch (e) { setErr((e as ApiError).message); } };
  return <Modal onClose={onClose}><h3 style={{ marginTop: 0 }}>Nota de devolução de venda</h3><table><tbody>{d.payload.itens.map((i: any) => <tr key={i.product_id}><td>{i.sku} {i.descricao}</td><td className="num">vendido {i.quantidade}</td><td style={{ width: 100 }}><input type="number" min="0" max={i.quantidade} placeholder="devolver" value={q[i.product_id] ?? ''} onChange={(e) => setQ({ ...q, [i.product_id]: e.target.value })} /></td></tr>)}</tbody></table>
    <div className="form" style={{ marginTop: 8 }}>{field('Motivo *', reason, setReason)}</div>{done && <div className="alert green">{done}</div>}<Err e={err} /><div className="right"><button onClick={onClose}>Fechar</button><button className="primary" disabled={reason.length < 5 || !Object.values(q).some((v) => num(v) > 0)} onClick={go}>Criar rascunho</button></div></Modal>;
}

// ---------------------------------------------------------------- Vendas sem nota
export function PendingSales() {
  const { can } = useAuth(); const [l, setL] = useState<any[]>([]); const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const load = () => get('/fiscal/pending-sales').then((r) => setL(r.items)); useEffect(() => { load(); }, []);
  return <><h1>Vendas sem nota fiscal</h1><p className="sub">Vendas concluídas que ainda não foram faturadas. Gerar o rascunho aplica as regras (modelo, CFOP, CSOSN) e valida o cadastro.</p>{msg && <div className="alert green">{msg}</div>}<Err e={err} />
    <div className="toolbar"><span style={{ flex: 1 }} />{can('fiscal:create') && <button className="primary" disabled={!l.length} onClick={() => api('POST', '/fiscal/documents/prepare-pending').then((r) => { setMsg(`${r.created} rascunho(s) gerado(s): ${r.ready} prontos, ${r.with_errors} com pendências de cadastro.`); load(); })}>Gerar rascunhos de todas</button>}</div>
    <table><thead><tr><th>Pedido</th><th>Data</th><th>Cliente</th><th>Tipo</th><th className="num">Total</th><th /></tr></thead><tbody>
      {l.map((s) => <tr key={s.id}><td>{s.number}</td><td>{date(s.confirmed_at)}</td><td>{s.customer_name ?? <span className="muted">Consumidor final</span>} {s.customer_type && <span className="pill gray">{s.customer_type === 'PJ' ? 'CNPJ → NF-e' : 'CPF'}</span>}</td><td>{s.type}</td><td className="num">{brl(s.total)}</td>
        <td>{can('fiscal:create') && <button onClick={() => { setErr(''); api('POST', '/fiscal/documents/from-sale', { sale_id: s.id }).then(() => { setMsg(`Rascunho do pedido ${s.number} gerado.`); load(); }).catch((e) => setErr(e.message)); }}>gerar rascunho</button>}</td></tr>)}
      {!l.length && <tr><td colSpan={6} className="muted">Todas as vendas concluídas já têm nota.</td></tr>}</tbody></table></>;
}

// ---------------------------------------------------------------- Impostos (DAS)
export function Taxes() {
  const { can } = useAuth(); const [year, setYear] = useState(new Date().getFullYear()); const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [edit, setEdit] = useState<any>(null);
  const load = () => get('/taxes/panel' + qs({ year })).then(setD).catch((e) => setErr(e.message)); useEffect(() => { load(); }, [year]); if (!d) return <Err e={err} />;
  const run = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); await load(); } catch (e) { setErr((e as ApiError).message); } };
  return <><h1>Impostos — Simples Nacional (DAS)</h1><div className="alert yellow">{d.disclaimer}</div><Err e={err} />
    <div className="toolbar"><button onClick={() => setYear(year - 1)}>‹</button><b>{year}</b><button onClick={() => setYear(year + 1)}>›</button><span style={{ flex: 1 }} /><span className="muted">Base: {d.settings.das_mode === 'anexo_i' ? 'Anexo I (comércio)' : 'alíquota efetiva informada'}</span></div>
    <div className="grid kpis" style={{ marginBottom: 12 }}><div className="card kpi"><div className="v">{brl(d.totals.estimated)}</div><div className="l">DAS estimado no ano</div></div><div className="card kpi"><div className="v">{brl(d.totals.official)}</div><div className="l">Valor oficial informado</div></div><div className="card kpi"><div className="v">{brl(d.totals.paid)}</div><div className="l">Pago</div></div></div>
    <table><thead><tr><th>Competência</th><th className="num">Faturamento</th><th className="num">Alíquota</th><th className="num">Estimado</th><th className="num">Valor da guia</th><th>Vencimento</th><th>Guia</th><th>Status</th><th /></tr></thead><tbody>
      {d.months.map((m: any) => <tr key={m.competence}><td>{m.competence.slice(5, 7)}/{m.competence.slice(0, 4)}</td><td className="num">{brl(m.revenue)}</td><td className="num" title={m.method}>{m.effective_rate != null ? `${m.effective_rate}%` : 'acima do teto'}</td><td className="num">{brl(m.estimated)}</td><td className="num">{m.obligation?.amount != null ? <b>{brl(m.obligation.amount)}</b> : '—'}</td><td>{date(m.obligation?.due_date ?? m.due_date)}</td><td>{m.obligation?.guide_ref ?? ''}</td><td><Tag s={m.status} /></td>
        <td style={{ whiteSpace: 'nowrap' }}>{m.revenue > 0 && !m.obligation && can('fiscal:create') && <button onClick={() => run(() => api('POST', '/taxes/obligations/generate', { competence: m.competence.slice(0, 7) }))}>gerar</button>}
          {m.obligation && can('fiscal:edit') && <button onClick={() => setEdit({ ...m.obligation, amount: m.obligation.amount ?? '' })}>guia / comprovante</button>}
          {m.obligation && !m.obligation.payable_id && m.obligation.status !== 'pago' && can('fiscal:edit') && <button className="primary" onClick={() => run(() => api('POST', `/taxes/obligations/${m.obligation.id}/payable`, { use_estimate: m.obligation.amount == null && confirm('Sem valor oficial da guia: gerar o título com a ESTIMATIVA?') }))}>gerar a pagar</button>}</td></tr>)}</tbody></table>
    <p className="muted">Vencimento: dia 20 do mês seguinte, ajustado para dia útil (feriados não são considerados). A guia é paga pelo contas a pagar e o status aqui acompanha o pagamento.</p>
    {edit && <Modal onClose={() => setEdit(null)}><h3 style={{ marginTop: 0 }}>Guia do DAS — {edit.competence?.slice(5, 7)}/{String(edit.competence).slice(0, 4)}</h3><div className="form">{field('Valor oficial da guia (PGDAS-D)', edit.amount, (s) => setEdit({ ...edit, amount: s }), { type: 'number', step: '0.01' })}{field('Vencimento', String(edit.due_date).slice(0, 10), (s) => setEdit({ ...edit, due_date: s }), { type: 'date' })}{field('Nº da guia / referência', edit.guide_ref, (s) => setEdit({ ...edit, guide_ref: s }))}{field('Comprovante / observação', edit.receipt_note, (s) => setEdit({ ...edit, receipt_note: s }))}</div>
      <div className="right"><button onClick={() => setEdit(null)}>Cancelar</button><button className="primary" onClick={() => run(() => api('PATCH', `/taxes/obligations/${edit.id}`, { amount: edit.amount === '' ? undefined : num(edit.amount), due_date: String(edit.due_date).slice(0, 10), guide_ref: edit.guide_ref || null, receipt_note: edit.receipt_note || null })).then(() => setEdit(null))}>Salvar</button></div></Modal>}</>;
}

// ---------------------------------------------------------------- XMLs
export function Xmls() {
  const [origin, setOrigin] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [l, setL] = useState<any[]>([]); const [err, setErr] = useState('');
  useEffect(() => { get('/fiscal/xmls' + qs({ origin, from, to })).then((r) => setL(r.items)); }, [origin, from, to]);
  return <><h1>XMLs fiscais</h1><p className="sub">Repositório dos XMLs emitidos e recebidos (guarde por, no mínimo, 5 anos). Entradas vêm da importação de NF-e de compra; saídas, das notas emitidas/registradas com XML.</p><Err e={err} />
    <div className="toolbar"><select style={{ width: 160 }} value={origin} onChange={(e) => setOrigin(e.target.value)}><option value="">Emitidas e recebidas</option><option value="emitida">Emitidas</option><option value="recebida">Recebidas</option></select><input type="date" style={{ maxWidth: 160 }} value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" style={{ maxWidth: 160 }} value={to} onChange={(e) => setTo(e.target.value)} /><span className="muted">{l.length} arquivo(s)</span></div>
    <table><thead><tr><th>Data</th><th>Origem</th><th>Nº</th><th>Parte</th><th className="num">Valor</th><th>Status</th><th /></tr></thead><tbody>{l.map((x) => <tr key={x.origin + x.id}><td>{date(x.at)}</td><td>{x.origin === 'emitida' ? 'Saída' : 'Entrada'} {x.simulated && <span className="pill red">SIMULADO</span>}</td><td>{x.number}</td><td>{x.party}</td><td className="num">{brl(x.total)}</td><td><Tag s={x.status === 'concluido' ? 'autorizada' : x.status} /></td>
      <td><button onClick={() => download(x.origin === 'emitida' ? `/fiscal/documents/${x.id}/xml` : `/fiscal/xmls/received/${x.id}`, `NFe-${x.access_key ?? x.id}.xml`).catch((e) => setErr(e.message))}>baixar</button></td></tr>)}</tbody></table></>;
}

// ---------------------------------------------------------------- Configurações fiscais
export function FiscalSettings() {
  const { can } = useAuth(); const [d, setD] = useState<any>(null); const [msg, setMsg] = useState('');
  useEffect(() => { get('/fiscal/settings').then(setD); }, []); if (!d) return null; const s = d.settings; const edit = can('fiscal:approve'); const set = (k: string, v: any) => setD({ ...d, settings: { ...s, [k]: v } });
  return <><h1>Configurações fiscais</h1><p className="sub">Regime: Simples Nacional. Os dados do emitente (CNPJ, IE, endereço, CRT) ficam em Administração → Filiais.</p>
    <div className="card"><div className="form"><div><label>Provedor de emissão</label><select disabled={!edit} value={s.provider} onChange={(e) => set('provider', e.target.value)}>{d.providers.map((p: any) => <option key={p.name} value={p.name}>{p.label}</option>)}</select></div>
      <div><label>Ambiente</label><select disabled={!edit} value={s.environment} onChange={(e) => set('environment', e.target.value)}><option value="homologacao">Homologação (testes)</option><option value="producao">Produção</option></select></div>
      <div><label>Série NF-e</label><input type="number" disabled={!edit} value={s.series_nfe} onChange={(e) => set('series_nfe', e.target.value)} /></div><div><label>Série NFC-e</label><input type="number" disabled={!edit} value={s.series_nfce} onChange={(e) => set('series_nfce', e.target.value)} /></div>
      <div><label>Prazo para cancelar nota (horas)</label><input type="number" disabled={!edit} value={s.cancel_window_hours} onChange={(e) => set('cancel_window_hours', e.target.value)} /></div>
      <label className="chk"><input type="checkbox" disabled={!edit} checked={s.use_nfce_for_counter} onChange={(e) => set('use_nfce_for_counter', e.target.checked)} />Usar NFC-e em venda presencial de balcão para CPF</label></div>
      <h3>DAS (estimativa)</h3><div className="form"><div><label>Base da estimativa</label><select disabled={!edit} value={s.das_mode} onChange={(e) => set('das_mode', e.target.value)}><option value="manual">Alíquota efetiva informada</option><option value="anexo_i">Tabela do Anexo I (comércio) pelo RBT12</option></select></div>
        <div><label>Alíquota efetiva (%) — modo informado</label><input type="number" step="0.01" disabled={!edit} placeholder="vazio = usa a de Precificação" value={s.das_effective_pct ?? ''} onChange={(e) => set('das_effective_pct', e.target.value === '' ? null : e.target.value)} /></div>
        <div><label>RBT12 informado pelo contador (R$)</label><input type="number" step="0.01" disabled={!edit} placeholder="vazio = calculado pelo histórico" value={s.rbt12_override ?? ''} onChange={(e) => set('rbt12_override', e.target.value === '' ? null : e.target.value)} /></div>
        <label className="chk"><input type="checkbox" disabled={!edit} checked={s.ibs_cbs_enabled} onChange={(e) => set('ibs_cbs_enabled', e.target.checked)} />Incluir campos IBS/CBS no documento (reforma tributária — sem cálculo automático)</label></div>
      <div className="alert yellow">O provedor <b>simulado</b> só existe para testes e nunca é aceito em produção. Para emitir de verdade será preciso contratar um provedor e instalar o adaptador; até lá, use “Registrar nota emitida”.</div>
      {edit && <div className="right"><span className="muted">{msg}</span><button className="primary" onClick={() => api('PUT', '/fiscal/settings', { provider: s.provider, environment: s.environment, series_nfe: num(s.series_nfe), series_nfce: num(s.series_nfce), use_nfce_for_counter: s.use_nfce_for_counter, cancel_window_hours: num(s.cancel_window_hours), das_mode: s.das_mode, das_effective_pct: s.das_effective_pct == null ? null : num(s.das_effective_pct), rbt12_override: s.rbt12_override == null ? null : num(s.rbt12_override), ibs_cbs_enabled: s.ibs_cbs_enabled }).then(() => setMsg('Salvo.')).catch((e) => setMsg(e.message))}>Salvar</button></div>}</div></>;
}
