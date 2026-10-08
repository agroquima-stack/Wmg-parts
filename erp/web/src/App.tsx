import { useEffect, useState, type FormEvent } from 'react';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, get } from './api';
import { AuthProvider, useAuth } from './auth';
import { ApplicationSearch, Audit, Brands, Categories, Customers, Dashboard, Products, Roles, Suppliers, Users, Vehicles } from './pages';

function Login() {
  const { login } = useAuth(); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => { e.preventDefault(); setErr(''); try { await login(email, password); } catch (x) { setErr((x as Error).message); } };
  return <form className="login card" onSubmit={submit}>
    <div className="brand" style={{ padding: 0, marginBottom: 12 }}>WMG ERP</div>
    <label>E-mail</label><input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
    <label style={{ marginTop: 10 }}>Senha</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
    {err && <div className="err">{err}</div>}
    <div className="right"><button className="primary" style={{ width: '100%' }}>Entrar</button></div>
  </form>;
}

function ChangePassword({ forced }: { forced?: boolean }) {
  const { reload, logout } = useAuth(); const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [msg, setMsg] = useState(''); const nav = useNavigate();
  const submit = async (e: FormEvent) => { e.preventDefault(); try { await api('POST', '/auth/change-password', { current: cur, next }); await reload(); nav('/'); setMsg('Senha alterada.'); } catch (x) { setMsg((x as Error).message); } };
  return <form className="card" style={{ maxWidth: 380 }} onSubmit={submit}>
    <h2 style={{ marginTop: 0 }}>{forced ? 'Defina uma nova senha' : 'Alterar senha'}</h2>
    {forced && <p className="muted">Sua senha atual é provisória. Defina uma nova para continuar.</p>}
    <label>Senha atual</label><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} required />
    <label style={{ marginTop: 10 }}>Nova senha (mín. 10, letras e números)</label><input type="password" value={next} onChange={(e) => setNext(e.target.value)} required />
    {msg && <div className="err">{msg}</div>}<div className="right">{forced && <button type="button" onClick={logout}>Sair</button>}<button className="primary">Salvar</button></div></form>;
}

function GlobalSearch() {
  const [q, setQ] = useState(''); const [res, setRes] = useState<any[]>([]); const nav = useNavigate();
  useEffect(() => { if (q.trim().length < 2) return setRes([]); const t = setTimeout(() => get('/search/global?q=' + encodeURIComponent(q)).then((r) => setRes(r.results)).catch(() => {}), 200); return () => clearTimeout(t); }, [q]);
  const to = { product: '/produtos', customer: '/clientes', supplier: '/fornecedores' } as Record<string, string>;
  const label = { product: 'Produto', customer: 'Cliente', supplier: 'Fornecedor' } as Record<string, string>;
  return <div className="search"><input placeholder="Busca global: produto, código, EAN, cliente, fornecedor…" value={q} onChange={(e) => setQ(e.target.value)} />
    {res.length > 0 && <div className="results">{res.map((r) => <a key={r.type + r.id} href="#" onClick={(e) => { e.preventDefault(); setQ(''); nav(to[r.type]); }}>
      <b>{r.title}</b><small>{label[r.type]} · {r.subtitle}</small></a>)}</div>}</div>;
}

const NAV: { group: string; items: [string, string, string][] }[] = [
  { group: 'Geral', items: [['/', 'Visão geral', ''], ['/busca', 'Busca por aplicação', 'products:view']] },
  { group: 'Cadastros', items: [['/produtos', 'Produtos', 'products:view'], ['/marcas', 'Marcas', 'brands:view'], ['/categorias', 'Categorias', 'categories:view'],
    ['/motos', 'Motos', 'vehicles:view'], ['/clientes', 'Clientes', 'customers:view'], ['/fornecedores', 'Fornecedores', 'suppliers:view']] },
  { group: 'Administração', items: [['/usuarios', 'Usuários', 'users:view'], ['/perfis', 'Perfis e permissões', 'roles:view'], ['/auditoria', 'Auditoria', 'audit:view']] },
];

function Shell() {
  const { me, can, logout, mustChange } = useAuth();
  if (!me) return <Login />;
  const switchBranch = async (id: string) => { await api('POST', '/auth/branch', { branchId: id }); location.reload(); };
  return <div className="layout">
    <aside className="side"><div className="brand">WMG ERP</div>
      {NAV.map((g) => { const items = g.items.filter(([, , p]) => !p || can(p)); return items.length ? <div key={g.group}><h4>{g.group}</h4>
        {items.map(([to, l]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>{l}</NavLink>)}</div> : null; })}
      <h4>Conta</h4><NavLink to="/senha">Alterar senha</NavLink><a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>Sair</a></aside>
    <div className="main">
      {me.company.is_demo && <div className="banner">AMBIENTE DE DEMONSTRAÇÃO — todos os dados são fictícios.</div>}
      <div className="top"><GlobalSearch />
        <select style={{ width: 180 }} value={me.branchId ?? ''} onChange={(e) => switchBranch(e.target.value)}>{me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <span className="muted">{me.user.name} · {me.user.role}</span></div>
      <div className="content"><Routes>
        <Route path="/" element={<Dashboard />} /><Route path="/busca" element={<ApplicationSearch />} />
        <Route path="/produtos" element={<Products />} /><Route path="/marcas" element={<Brands />} /><Route path="/categorias" element={<Categories />} />
        <Route path="/motos" element={<Vehicles />} /><Route path="/clientes" element={<Customers />} /><Route path="/fornecedores" element={<Suppliers />} />
        <Route path="/usuarios" element={<Users />} /><Route path="/perfis" element={<Roles />} /><Route path="/auditoria" element={<Audit />} />
        <Route path="/senha" element={<ChangePassword />} /><Route path="*" element={<Navigate to="/" />} />
      </Routes></div></div></div>;
}

/** Se a API sinalizar senha provisória (403 password_change_required), mostra apenas a tela de troca. */
function Gate() {
  const { me, loading } = useAuth(); const [forced, setForced] = useState(false);
  useEffect(() => { if (me) get('/dashboard/summary').then(() => setForced(false)).catch((e) => setForced(e.code === 'password_change_required')); }, [me]);
  if (loading) return <p className="muted" style={{ padding: 24 }}>Carregando…</p>;
  if (me && forced) return <div className="login"><ChangePassword forced /></div>;
  return <Shell />;
}

export default function App() { return <BrowserRouter><AuthProvider><Gate /></AuthProvider></BrowserRouter>; }
