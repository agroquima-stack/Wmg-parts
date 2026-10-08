import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, brl, get } from './api';
import { useAuth } from './auth';
import { LineChart, SERIES } from './charts';
import { ProductPick } from './commercial';

const Err = ({ e }: { e: string }) => (e ? <div className="err">{e}</div> : null);
const date = (v: any) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '—');
const SEV: Record<string, { label: string; cls: string; icon: string }> = { critico: { label: 'Crítico', cls: 'red', icon: '▲' }, atencao: { label: 'Atenção', cls: 'yellow', icon: '●' }, info: { label: 'Informativo', cls: 'gray', icon: 'ℹ' } };
const ST: Record<string, string> = { aberto: 'Aberto', reconhecido: 'Reconhecido', adiado: 'Adiado', resolvido: 'Resolvido' };

/** Sino da barra superior: quantidade de alertas em aberto (atualiza a cada 2 minutos). */
export function AlertBell() {
  const { can } = useAuth(); const [s, setS] = useState<any>(null);
  useEffect(() => { if (!can('alerts:view')) return; const load = () => get('/alerts/summary').then(setS).catch(() => {}); load(); const t = setInterval(load, 120000); return () => clearInterval(t); }, []); // eslint-disable-line
  if (!can('alerts:view') || !s) return null;
  return <Link to="/alertas" title="Central de alertas" style={{ textDecoration: 'none' }}>🔔 {s.total > 0 ? <span className={`pill ${s.critico ? 'red' : 'yellow'}`}>{s.total}{s.critico ? ` · ${s.critico} crítico(s)` : ''}</span> : <span className="muted">sem alertas</span>}</Link>;
}

// ---------------------------------------------------------------- Central de alertas
export function Alerts() {
  const { can } = useAuth(); const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [f, setF] = useState({ status: 'abertos', severity: '' }); const [tab, setTab] = useState<'alertas' | 'regras'>('alertas'); const [busy, setBusy] = useState(false);
  const load = () => get(`/alerts?status=${f.status}${f.severity ? `&severity=${f.severity}` : ''}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [f]); // eslint-disable-line
  const run = async (fn: () => Promise<any>) => { setErr(''); setBusy(true); try { await fn(); await load(); } catch (e: any) { setErr(e.message); } setBusy(false); };
  if (!d) return <Err e={err} />; const s = d.summary;
  return <><h1>Central de alertas</h1><p className="sub">Regras objetivas sobre os dados do sistema: o alerta abre quando o problema aparece e fecha sozinho quando ele deixa de existir. Os limites de cada regra são seus, na aba Regras.</p>
    <div className="toolbar"><button className={tab === 'alertas' ? 'primary' : ''} onClick={() => setTab('alertas')}>Alertas</button><button className={tab === 'regras' ? 'primary' : ''} onClick={() => setTab('regras')}>Regras e limites</button>
      <span style={{ flex: 1 }} /><button disabled={busy} onClick={() => run(() => api('POST', '/alerts/run'))}>{busy ? 'Verificando…' : 'Verificar agora'}</button></div>
    <Err e={err} />
    {tab === 'regras' ? <Rules /> : <>
      <div className="toolbar"><span className="pill red">▲ {s.critico} crítico(s)</span><span className="pill yellow">● {s.atencao} atenção</span><span className="pill gray">ℹ {s.info} informativo(s)</span><span style={{ flex: 1 }} />
        <select style={{ width: 150 }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="abertos">Em aberto</option><option value="adiado">Adiados</option><option value="resolvido">Resolvidos</option><option value="todos">Todos</option></select>
        <select style={{ width: 150 }} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}><option value="">Toda gravidade</option><option value="critico">Crítico</option><option value="atencao">Atenção</option><option value="info">Informativo</option></select></div>
      {!d.items.length ? <div className="card muted">Nenhum alerta neste filtro. {f.status === 'abertos' && '✔ Tudo dentro dos limites configurados.'}</div> :
        <table><thead><tr><th>Gravidade</th><th>Alerta</th><th>Situação</th><th>Desde</th><th /></tr></thead><tbody>{d.items.map((a: any) => { const sv = SEV[a.severity]; return <tr key={a.id}>
          <td><span className={`pill ${sv.cls}`}>{sv.icon} {sv.label}</span></td>
          <td><b>{a.title}</b>{a.detail && <div className="muted">{a.detail}</div>}{a.note && <div className="muted">Nota: {a.note}{a.handled_by_name ? ` — ${a.handled_by_name}` : ''}</div>}</td>
          <td>{ST[a.status]}{a.status === 'adiado' && <div className="muted">até {date(a.snoozed_until)}</div>}{a.status === 'resolvido' && <div className="muted">{date(a.resolved_at)}</div>}</td>
          <td>{date(a.first_seen)}</td>
          <td style={{ whiteSpace: 'nowrap' }}>{a.link && <Link to={a.link}>abrir →</Link>}{' '}{can('alerts:edit') && a.status !== 'resolvido' && <>
            {a.status === 'aberto' && <button onClick={() => { const note = prompt('Nota (opcional):') ?? undefined; run(() => api('POST', `/alerts/${a.id}/ack`, { note })); }}>Reconhecer</button>}{' '}
            {a.status !== 'adiado' ? <button onClick={() => { const days = Number(prompt('Adiar por quantos dias?', '7')); if (days > 0) run(() => api('POST', `/alerts/${a.id}/snooze`, { days })); }}>Adiar</button> : <button onClick={() => run(() => api('POST', `/alerts/${a.id}/reopen`))}>Reabrir</button>}</>}</td></tr>; })}</tbody></table>}
    </>}</>;
}

function Rules() {
  const { can } = useAuth(); const [rules, setRules] = useState<any[]>([]); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = () => get('/alerts/rules').then(setRules).catch((e) => setErr(e.message)); useEffect(() => { load(); }, []);
  const save = async (r: any) => { setErr(''); setMsg(''); try { await api('PUT', `/alerts/rules/${r.key}`, { enabled: r.enabled, params: r.values }); setMsg(`Regra "${r.label}" salva.`); await load(); } catch (e: any) { setErr(e.message); } };
  const edit = (key: string, patch: any) => setRules(rules.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return <><Err e={err} />{msg && <div className="ok">{msg}</div>}<table><thead><tr><th>Regra</th><th>Área</th><th>Limites</th><th>Ativa</th><th /></tr></thead><tbody>{rules.map((r) => <tr key={r.key}>
    <td><b>{r.label}</b><div className="muted">{r.description}</div></td><td>{r.area}</td>
    <td>{Object.entries(r.params).length ? Object.entries(r.params).map(([k, d]: any) => <label key={k} style={{ display: 'block', marginBottom: 4 }}><span className="muted">{d.label}: </span><input type="number" style={{ width: 110 }} disabled={!can('alerts:edit')} value={r.values[k]} onChange={(e) => edit(r.key, { values: { ...r.values, [k]: Number(e.target.value) } })} /></label>) : <span className="muted">sem parâmetros</span>}</td>
    <td><input type="checkbox" disabled={!can('alerts:edit')} checked={r.enabled} onChange={(e) => edit(r.key, { enabled: e.target.checked })} /></td>
    <td>{can('alerts:edit') && <button onClick={() => save(r)}>Salvar</button>}</td></tr>)}</tbody></table></>;
}

// ---------------------------------------------------------------- Pergunte à Empresa
function AnswerCard({ a }: { a: any }) {
  return <div className="card" style={{ marginBottom: 12 }}><div style={{ fontWeight: 600, marginBottom: 6 }}>{a.q}</div><div style={{ marginBottom: 8 }}>{a.answer}</div>
    {a.table && <table><thead><tr>{a.table.columns.map((c: string) => <th key={c}>{c}</th>)}</tr></thead><tbody>{a.table.rows.map((r: any[], i: number) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>}
    <div className="muted" style={{ marginTop: 8 }}>{a.source ? <>Origem: {a.source}. </> : null}{a.note}{a.link && <> <Link to={a.link}>ver detalhe →</Link></>}</div></div>;
}
export function AskCompany() {
  const [q, setQ] = useState(''); const [hist, setHist] = useState<any[]>([]); const [ex, setEx] = useState<string[]>([]); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { get('/ai/examples').then(setEx).catch(() => {}); }, []);
  const ask = async (text: string) => { if (text.trim().length < 3) return; setErr(''); setBusy(true); try { const r = await api('POST', '/ai/ask', { question: text }); setHist([{ ...r, q: text }, ...hist]); setQ(''); } catch (e: any) { setErr(e.message); } setBusy(false); };
  return <><h1>Pergunte à Empresa</h1><p className="sub">Faça perguntas em português. As respostas vêm de consultas aos dados do sistema (nada é inventado e não há IA externa): cada resposta mostra a origem do número. Se eu não entender, digo que não entendi.</p>
    <div className="toolbar"><input autoFocus style={{ maxWidth: 640 }} placeholder="Ex.: Quanto vendemos este mês?" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask(q)} /><button className="primary" disabled={busy} onClick={() => ask(q)}>Perguntar</button></div>
    <Err e={err} />
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>{ex.map((x) => <button key={x} onClick={() => ask(x)}>{x}</button>)}</div>
    {hist.map((a, i) => <AnswerCard key={i} a={a} />)}</>;
}

// ---------------------------------------------------------------- Recomendações e previsão
const KIND: Record<string, string> = { comprar: 'Comprar', liquidar: 'Girar estoque', preco: 'Rever preço', cobrar: 'Cobrar' };
export function Recommendations() {
  const [r, setR] = useState<any[] | null>(null); const [cov, setCov] = useState<any[]>([]); const [err, setErr] = useState('');
  useEffect(() => { get('/ai/recommendations').then(setR).catch((e) => setErr(e.message)); get('/ai/coverage').then(setCov).catch(() => {}); }, []);
  if (!r) return <Err e={err} />;
  return <><h1>Recomendações e previsão</h1><p className="sub">Ações sugeridas a partir das regras do sistema, sempre com a base de cada uma. São sugestões: quem decide é você.</p>
    <h3>O que fazer agora</h3>{!r.length ? <div className="card muted">Nenhuma ação sugerida no momento.</div> : <table><thead><tr><th>Ação</th><th>Detalhe</th><th style={{ textAlign: 'right' }}>Valor envolvido</th><th>Base</th><th /></tr></thead><tbody>{r.map((x, i) => <tr key={i}><td><span className="pill gray">{KIND[x.kind] ?? x.kind}</span> <b>{x.title}</b></td><td>{x.detail}</td><td style={{ textAlign: 'right' }}>{x.impact != null ? brl(x.impact) : '—'}</td><td className="muted">{x.basis}</td><td><Link to={x.link}>abrir →</Link></td></tr>)}</tbody></table>}
    <h3 style={{ marginTop: 22 }}>Cobertura de estoque (itens com menor cobertura)</h3>
    {!cov.length ? <div className="card muted">Sem vendas recentes suficientes para estimar cobertura.</div> : <table><thead><tr><th>Produto</th><th>Curva</th><th style={{ textAlign: 'right' }}>Disponível</th><th style={{ textAlign: 'right' }}>Venda/dia</th><th style={{ textAlign: 'right' }}>Cobertura (dias)</th><th style={{ textAlign: 'right' }}>Prazo forn.</th><th style={{ textAlign: 'right' }}>Sugerido</th><th>Confiança</th></tr></thead><tbody>{cov.map((x) => <tr key={x.product_id}><td>{x.sku} — {x.description}</td><td>{x.abc}</td><td style={{ textAlign: 'right' }}>{x.available}</td><td style={{ textAlign: 'right' }}>{x.avg_daily}</td><td style={{ textAlign: 'right' }}>{x.coverage_days}</td><td style={{ textAlign: 'right' }}>{x.lead_time_days}</td><td style={{ textAlign: 'right' }}>{x.suggested_qty}</td><td>{x.confidence}</td></tr>)}</tbody></table>}
    <Forecast /></>;
}
function Forecast() {
  const [p, setP] = useState<any>(null); const [f, setF] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { if (!p) return setF(null); get(`/ai/forecast?product_id=${p.id}&weeks=8`).then(setF).catch((e) => setErr(e.message)); }, [p]);
  const labels = f ? [...f.history.map((h: any) => h.week), ...f.forecast.map((h: any) => h.week)] : [];
  return <><h3 style={{ marginTop: 22 }}>Previsão de demanda por produto</h3><div className="toolbar"><ProductPick value={p} onChange={setP} /></div><Err e={err} />
    {f && <div className="card"><div style={{ marginBottom: 8 }}><b>{f.product.sku}</b> — {f.product.description} · venda média {f.avg_daily}/dia · disponível {f.available}{f.coverage_days != null && <> · cobertura {f.coverage_days} dia(s) (acaba por volta de {date(f.stockout_date)})</>}{f.suggested_qty != null && <> · sugestão de compra: {f.suggested_qty} un.</>}</div>
      <LineChart title="Vendido por semana e previsão (un.)" unit="num" height={220} labels={labels.map(date)} series={[{ name: 'Vendido (semanal)', color: SERIES[0], values: [...f.history.map((h: any) => h.qty), ...f.forecast.map(() => null)] }, { name: 'Previsto', color: SERIES[1], dashed: true, values: [...f.history.map((h: any, i: number) => (i === f.history.length - 1 ? h.qty : null)), ...f.forecast.map((h: any) => h.qty)] }]} />
      <div className="muted" style={{ marginTop: 8 }}>Confiança <b>{f.confidence}</b>: {f.note} Método: {f.method}. É uma estimativa, não uma garantia.</div></div>}</>;
}
