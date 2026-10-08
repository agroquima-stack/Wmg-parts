import { useEffect, useState } from 'react';
import { api, ApiError, brl, get, qs } from './api';
import { useAuth } from './auth';
import { Modal } from './DataPage';

const num = (v: any) => Number(v ?? 0);
const date = (v: any) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '—');
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 7) + '-01';
const Err = ({ e }: { e: string }) => (e ? <div className="err">{e}</div> : null);
/** Valores contábeis: negativos entre parênteses e em vermelho. */
const money = (v: number | null | undefined) => (v == null ? '—' : v < 0 ? <span style={{ color: 'var(--red)' }}>({brl(-v)})</span> : brl(v));
const pct = (v: number | null | undefined) => (v == null ? '' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

function csv(rows: (string | number)[][], name: string) {
  const body = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' })); a.download = name; a.click();
}

// ---------------------------------------------------------------- DRE
export function Dre() {
  const [f, setF] = useState({ from: monthStart(), to: today(), group_by: 'none', channel: '' }); const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { setErr(''); get('/accounting/dre' + qs(f)).then(setD).catch((e) => setErr(e.message)); }, [f]);
  const many = d && d.columns.length > 1;
  const exportCsv = () => d && csv([['Linha', ...d.columns.map((c: any) => c.label)], ...d.lines.map((l: any) => [(l.level ? '   ' : '') + l.label, ...d.columns.map((c: any) => l.values[c.key])])], `dre-${f.from}-${f.to}.csv`);
  return <><h1>DRE gerencial</h1><p className="sub">Regime de <b>competência</b>: a receita entra no mês da venda e a despesa no mês de competência. Impostos = provisão do Simples Nacional (ajustada ao valor da guia). Despesas sem dimensão aparecem em “Não alocado”.</p>
    <div className="toolbar"><label>De</label><input type="date" style={{ maxWidth: 160 }} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><label>até</label><input type="date" style={{ maxWidth: 160 }} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
      <select style={{ width: 190 }} value={f.group_by} onChange={(e) => setF({ ...f, group_by: e.target.value })}>{[['none', 'Sem agrupamento'], ['month', 'Por mês'], ['branch', 'Por filial'], ['channel', 'Por canal'], ['category', 'Por categoria'], ['brand', 'Por marca'], ['customer', 'Por cliente']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <select style={{ width: 170 }} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="">Todos os canais</option>{['balcao', 'atacado', 'b2b', 'externo', 'online'].map((c) => <option key={c}>{c}</option>)}</select><span style={{ flex: 1 }} /><button onClick={exportCsv}>Exportar CSV</button></div><Err e={err} />
    {d && <table><thead><tr><th>Linha</th>{d.columns.map((c: any) => <th key={c.key} className="num">{c.label}</th>)}{!many && <th className="num">% da receita líquida</th>}</tr></thead><tbody>
      {d.lines.map((l: any, i: number) => <tr key={i} style={l.kind === 'subtotal' ? { background: '#f1f5f9', fontWeight: 700 } : l.kind === 'section' ? { fontWeight: 600 } : { color: 'var(--mute)' }}>
        <td style={{ paddingLeft: 12 + l.level * 22 }}>{l.label}</td>{d.columns.map((c: any) => <td key={c.key} className="num">{money(l.values[c.key])}</td>)}{!many && <td className="num">{pct(l.pct[d.columns[0].key])}</td>}</tr>)}</tbody></table>}
    <p className="muted">Valores entre parênteses são deduções, custos e despesas. Lucro líquido do Simples Nacional: o DAS substitui IRPJ/CSLL/PIS/COFINS/CPP, por isso não há linha separada de imposto sobre o lucro.</p></>;
}

// ---------------------------------------------------------------- Balanço
export function BalanceSheet() {
  const [asOf, setAsOf] = useState(today()); const [d, setD] = useState<any>(null);
  useEffect(() => { get('/accounting/balance-sheet' + qs({ as_of: asOf })).then(setD); }, [asOf]); if (!d) return null;
  const Block = ({ title, items, total }: { title: string; items: any[]; total?: number }) => <><tr style={{ background: '#f8fafc', fontWeight: 600 }}><td colSpan={2}>{title}</td></tr>{items.map((a) => <tr key={a.id ?? a.name}><td style={{ paddingLeft: 24 }}>{a.code ? `${a.code} · ` : ''}{a.name}</td><td className="num">{money(a.value)}</td></tr>)}{total != null && <tr style={{ fontWeight: 600 }}><td style={{ paddingLeft: 24 }}>Total</td><td className="num">{money(total)}</td></tr>}</>;
  const sum = (xs: any[]) => Math.round(xs.reduce((s, x) => s + x.value, 0) * 100) / 100;
  return <><h1>Balanço patrimonial</h1><div className="toolbar"><label>Posição em</label><input type="date" style={{ maxWidth: 170 }} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
    <span className={`pill ${d.balanced ? 'green' : 'red'}`}>{d.balanced ? 'Ativo = Passivo + Patrimônio líquido ✓' : `Diferença de ${brl(d.difference)}`}</span></div>
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(380px,1fr))' }}>
      <table><thead><tr><th colSpan={2}>ATIVO</th></tr></thead><tbody><Block title="Circulante" items={d.assets.current} total={sum(d.assets.current)} /><Block title="Não circulante" items={d.assets.non_current} total={sum(d.assets.non_current)} /><tr style={{ background: '#e0f2fe', fontWeight: 700 }}><td>TOTAL DO ATIVO</td><td className="num">{money(d.assets.total)}</td></tr></tbody></table>
      <table><thead><tr><th colSpan={2}>PASSIVO E PATRIMÔNIO LÍQUIDO</th></tr></thead><tbody><Block title="Passivo circulante" items={d.liabilities.current} total={sum(d.liabilities.current)} /><Block title="Passivo não circulante" items={d.liabilities.non_current} total={sum(d.liabilities.non_current)} />
        <Block title="Patrimônio líquido" items={[...d.equity.accounts, { name: 'Resultado apurado (lucro/prejuízo do período, ainda não transferido)', value: d.equity.period_result }]} total={d.equity.total} /><tr style={{ background: '#e0f2fe', fontWeight: 700 }}><td>TOTAL DO PASSIVO + PL</td><td className="num">{money(d.total_liabilities_equity)}</td></tr></tbody></table></div>
    <p className="muted">Os saldos vêm do razão (partidas dobradas). “Resultado apurado” soma as contas de resultado até a data; a transferência para lucros acumulados é feita no encerramento do exercício pelo contador.</p></>;
}

// ---------------------------------------------------------------- Plano de contas + mapa de categorias
export function Chart() {
  const { can } = useAuth(); const [accs, setAccs] = useState<any[]>([]); const [map, setMap] = useState<any[]>([]); const [f, setF] = useState<any>(null); const [err, setErr] = useState(''); const [led, setLed] = useState<any>(null);
  const load = () => { get('/accounting/accounts').then((r) => setAccs(r.items)); get('/accounting/category-map').then((r) => setMap(r.items)); }; useEffect(() => { load(); }, []);
  const TYPES: Record<string, string> = { ativo: 'Ativo', passivo: 'Passivo', pl: 'Patrimônio líquido', receita: 'Receita', deducao: 'Dedução da receita', custo: 'Custo', despesa: 'Despesa', outros: 'Outros' };
  const run = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); load(); } catch (e) { setErr((e as ApiError).message); } };
  const openLedger = async (a: any) => setLed(await get('/accounting/ledger' + qs({ account_id: a.id })));
  return <><h1>Plano de contas</h1><p className="sub">Contas configuráveis. As contas marcadas “sistema” recebem os lançamentos automáticos: podem ser renomeadas e renumeradas, mas não inativadas.</p><Err e={err} />
    <div className="toolbar"><span style={{ flex: 1 }} />{can('accounting:create') && <button className="primary" onClick={() => setF({ code: '', name: '', type: 'despesa', dre_group: 'desp_administrativa' })}>+ Conta</button>}</div>
    <table><thead><tr><th>Código</th><th>Conta</th><th>Tipo</th><th>Grupo da DRE</th><th className="num">Saldo</th><th /></tr></thead><tbody>
      {accs.map((a) => <tr key={a.id} style={a.active ? {} : { opacity: 0.5 }}><td>{a.code}</td><td>{a.name} {a.is_system && <span className="pill gray">sistema</span>}</td><td>{TYPES[a.type]}</td><td className="muted">{a.dre_group ?? ''}</td><td className="num">{money(a.balance)}</td>
        <td style={{ whiteSpace: 'nowrap' }}><button onClick={() => openLedger(a)}>razão</button> {can('accounting:edit') && <button onClick={() => setF({ ...a, edit: true })}>editar</button>}</td></tr>)}</tbody></table>
    <h2 style={{ marginTop: 28 }}>Categorias financeiras → conta contábil</h2><p className="muted">Define onde cada categoria de despesa/receita é lançada na contabilidade e na DRE.</p>
    <table><thead><tr><th>Categoria</th><th>Tipo</th><th>Conta contábil</th></tr></thead><tbody>{map.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.kind}</td><td><select disabled={!can('accounting:edit')} value={c.ledger_account_id ?? ''} onChange={(e) => run(() => api('PUT', `/accounting/category-map/${c.id}`, { ledger_account_id: e.target.value }))}>{accs.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></td></tr>)}</tbody></table>
    {f && <Modal onClose={() => setF(null)}><h3 style={{ marginTop: 0 }}>{f.edit ? 'Editar conta' : 'Nova conta'}</h3><div className="form"><div><label>Código *</label><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="5.2.9.50" /></div><div className="full"><label>Nome *</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      {!f.edit && <><div><label>Tipo</label><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        {['receita', 'deducao', 'custo', 'despesa', 'outros'].includes(f.type) && <div><label>Grupo da DRE</label><select value={f.dre_group} onChange={(e) => setF({ ...f, dre_group: e.target.value })}>{['receita_bruta', 'deducoes', 'impostos', 'cmv', 'desp_comercial', 'desp_administrativa', 'desp_financeira', 'rec_financeira', 'outros'].map((g) => <option key={g}>{g}</option>)}</select></div>}</>}
      {f.edit && !f.is_system && <label className="chk"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Ativa</label>}</div><Err e={err} />
      <div className="right"><button onClick={() => setF(null)}>Cancelar</button><button className="primary" disabled={!f.code || f.name.length < 2} onClick={() => run(() => f.edit ? api('PATCH', `/accounting/accounts/${f.id}`, { code: f.code, name: f.name, active: f.active }) : api('POST', '/accounting/accounts', { code: f.code, name: f.name, type: f.type, dre_group: ['receita', 'deducao', 'custo', 'despesa', 'outros'].includes(f.type) ? f.dre_group : null })).then(() => setF(null))}>Salvar</button></div></Modal>}
    {led && <Modal onClose={() => setLed(null)}><h3 style={{ marginTop: 0 }}>Razão — {led.account.code} {led.account.name}</h3><p className="muted">Saldo inicial {money(led.opening)} · saldo final {money(led.closing)} ({led.note})</p>
      <table><thead><tr><th>Data</th><th>Histórico</th><th className="num">Débito</th><th className="num">Crédito</th><th className="num">Saldo</th></tr></thead><tbody>{led.items.map((x: any, i: number) => <tr key={i}><td>{date(x.entry_date)}</td><td>{x.description}</td><td className="num">{num(x.debit) ? brl(x.debit) : ''}</td><td className="num">{num(x.credit) ? brl(x.credit) : ''}</td><td className="num">{money(x.balance)}</td></tr>)}</tbody></table><div className="right"><button onClick={() => setLed(null)}>Fechar</button></div></Modal>}</>;
}

// ---------------------------------------------------------------- Lançamentos (abertura e ajustes)
export function Entries() {
  const { can } = useAuth(); const [d, setD] = useState<any[]>([]); const [kind, setKind] = useState(''); const [q, setQ] = useState(''); const [accs, setAccs] = useState<any[]>([]); const [form, setForm] = useState<any>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('');
  const load = () => get('/accounting/entries' + qs({ kind, q })).then((r) => setD(r.items)); useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [kind, q]); useEffect(() => { get('/accounting/accounts').then((r) => setAccs(r.items.filter((a: any) => a.active))); }, []);
  const tot = (k: 'debit' | 'credit') => (form?.lines ?? []).reduce((s: number, l: any) => s + num(l[k]), 0);
  const save = async () => { setErr(''); try { await api('POST', '/accounting/entries', { date: form.date, description: form.description, kind: form.kind, lines: form.lines.filter((l: any) => l.account_id && (num(l.debit) || num(l.credit))).map((l: any) => ({ account_id: l.account_id, debit: num(l.debit), credit: num(l.credit) })) }); setForm(null); setMsg('Lançamento registrado.'); load(); } catch (e) { setErr((e as ApiError).message); } };
  const blank = (k: string) => ({ kind: k, date: today(), description: k === 'abertura' ? 'Saldos de abertura' : '', lines: [{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }] });
  return <><h1>Lançamentos contábeis</h1><p className="sub">Lançamentos automáticos das operações e lançamentos manuais do contador (abertura do balanço, ajustes). O razão é imutável: correções são feitas por estorno. Saldo inicial dos bancos entra sozinho (contrapartida: Capital social).</p>{msg && <div className="alert green">{msg}</div>}
    <div className="toolbar"><input placeholder="Histórico…" value={q} onChange={(e) => setQ(e.target.value)} /><select style={{ width: 170 }} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Todos</option><option value="sistema">Automáticos</option><option value="manual">Manuais</option><option value="abertura">Abertura</option></select><span style={{ flex: 1 }} />
      {can('accounting:approve') && <><button onClick={() => setForm(blank('abertura'))}>Abertura do balanço</button><button className="primary" onClick={() => setForm(blank('manual'))}>+ Lançamento manual</button></>}</div>
    <table><thead><tr><th>Data</th><th>Competência</th><th>Histórico</th><th>Partidas</th><th className="num">Valor</th><th /></tr></thead><tbody>
      {d.map((e) => <tr key={e.id}><td>{date(e.entry_date)}</td><td>{String(e.competence).slice(0, 7).split('-').reverse().join('/')}</td><td>{e.description} <span className="pill gray">{e.kind}</span>{e.reversal_of && <span className="pill yellow">estorno</span>}</td>
        <td style={{ fontSize: 12 }}>{(e.lines ?? []).slice(0, 4).map((l: any, i: number) => <div key={i}>{num(l.debit) ? 'D' : 'C'} {l.code} {l.name} {brl(num(l.debit) || num(l.credit))}</div>)}{(e.lines ?? []).length > 4 && <div className="muted">+{e.lines.length - 4} partidas</div>}</td><td className="num">{brl(e.total)}</td>
        <td>{can('accounting:approve') && ['manual', 'abertura'].includes(e.kind) && !e.reversal_of && <button className="danger" onClick={() => { const reason = prompt('Motivo do estorno:'); if (reason) api('POST', `/accounting/entries/${e.id}/reverse`, { reason }).then(() => { setMsg('Lançamento estornado.'); load(); }).catch((x) => setErr(x.message)); }}>estornar</button>}</td></tr>)}</tbody></table><Err e={err} />
    {form && <Modal onClose={() => setForm(null)}><h2 style={{ marginTop: 0 }}>{form.kind === 'abertura' ? 'Abertura do balanço' : 'Lançamento manual'}</h2>
      {form.kind === 'abertura' && <p className="muted">Informe os saldos iniciais que o sistema não conhece (imobilizado, empréstimos, lucros acumulados…). Saldos de bancos/caixa já entram pelo cadastro da conta bancária. Ex.: débito em Imobilizado e crédito em Capital social.</p>}
      <div className="form"><div><label>Data</label><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div><div className="full"><label>Histórico *</label><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div></div>
      <table style={{ marginTop: 8 }}><thead><tr><th>Conta</th><th style={{ width: 120 }}>Débito</th><th style={{ width: 120 }}>Crédito</th><th /></tr></thead><tbody>{form.lines.map((l: any, i: number) => <tr key={i}><td><select value={l.account_id} onChange={(e) => setForm({ ...form, lines: form.lines.map((x: any, k: number) => (k === i ? { ...x, account_id: e.target.value } : x)) })}><option value="">—</option>{accs.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></td>
        {(['debit', 'credit'] as const).map((k) => <td key={k}><input type="number" step="0.01" value={l[k]} onChange={(e) => setForm({ ...form, lines: form.lines.map((x: any, j: number) => (j === i ? { ...x, [k]: e.target.value, ...(e.target.value ? { [k === 'debit' ? 'credit' : 'debit']: '' } : {}) } : x)) })} /></td>)}
        <td>{form.lines.length > 2 && <button onClick={() => setForm({ ...form, lines: form.lines.filter((_: any, k: number) => k !== i) })}>×</button>}</td></tr>)}</tbody></table>
      <div className="toolbar" style={{ marginTop: 8 }}><button onClick={() => setForm({ ...form, lines: [...form.lines, { account_id: '', debit: '', credit: '' }] })}>+ partida</button><span className={`pill ${Math.abs(tot('debit') - tot('credit')) < 0.005 && tot('debit') > 0 ? 'green' : 'red'}`}>Débitos {brl(tot('debit'))} · Créditos {brl(tot('credit'))}</span></div><Err e={err} />
      <div className="right"><button onClick={() => setForm(null)}>Cancelar</button><button className="primary" disabled={form.description.length < 3 || Math.abs(tot('debit') - tot('credit')) >= 0.005 || tot('debit') <= 0} onClick={save}>Lançar</button></div></Modal>}</>;
}

// ---------------------------------------------------------------- Balancete + centros de custo
export function TrialBalance() {
  const [f, setF] = useState({ from: monthStart(), to: today() }); const [d, setD] = useState<any>(null); const [cc, setCc] = useState<any>(null);
  useEffect(() => { get('/accounting/trial-balance' + qs(f)).then(setD); get('/accounting/cost-centers' + qs(f)).then(setCc); }, [f]);
  return <><h1>Balancete e centros de custo</h1><div className="toolbar"><input type="date" style={{ maxWidth: 160 }} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><input type="date" style={{ maxWidth: 160 }} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />{d && <span className={`pill ${d.total_debit === d.total_credit ? 'green' : 'red'}`}>Débitos {brl(d.total_debit)} = Créditos {brl(d.total_credit)}</span>}</div>
    {d && <table><thead><tr><th>Conta</th><th className="num">Saldo inicial</th><th className="num">Débitos</th><th className="num">Créditos</th><th className="num">Saldo final</th></tr></thead><tbody>{d.items.map((x: any) => <tr key={x.id}><td>{x.code} {x.name}</td><td className="num">{money(x.opening)}</td><td className="num">{brl(x.debit)}</td><td className="num">{brl(x.credit)}</td><td className="num">{money(x.closing)}</td></tr>)}</tbody></table>}{d && <p className="muted">{d.note}</p>}
    <h2 style={{ marginTop: 28 }}>Despesas por centro de custo (competência)</h2>{cc && <table><thead><tr><th>Centro de custo</th><th className="num">Despesas</th><th>Composição</th></tr></thead><tbody>{cc.items.map((x: any) => <tr key={x.name}><td>{x.name}</td><td className="num">{brl(x.total)}</td><td className="muted">{Object.entries(x.groups).map(([g, v]) => `${g}: ${brl(v as number)}`).join(' · ')}</td></tr>)}{!cc.items.length && <tr><td colSpan={3} className="muted">Sem despesas no período.</td></tr>}</tbody></table>}</>;
}

// ---------------------------------------------------------------- Verificações
export function Checks() {
  const { can } = useAuth(); const [d, setD] = useState<any>(null); const [msg, setMsg] = useState(''); const load = () => get('/accounting/checks').then(setD); useEffect(() => { load(); }, []); if (!d) return null;
  return <><h1>Verificações de consistência</h1><p className="sub">Compara o razão contábil com os saldos operacionais (bancos, clientes, fornecedores, estoque) e confere a identidade do balanço.</p>{msg && <div className="alert green">{msg}</div>}
    <div className={`alert ${d.ok ? 'green' : 'red'}`}>{d.ok ? 'Tudo consistente.' : 'Há divergências abaixo.'}</div>
    <table><thead><tr><th>Verificação</th><th className="num">Razão</th><th className="num">Operacional</th><th className="num">Diferença</th><th /></tr></thead><tbody>{d.checks.map((c: any) => <tr key={c.key}><td>{c.label}{c.note && <div className="muted">{c.note}</div>}</td><td className="num">{brl(c.ledger)}</td><td className="num">{c.operational == null ? '—' : brl(c.operational)}</td><td className="num">{c.diff == null ? '—' : brl(c.diff)}</td><td><span className={`pill ${c.ok ? 'green' : 'red'}`}>{c.ok ? 'ok' : 'divergência'}</span></td></tr>)}</tbody></table>
    {can('accounting:approve') && <div className="toolbar" style={{ marginTop: 12 }}><button onClick={() => api('POST', '/accounting/sync').then((r) => { setMsg(`Sincronização concluída: ${r.created} lançamento(s) criado(s).`); load(); })}>Sincronizar razão com as operações</button><span className="muted">Lança o que ainda não tem lançamento contábil (idempotente).</span></div>}</>;
}
