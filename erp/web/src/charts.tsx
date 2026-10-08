import { useMemo, useState, type ReactNode } from 'react';

// Paleta categórica validada (ordem fixa): azul, laranja, verde-água, amarelo. Comparação/meta usam cinzas neutros.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];
export const MUTED = '#94a3b8', GOAL = '#475569';
const fmt = (v: number, unit: 'brl' | 'num' | 'pct' = 'brl') => (unit === 'brl' ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }) : unit === 'pct' ? `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }));

export interface LineSeries { name: string; values: (number | null)[]; color?: string; dashed?: boolean }
/** Gráfico de linhas: eixo único, grade discreta, cruz + dica ao passar o mouse, legenda, meta tracejada e visão em tabela. */
export function LineChart({ labels, series, goal, unit = 'brl', height = 240, title }: { labels: string[]; series: LineSeries[]; goal?: number | null; unit?: 'brl' | 'num' | 'pct'; height?: number; title: string }) {
  const [hover, setHover] = useState<number | null>(null); const [table, setTable] = useState(false);
  const W = 900, pad = { l: 56, r: 16, t: 14, b: 26 }; const all = series.flatMap((s) => s.values.filter((v): v is number => v != null)).concat(goal ? [goal] : [], [0]);
  const max = Math.max(...all, 1), min = Math.min(...all, 0); const n = Math.max(labels.length - 1, 1);
  const sx = (i: number) => pad.l + (i / n) * (W - pad.l - pad.r); const sy = (v: number) => height - pad.b - ((v - min) / (max - min || 1)) * (height - pad.t - pad.b);
  const ticks = useMemo(() => [0, 0.25, 0.5, 0.75, 1].map((t) => min + (max - min) * t), [min, max]);
  const path = (vals: (number | null)[]) => vals.map((v, i) => (v == null ? null : `${i === 0 || vals[i - 1] == null ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`)).filter(Boolean).join(' ');
  const colors = series.map((s, i) => s.color ?? (i === 0 ? SERIES[0] : MUTED));
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * W; setHover(Math.max(0, Math.min(labels.length - 1, Math.round(((x - pad.l) / (W - pad.l - pad.r)) * n)))); };
  const step = Math.ceil(labels.length / 8);
  return <div className="card" style={{ padding: 12, position: 'relative' }}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}><b>{title}</b>{series.map((s, i) => <span key={s.name} className="muted" style={{ fontSize: 12 }}><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: `3px ${s.dashed ? 'dashed' : 'solid'} ${colors[i]}`, verticalAlign: 'middle', marginRight: 4 }} />{s.name}</span>)}
      {goal != null && <span className="muted" style={{ fontSize: 12 }}><span style={{ display: 'inline-block', width: 14, borderTop: `2px dashed ${GOAL}`, verticalAlign: 'middle', marginRight: 4 }} />Meta {fmt(goal, unit)}</span>}<span style={{ flex: 1 }} /><button style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => setTable(!table)}>{table ? 'Ver gráfico' : 'Ver tabela'}</button></div>
    {table ? <table style={{ marginTop: 8 }}><thead><tr><th>Período</th>{series.map((s) => <th key={s.name} className="num">{s.name}</th>)}</tr></thead><tbody>{labels.map((l, i) => <tr key={l}><td>{l}</td>{series.map((s) => <td key={s.name} className="num">{s.values[i] == null ? '—' : fmt(s.values[i]!, unit)}</td>)}</tr>)}</tbody></table>
      : <svg viewBox={`0 0 ${W} ${height}`} style={{ width: '100%', display: 'block' }} role="img" aria-label={title} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => <g key={t}><line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} stroke="#e2e8f0" /><text x={pad.l - 6} y={sy(t) + 4} fontSize="10" textAnchor="end" fill="#64748b">{fmt(t, unit)}</text></g>)}
        {labels.map((l, i) => (i % step === 0 ? <text key={i} x={sx(i)} y={height - 8} fontSize="10" textAnchor="middle" fill="#64748b">{l.length > 7 ? l.slice(5).split('-').reverse().join('/') : l}</text> : null))}
        {goal != null && <line x1={pad.l} x2={W - pad.r} y1={sy(goal)} y2={sy(goal)} stroke={GOAL} strokeDasharray="6 4" />}
        {series.map((s, i) => <path key={s.name} d={path(s.values)} fill="none" stroke={colors[i]} strokeWidth={i === 0 ? 2.5 : 2} strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" />)}
        {hover != null && <g><line x1={sx(hover)} x2={sx(hover)} y1={pad.t} y2={height - pad.b} stroke="#94a3b8" />{series.map((s, i) => (s.values[hover] != null ? <circle key={s.name} cx={sx(hover)} cy={sy(s.values[hover]!)} r={4.5} fill={colors[i]} stroke="#fff" strokeWidth={2} /> : null))}</g>}
        <rect x={pad.l} y={0} width={W - pad.l - pad.r} height={height} fill="transparent" /></svg>}
    {!table && hover != null && <div style={{ position: 'absolute', top: 40, left: `min(calc(${(sx(hover) / W) * 100}% + 8px), calc(100% - 190px))`, background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', fontSize: 12, boxShadow: '0 4px 14px #0f172a22', pointerEvents: 'none' }}>
      <b>{labels[hover]}</b>{series.map((s, i) => <div key={s.name}><span style={{ color: colors[i] }}>●</span> {s.name}: <b>{s.values[hover] == null ? '—' : fmt(s.values[hover]!, unit)}</b></div>)}</div>}
  </div>;
}

export interface BarRow { label: string; value: number; sub?: string; color?: string; badge?: ReactNode }
/** Barras horizontais de uma só cor (magnitude): rótulo à esquerda, valor à direita, dica ao passar o mouse. */
export function BarList({ rows, unit = 'brl', title, max }: { rows: BarRow[]; unit?: 'brl' | 'num' | 'pct'; title: string; max?: number }) {
  const m = max ?? Math.max(...rows.map((r) => r.value), 1); const [table, setTable] = useState(false);
  return <div className="card" style={{ padding: 12 }}><div style={{ display: 'flex' }}><b>{title}</b><span style={{ flex: 1 }} /><button style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => setTable(!table)}>{table ? 'Ver barras' : 'Ver tabela'}</button></div>
    {table ? <table style={{ marginTop: 6 }}><tbody>{rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="num">{fmt(r.value, unit)}</td><td className="muted">{r.sub}</td></tr>)}</tbody></table>
      : <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>{rows.map((r) => <div key={r.label} title={`${r.label}: ${fmt(r.value, unit)}${r.sub ? ' · ' + r.sub : ''}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(90px,38%) 1fr auto', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span><div style={{ background: '#f1f5f9', borderRadius: 4, height: 14 }}><div style={{ width: `${Math.max(1, (Math.max(r.value, 0) / m) * 100)}%`, height: 14, background: r.color ?? SERIES[0], borderRadius: '0 4px 4px 0' }} /></div>
        <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><b>{fmt(r.value, unit)}</b> {r.badge}{r.sub && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>{r.sub}</span>}</span></div>)}{!rows.length && <span className="muted">Sem dados no período.</span>}</div>}</div>;
}

/** Indicador com variação em relação ao período de comparação (seta + texto: nunca só cor). */
export function Kpi({ label, value, delta, invert, sub, status }: { label: string; value: ReactNode; delta?: number | null; invert?: boolean; sub?: ReactNode; status?: 'ok' | 'bad' | null }) {
  const good = delta == null ? null : invert ? delta <= 0 : delta >= 0;
  return <div className="card kpi"><div className="l">{label}</div><div className="v" style={{ fontSize: 24 }}>{value}</div>
    {delta != null && <div style={{ fontSize: 12, fontWeight: 600, color: good ? 'var(--green)' : 'var(--red)' }}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% vs. período anterior</div>}
    {status && <div style={{ fontSize: 12, fontWeight: 600, color: status === 'ok' ? 'var(--green)' : 'var(--red)' }}>{status === 'ok' ? '✔ dentro da meta' : '✖ fora da meta'}</div>}{sub && <div className="muted" style={{ fontSize: 12 }}>{sub}</div>}</div>;
}
export { fmt };
