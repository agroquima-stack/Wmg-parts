import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, get, qs } from './api';
import { useAuth } from './auth';

export interface Field {
  key: string; label: string; type?: 'text' | 'number' | 'select' | 'checkbox' | 'textarea' | 'email';
  options?: { value: string; label: string }[]; optionsFrom?: { path: string; label?: string; value?: string };
  required?: boolean; full?: boolean; list?: boolean | ((row: any) => ReactNode); createOnly?: boolean; listOnly?: boolean; step?: string; hint?: string;
}
interface Props {
  title: string; subtitle?: string; path: string; perm: string; fields: Field[];
  extras?: (row: any, reload: () => void) => ReactNode;      // seção extra no modal (ex.: aplicações)
  toForm?: (row: any) => Record<string, any>; fromForm?: (f: Record<string, any>) => Record<string, any>;
  filters?: ReactNode; rowFilter?: Record<string, any>;
}

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="modal">{children}</div></div>;
}

export function DataPage({ title, subtitle, path, perm, fields, extras, toForm, fromForm, rowFilter }: Props) {
  const { can } = useAuth();
  const [q, setQ] = useState(''); const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: any[]; total: number; pageSize: number }>({ items: [], total: 0, pageSize: 50 });
  const [edit, setEdit] = useState<any | null>(null); const [error, setError] = useState('');
  const load = useCallback(() => get(path + qs({ q, page, ...rowFilter })).then(setData).catch((e) => setError(e.message)), [path, q, page, rowFilter]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => setPage(1), [q]);
  const listFields = fields.filter((f) => f.list !== false && (f.list || !f.createOnly)).slice(0, 8);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return <>
    <h1>{title}</h1><p className="sub">{subtitle}</p>
    {error && <div className="err">{error}</div>}
    <div className="toolbar">
      <input placeholder="Pesquisar…" value={q} onChange={(e) => setQ(e.target.value)} />
      <span className="muted">{data.total} registros</span><span style={{ flex: 1 }} />
      {can(`${perm}:create`) && <button className="primary" onClick={() => setEdit({})}>+ Novo</button>}
    </div>
    <table><thead><tr>{listFields.map((f) => <th key={f.key}>{f.label}</th>)}</tr></thead>
      <tbody>{data.items.map((r) => <tr key={r.id} className="click" onClick={() => setEdit(r)}>
        {listFields.map((f) => <td key={f.key}>{typeof f.list === 'function' ? f.list(r) : cell(r[f.key], f)}</td>)}</tr>)}
        {!data.items.length && <tr><td colSpan={listFields.length} className="muted">Nenhum registro.</td></tr>}</tbody></table>
    <div className="pager"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>{page} / {pages}<button disabled={page >= pages} onClick={() => setPage(page + 1)}>›</button></div>
    {edit && <Editor row={edit} path={path} perm={perm} fields={fields} extras={extras} toForm={toForm} fromForm={fromForm}
      onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
  </>;
}

function cell(v: any, f: Field) {
  if (f.type === 'checkbox') return <span className={`pill ${v ? 'green' : 'gray'}`}>{v ? 'Ativo' : 'Inativo'}</span>;
  if (v == null || v === '') return <span className="muted">—</span>;
  if (f.type === 'select' && f.options) return f.options.find((o) => o.value === v)?.label ?? v;
  return String(v);
}

function Editor({ row, path, perm, fields, extras, toForm, fromForm, onClose, onSaved }: Omit<Props, 'title'> & { row: any; onClose(): void; onSaved(): void }) {
  const { can } = useAuth();
  const isNew = !row.id;
  const [f, setF] = useState<Record<string, any>>(() => (isNew ? defaults(fields) : toForm ? toForm(row) : row));
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [opts, setOpts] = useState<Record<string, { value: string; label: string }[]>>({});
  useEffect(() => {
    fields.filter((x) => x.optionsFrom).forEach((x) => get(x.optionsFrom!.path + '?pageSize=200').then((r) =>
      setOpts((o) => ({ ...o, [x.key]: r.items.map((i: any) => ({ value: i[x.optionsFrom!.value ?? 'id'], label: i[x.optionsFrom!.label ?? 'name'] })) }))));
  }, [fields]);
  const readOnly = isNew ? !can(`${perm}:create`) : !can(`${perm}:edit`);

  async function save() {
    setBusy(true); setErr('');
    try {
      const body = Object.fromEntries(fields.filter((x) => !x.listOnly && !(x.createOnly && !isNew)).map((x) => [x.key, clean(f[x.key], x)]));
      const payload = fromForm ? fromForm({ ...body }) : body;
      if (isNew) await api('POST', path, payload); else await api('PATCH', `${path}/${row.id}`, payload);
      onSaved();
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }
  async function del() {
    if (!confirm('Excluir este registro? Se estiver em uso, será apenas inativado.')) return;
    try { const r = await api('DELETE', `${path}/${row.id}`); if (r.message) alert(r.message); onSaved(); } catch (e) { setErr((e as ApiError).message); }
  }
  return <Modal onClose={onClose}>
    <h2 style={{ marginTop: 0 }}>{isNew ? 'Novo registro' : 'Editar registro'}</h2>
    <div className="form">{fields.filter((x) => !x.listOnly && !(x.createOnly && !isNew)).map((x) => <div key={x.key} className={x.full || x.type === 'textarea' ? 'full' : ''}>
      {x.type === 'checkbox'
        ? <label className="chk"><input type="checkbox" disabled={readOnly} checked={!!f[x.key]} onChange={(e) => setF({ ...f, [x.key]: e.target.checked })} />{x.label}</label>
        : <><label>{x.label}{x.required && ' *'}</label>
          {x.type === 'select' || x.optionsFrom
            ? <select disabled={readOnly} value={f[x.key] ?? ''} onChange={(e) => setF({ ...f, [x.key]: e.target.value })}>
                <option value="">—</option>{(x.options ?? opts[x.key] ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            : x.type === 'textarea'
              ? <textarea rows={3} disabled={readOnly} value={f[x.key] ?? ''} onChange={(e) => setF({ ...f, [x.key]: e.target.value })} />
              : <input type={x.type === 'number' ? 'number' : x.type === 'email' ? 'email' : 'text'} step={x.step} disabled={readOnly}
                  value={f[x.key] ?? ''} onChange={(e) => setF({ ...f, [x.key]: e.target.value })} />}
          {x.hint && <small className="muted">{x.hint}</small>}</>}
    </div>)}</div>
    {!isNew && extras?.(row, onSaved)}
    {err && <div className="err">{err}</div>}
    <div className="right">
      {!isNew && can(`${perm}:delete`) && <button className="danger" onClick={del}>Excluir</button>}<span style={{ flex: 1 }} />
      <button onClick={onClose}>Fechar</button>{!readOnly && <button className="primary" disabled={busy} onClick={save}>{busy ? 'Salvando…' : 'Salvar'}</button>}
    </div>
  </Modal>;
}

const defaults = (fields: Field[]) => Object.fromEntries(fields.filter((x) => x.type === 'checkbox').map((x) => [x.key, true]));
function clean(v: any, f: Field) {
  if (f.type === 'checkbox') return !!v;
  if (v === '' || v === undefined) return f.type === 'number' ? undefined : f.optionsFrom || f.type === 'select' ? null : v === '' ? null : v;
  return v;
}
