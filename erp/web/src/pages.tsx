import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, brl, get, pct, qs } from './api';
import { useAuth } from './auth';
import { DataPage, Modal, type Field } from './DataPage';
import { CustomerPanel } from './commercial';
import { SupplierProducts } from './purchasing';

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'].map((u) => ({ value: u, label: u }));
const active: Field = { key: 'active', label: 'Ativo', type: 'checkbox', list: true };
const address: Field[] = [
  { key: 'zip', label: 'CEP', list: false }, { key: 'street', label: 'Logradouro', list: false }, { key: 'number', label: 'Número', list: false },
  { key: 'complement', label: 'Complemento', list: false }, { key: 'district', label: 'Bairro', list: false },
  { key: 'city', label: 'Cidade', list: true }, { key: 'state', label: 'UF', type: 'select', options: UFS, list: true },
];

// ---------------------------------------------------------------- Dashboard
export function Dashboard() {
  const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { get('/dashboard/summary').then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="err">{err}</div>;
  if (!d) return <p className="muted">Carregando…</p>;
  const k = (l: string, v: ReactNode, to?: string) => <div className="card kpi">{to ? <Link to={to}><div className="v">{v}</div></Link> : <div className="v">{v}</div>}<div className="l">{l}</div></div>;
  return <>
    <h1>Visão geral</h1><p className="sub">Indicadores calculados em tempo real a partir do banco. BI, alertas inteligentes e IA entram nas próximas fases.</p>
    <div className="grid kpis" style={{ marginBottom: 18 }}>
      {k('Produtos ativos', d.counts.products_active, '/produtos')}{k('Clientes ativos', d.counts.customers_active, '/clientes')}
      {k('Fornecedores', d.counts.suppliers_active, '/fornecedores')}{k('Marcas', d.counts.brands, '/marcas')}{k('Modelos de moto', d.counts.vehicle_models, '/motos')}
    </div>
    {d.commercial && <><div className="grid kpis" style={{ marginBottom: 18 }}>
      {k('Faturamento hoje', brl(d.commercial.revenue_day), '/vendas')}{k('Faturamento do mês', brl(d.commercial.revenue_month), '/vendas')}
      {k('Meta do mês', d.commercial.goal_pct != null ? `${d.commercial.goal_pct}%` : 'sem meta', '/precificacao')}{k('Vendas no mês', d.commercial.sales_month)}
      {k('Ticket médio', brl(d.commercial.avg_ticket))}{k('Margem bruta', d.commercial.margin_pct != null ? `${brl(d.commercial.margin_month)} · ${d.commercial.margin_pct}%` : '—')}</div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', marginBottom: 18 }}>
        <div className="card"><b>Vendas por vendedor (mês)</b><table><tbody>{d.commercial.by_seller.map((s: any) => <tr key={s.name}><td>{s.name}</td><td className="num">{brl(s.revenue)}</td><td className="num muted">margem {brl(s.margin)}</td></tr>)}{!d.commercial.by_seller.length && <tr><td className="muted">Sem vendas no mês.</td></tr>}</tbody></table></div>
        <div className="card"><b>Vendas por canal (mês)</b><table><tbody>{d.commercial.by_channel.map((s: any) => <tr key={s.channel}><td>{s.channel}</td><td className="num">{brl(s.revenue)}</td><td className="num muted">{s.sales} vendas</td></tr>)}{!d.commercial.by_channel.length && <tr><td className="muted">Sem vendas no mês.</td></tr>}</tbody></table></div></div></>}
    {d.finance && <div className="grid kpis" style={{ marginBottom: 18 }}>
      {k('Saldo em caixa', brl(d.finance.cash_balance), '/financeiro/bancos')}{k('Saldo bancário', brl(d.finance.bank_balance), '/financeiro/bancos')}{k('A receber', brl(d.finance.receivable_open), '/financeiro/receber')}
      {k('A receber vencido', brl(d.finance.receivable_overdue), '/financeiro/receber')}{k('Menor saldo projetado (90 d)', brl(d.finance.projected_min.value), '/financeiro/fluxo')}</div>}
    {d.accounting && <div className="grid kpis" style={{ marginBottom: 18 }}>
      {k('Receita líquida do mês', brl(d.accounting.receita_liquida), '/contabil/dre')}{k('Lucro bruto', `${brl(d.accounting.lucro_bruto)}${d.accounting.margem_bruta_pct != null ? ' · ' + d.accounting.margem_bruta_pct + '%' : ''}`, '/contabil/dre')}
      {k('Lucro líquido do mês', brl(d.accounting.lucro_liquido), '/contabil/dre')}{k('Margem líquida', d.accounting.margem_liquida_pct != null ? d.accounting.margem_liquida_pct + '%' : '—', '/contabil/dre')}</div>}
    {d.fiscal && <div className="grid kpis" style={{ marginBottom: 18 }}>
      {k('Vendas sem nota fiscal', d.fiscal.sales_without_invoice, '/fiscal/pendentes')}{k('Rascunhos com pendências', d.fiscal.drafts_with_errors, '/fiscal/notas')}{k('Notas rejeitadas', d.fiscal.rejected, '/fiscal/notas')}
      {k('Próximo DAS', d.fiscal.next_das ? `${brl(d.fiscal.next_das.value)} · ${String(d.fiscal.next_das.due_date).split('-').reverse().join('/')}` : '—', '/fiscal/impostos')}</div>}
    {d.purchasing && <div className="grid kpis" style={{ marginBottom: 18 }}>
      {k('Pedidos de compra abertos', d.purchasing.open_orders, '/compras/pedidos')}{k('Entregas atrasadas', d.purchasing.late_orders, '/compras/pedidos')}
      {k('Recebimentos em conferência', d.purchasing.receivings_open, '/compras/recebimento')}{k('A pagar em 7 dias', brl(d.purchasing.payables_7d))}{k('A pagar vencido', brl(d.purchasing.payables_overdue))}</div>}
    {d.stock && <div className="grid kpis" style={{ marginBottom: 18 }}>
      {k('Valor em estoque (custo médio)', brl(d.stock.total_value), '/estoque')}{k('Abaixo do mínimo', d.stock.below_min, '/estoque')}
      {k('Sem estoque', d.stock.out_of_stock, '/estoque')}{k('Acima do máximo', d.stock.excess, '/estoque')}
      {k('Parado > 180 dias', brl(d.stock.idle180.value), '/estoque/analises')}</div>}
    <div className="card"><h3 style={{ marginTop: 0 }}>Alertas</h3>
      {d.alerts.length ? d.alerts.map((a: any, i: number) => <div key={i} className={`alert ${a.level}`}>{a.text}</div>) : <div className="alert green">Nenhum alerta de cadastro.</div>}</div>
  </>;
}

// ---------------------------------------------------------------- Produtos
const prodFields: Field[] = [
  { key: 'sku', label: 'SKU', required: true, list: true },
  { key: 'description', label: 'Descrição', required: true, full: true, list: true },
  { key: 'brand_name', label: 'Marca', list: true, listOnly: true },
  { key: 'brand_id', label: 'Marca', optionsFrom: { path: '/brands' }, list: false },
  { key: 'category_id', label: 'Categoria', optionsFrom: { path: '/categories' }, list: false },
  { key: 'subcategory_id', label: 'Subcategoria', optionsFrom: { path: '/categories' }, list: false },
  { key: 'commercial_description', label: 'Descrição comercial', list: false, full: true },
  { key: 'internal_code', label: 'Código interno', list: false }, { key: 'manufacturer_code', label: 'Cód. fabricante', list: true },
  { key: 'original_code', label: 'Cód. original', list: false },
  { key: 'barcodes_text', label: 'Códigos de barras', full: true, list: false, hint: 'Separe vários por vírgula' },
  { key: 'unit', label: 'Unidade', list: false }, { key: 'ncm', label: 'NCM', list: false }, { key: 'cest', label: 'CEST', list: false }, { key: 'csosn', label: 'CSOSN (vazio = 102)', type: 'select', options: ['101', '102', '103', '201', '202', '203', '300', '400', '500', '900'].map((v) => ({ value: v, label: v })), list: false, hint: 'Use 500/201 se o NCM estiver sujeito a ST (confirme com o contador)' },
  { key: 'origin', label: 'Origem (0-8)', type: 'number', list: false },
  { key: 'weight_kg', label: 'Peso (kg)', type: 'number', step: '0.001', list: false }, { key: 'height_cm', label: 'Altura (cm)', type: 'number', list: false },
  { key: 'width_cm', label: 'Largura (cm)', type: 'number', list: false }, { key: 'length_cm', label: 'Comprimento (cm)', type: 'number', list: false },
  { key: 'min_stock', label: 'Estoque mínimo', type: 'number', list: false }, { key: 'max_stock', label: 'Estoque máximo', type: 'number', list: false },
  { key: 'ideal_stock', label: 'Estoque ideal', type: 'number', list: false }, { key: 'location', label: 'Localização', list: false },
  { key: 'cost_current', label: 'Custo atual', type: 'number', step: '0.01', list: (r) => brl(r.cost_current) },
  { key: 'sale_price', label: 'Preço de venda', type: 'number', step: '0.01', list: (r) => brl(r.sale_price) },
  { key: 'min_price', label: 'Preço mínimo', type: 'number', step: '0.01', list: false },
  { key: 'min_margin_pct', label: 'Margem mínima %', type: 'number', step: '0.01', list: false },
  { key: 'target_margin_pct', label: 'Margem desejada %', type: 'number', step: '0.01', list: false },
  { key: 'margin_pct', label: 'Margem atual', list: (r) => { const low = r.margin_pct != null && Number(r.margin_pct) < Number(r.min_margin_pct);
      return <span className={`pill ${r.margin_pct == null ? 'gray' : low ? 'red' : 'green'}`}>{pct(r.margin_pct)}</span>; }, listOnly: true },
  active,
];

export function Products() {
  return <DataPage title="Produtos" subtitle="Cadastro mestre de peças" path="/products" perm="products"
    fields={prodFields}
    toForm={(r) => ({ ...r, barcodes_text: (r.barcodes ?? []).join(', ') })}
    fromForm={(b) => { const { barcodes_text, ...rest } = b; return { ...rest, barcodes: String(barcodes_text ?? '').split(',').map((s) => s.trim()).filter(Boolean) }; }}
    extras={(row, reload) => <ProductExtras id={row.id} reload={reload} />} />;
}

function ProductExtras({ id }: { id: string; reload: () => void }) {
  const { can } = useAuth();
  const [p, setP] = useState<any>(null); const [models, setModels] = useState<any[]>([]);
  const [app, setApp] = useState({ vehicle_model_id: '', system: '', position: '' });
  const [eq, setEq] = useState(''); const [eqRes, setEqRes] = useState<any[]>([]); const [err, setErr] = useState('');
  const load = () => get(`/products/${id}`).then(setP);
  useEffect(() => { load(); get('/vehicle-models?pageSize=200').then((r) => setModels(r.items)).catch(() => {}); }, [id]);
  useEffect(() => { if (eq.length < 2) return setEqRes([]); const t = setTimeout(() => get('/products' + qs({ q: eq, pageSize: 6 })).then((r) => setEqRes(r.items.filter((x: any) => x.id !== id))), 250); return () => clearTimeout(t); }, [eq]);
  const run = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); await load(); } catch (e) { setErr((e as ApiError).message); } };
  if (!p) return null;
  return <div style={{ marginTop: 18 }}>
    <h3>Aplicações em moto</h3>
    <table><thead><tr><th>Moto</th><th>Anos</th><th>Sistema</th><th>Posição</th><th /></tr></thead><tbody>
      {p.applications.map((a: any) => <tr key={a.id}><td>{a.make} {a.model} {a.version}</td><td>{a.eff_year_from}–{a.eff_year_to ?? 'atual'}</td><td>{a.system}</td><td>{a.position}</td>
        <td>{can('products:edit') && <button className="danger" onClick={() => run(() => api('DELETE', `/products/${id}/applications/${a.id}`))}>remover</button>}</td></tr>)}
      {!p.applications.length && <tr><td colSpan={5} className="muted">Sem aplicações cadastradas.</td></tr>}</tbody></table>
    {can('products:edit') && <div className="toolbar" style={{ marginTop: 8 }}>
      <select value={app.vehicle_model_id} onChange={(e) => setApp({ ...app, vehicle_model_id: e.target.value })} style={{ maxWidth: 260 }}>
        <option value="">Moto…</option>{models.map((m) => <option key={m.id} value={m.id}>{m.make} {m.model} {m.version ?? ''} ({m.year_from}–{m.year_to ?? 'atual'})</option>)}</select>
      <input placeholder="Sistema" value={app.system} onChange={(e) => setApp({ ...app, system: e.target.value })} style={{ maxWidth: 160 }} />
      <input placeholder="Posição" value={app.position} onChange={(e) => setApp({ ...app, position: e.target.value })} style={{ maxWidth: 120 }} />
      <button disabled={!app.vehicle_model_id} onClick={() => run(() => api('POST', `/products/${id}/applications`, app).then(() => setApp({ vehicle_model_id: '', system: '', position: '' })))}>Adicionar</button></div>}
    <h3>Equivalentes</h3>
    <table><thead><tr><th>Marca</th><th>Código</th><th>Descrição</th><th className="num">Custo</th><th className="num">Preço</th><th className="num">Margem</th></tr></thead><tbody>
      {p.equivalents.map((e: any) => <tr key={e.id}><td>{e.brand_name}{e.is_original && <span className="pill gray" style={{ marginLeft: 6 }}>original</span>}</td><td>{e.manufacturer_code ?? e.sku}</td><td>{e.description}</td>
        <td className="num">{brl(e.cost_current)}</td><td className="num">{brl(e.sale_price)}</td><td className="num">{pct(e.margin_pct)}</td></tr>)}
      {!p.equivalents.length && <tr><td colSpan={6} className="muted">Sem equivalentes. A disponibilidade em estoque aparecerá na Fase 2.</td></tr>}</tbody></table>
    {can('equivalences:create') && <div style={{ marginTop: 8 }}><input placeholder="Buscar produto para vincular como equivalente…" value={eq} onChange={(e) => setEq(e.target.value)} />
      {eqRes.map((r) => <div key={r.id} style={{ padding: '4px 0' }}><button onClick={() => run(() => api('POST', `/products/${id}/equivalents`, { otherProductId: r.id }).then(() => { setEq(''); }))}>vincular</button> {r.sku} — {r.description}</div>)}</div>}
    {err && <div className="err">{err}</div>}
  </div>;
}

// ---------------------------------------------------------------- Busca por aplicação
export function ApplicationSearch() {
  const [q, setQ] = useState('Pastilha CG 160 2020'); const [r, setR] = useState<any>(null); const [err, setErr] = useState('');
  useEffect(() => { if (!q.trim()) return; const t = setTimeout(() => get('/search/applications' + qs({ q })).then(setR).catch((e) => setErr(e.message)), 250); return () => clearTimeout(t); }, [q]);
  return <>
    <h1>Busca por aplicação</h1><p className="sub">Digite peça + moto + ano, ex.: “Pastilha CG 160 2020”.</p>
    <div className="toolbar"><input autoFocus style={{ maxWidth: 520 }} value={q} onChange={(e) => setQ(e.target.value)} />
      {r?.interpreted && <span className="muted">termos: {r.interpreted.terms.join(', ')}{r.interpreted.year ? ` · ano ${r.interpreted.year}` : ''}</span>}</div>
    {err && <div className="err">{err}</div>}
    <table><thead><tr><th>SKU</th><th>Peça</th><th>Marca</th><th>Compatível com</th><th className="num">Preço</th></tr></thead><tbody>
      {r?.items.map((p: any) => <tr key={p.id}><td>{p.sku}</td><td>{p.description}</td><td>{p.brand_name}</td>
        <td>{p.applications.map((a: any, i: number) => <div key={i}>{a.make} {a.model} {a.version} <span className="muted">{a.year_from}–{a.year_to ?? 'atual'}</span></div>)}</td>
        <td className="num">{brl(p.sale_price)}</td></tr>)}
      {r && !r.items.length && <tr><td colSpan={5} className="muted">Nenhuma peça compatível encontrada.</td></tr>}</tbody></table>
  </>;
}

// ---------------------------------------------------------------- Cadastros simples
export const Brands = () => <DataPage title="Marcas" path="/brands" perm="brands" fields={[{ key: 'name', label: 'Nome', required: true, list: true }, active]} />;
export const Categories = () => <DataPage title="Categorias" subtitle="Categorias e subcategorias (informe a categoria-pai)" path="/categories" perm="categories"
  fields={[{ key: 'name', label: 'Nome', required: true, list: true }, { key: 'parent_id', label: 'Categoria-pai', optionsFrom: { path: '/categories' }, list: false }, active]} />;
export const Vehicles = () => <DataPage title="Motos" subtitle="Marca, modelo e período de fabricação" path="/vehicle-models" perm="vehicles" fields={[
  { key: 'make', label: 'Marca', required: true, list: true }, { key: 'model', label: 'Modelo', required: true, list: true }, { key: 'version', label: 'Versão', list: true },
  { key: 'year_from', label: 'Ano inicial', type: 'number', required: true, list: true }, { key: 'year_to', label: 'Ano final', type: 'number', list: true, hint: 'Vazio = ainda em produção' },
  { key: 'displacement_cc', label: 'Cilindrada (cc)', type: 'number', list: true }, { key: 'engine', label: 'Motor', list: false }, { key: 'category', label: 'Categoria', list: false }, active]} />;
export const Suppliers = () => <DataPage title="Fornecedores" path="/suppliers" perm="suppliers" extras={(row) => <SupplierProducts id={row.id} />} fields={[
  { key: 'legal_name', label: 'Razão social', required: true, list: true }, { key: 'trade_name', label: 'Nome fantasia', list: true }, { key: 'cnpj', label: 'CNPJ', list: true },
  { key: 'ie', label: 'IE', list: false }, { key: 'contact_name', label: 'Contato', list: false }, { key: 'phone', label: 'Telefone', list: false }, { key: 'email', label: 'E-mail', type: 'email', list: false },
  ...address, { key: 'payment_terms_days', label: 'Prazo pgto (dias)', type: 'number', list: false }, { key: 'lead_time_days', label: 'Prazo entrega (dias)', type: 'number', list: false },
  { key: 'freight_type', label: 'Frete', type: 'select', options: [{ value: 'CIF', label: 'CIF' }, { value: 'FOB', label: 'FOB' }], list: false },
  { key: 'carrier', label: 'Transportadora', list: false }, { key: 'notes', label: 'Observações', type: 'textarea', list: false }, active]} />;
export const Customers = () => <DataPage title="Clientes" path="/customers" perm="customers" extras={(row) => <CustomerButton id={row.id} />}
  toForm={(r) => ({ ...r, final_consumer: r.final_consumer == null ? '' : String(r.final_consumer), ie_indicator: r.ie_indicator == null ? '' : String(r.ie_indicator) })}
  fromForm={(b) => ({ ...b, final_consumer: b.final_consumer === 'true' ? true : b.final_consumer === 'false' ? false : null })} fields={[
  { key: 'type', label: 'Tipo', type: 'select', options: [{ value: 'PF', label: 'Pessoa física' }, { value: 'PJ', label: 'Pessoa jurídica' }], required: true, list: true },
  { key: 'legal_name', label: 'Nome / Razão social', required: true, list: true }, { key: 'trade_name', label: 'Nome fantasia', list: false },
  { key: 'document', label: 'CPF / CNPJ', list: true }, { key: 'ie', label: 'IE', list: false },
  ...address, { key: 'phone', label: 'Telefone', list: true }, { key: 'whatsapp', label: 'WhatsApp', list: false }, { key: 'email', label: 'E-mail', type: 'email', list: false },
  { key: 'ie_indicator', label: 'Indicador de IE', type: 'select', options: [{ value: '1', label: '1 — Contribuinte' }, { value: '2', label: '2 — Isento' }, { value: '9', label: '9 — Não contribuinte' }], list: false, hint: 'Vazio = automático (PF = 9; PJ com IE = 1)' }, { key: 'city_ibge', label: 'Cód. IBGE do município', list: false }, { key: 'final_consumer', label: 'Consumidor final (vazio = automático pelo segmento)', type: 'select', options: [{ value: 'true', label: 'Sim' }, { value: 'false', label: 'Não (revenda)' }], list: false },
  { key: 'segment', label: 'Segmento', list: true }, { key: 'seller_id', label: 'Vendedor', optionsFrom: { path: '/users?is_seller=true', label: 'name' }, list: false },
  { key: 'price_table', label: 'Tabela de preço', type: 'select', options: ['varejo', 'oficina', 'atacado', 'revenda', 'especial'].map((v) => ({ value: v, label: v })), list: false },
  { key: 'credit_limit', label: 'Limite de crédito', type: 'number', step: '0.01', list: (r) => brl(r.credit_limit) },
  { key: 'payment_condition', label: 'Condição de pagamento', list: false }, { key: 'payment_term_days', label: 'Prazo (dias)', type: 'number', list: false },
  { key: 'status', label: 'Status', type: 'select', options: ['ativo', 'inativo', 'bloqueado'].map((v) => ({ value: v, label: v })), list: true },
  { key: 'notes', label: 'Observações', type: 'textarea', list: false }]} />;

// ---------------------------------------------------------------- Usuários
export function Users() {
  const { can } = useAuth(); const [pw, setPw] = useState<any>(null); const [msg, setMsg] = useState('');
  return <>
    <DataPage title="Usuários" subtitle="Cada usuário pertence a um perfil que define suas permissões" path="/users" perm="users" fields={[
      { key: 'name', label: 'Nome', required: true, list: true }, { key: 'email', label: 'E-mail', type: 'email', required: true, list: true },
      { key: 'role_id', label: 'Perfil', optionsFrom: { path: '/roles', label: 'name' }, required: true, list: (r) => r.role_name },
      { key: 'password', label: 'Senha provisória', createOnly: true, list: false, hint: 'Mín. 10 caracteres, letras e números. Trocada no 1º acesso.' },
      { key: 'is_seller', label: 'É vendedor', type: 'checkbox', list: (r) => (r.is_seller ? 'Sim' : '—') },
      { key: 'commission_pct', label: 'Comissão %', type: 'number', step: '0.01', list: false }, { key: 'max_discount_pct', label: 'Desconto máx. %', type: 'number', step: '0.01', list: false },
      active]}
      extras={(row) => can('users:edit') && <div style={{ marginTop: 12 }}><button onClick={() => setPw({ id: row.id, name: row.name, password: '' })}>Redefinir senha…</button></div>} />
    {pw && <Modal onClose={() => setPw(null)}><h3>Redefinir senha de {pw.name}</h3><input type="text" placeholder="Nova senha provisória" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
      {msg && <div className="err">{msg}</div>}<div className="right"><button onClick={() => setPw(null)}>Cancelar</button>
        <button className="primary" onClick={() => api('POST', `/users/${pw.id}/reset-password`, { password: pw.password }).then(() => { setPw(null); setMsg(''); }).catch((e) => setMsg(e.message))}>Redefinir</button></div></Modal>}
  </>;
}

export function Roles() {
  const { can } = useAuth(); const [roles, setRoles] = useState<any[]>([]); const [cat, setCat] = useState<any>(null); const [sel, setSel] = useState<any>(null); const [msg, setMsg] = useState('');
  const load = () => get('/roles').then((r) => setRoles(r.items));
  useEffect(() => { load(); get('/permissions').then(setCat); }, []);
  const label: Record<string, string> = { view: 'Ver', create: 'Criar', edit: 'Editar', delete: 'Excluir', approve: 'Aprovar' };
  const locked = sel?.name === 'administrador' || !can('roles:edit');
  return <>
    <h1>Perfis e permissões</h1><p className="sub">RBAC por módulo e ação.</p>
    <div className="grid" style={{ gridTemplateColumns: '220px 1fr' }}>
      <div className="card">{roles.map((r) => <div key={r.id}><a href="#" onClick={(e) => { e.preventDefault(); setSel({ ...r }); setMsg(''); }} style={{ fontWeight: sel?.id === r.id ? 700 : 400 }}>{r.name}</a> <span className="muted">({r.users_count})</span></div>)}</div>
      {sel && cat && <div className="card"><h3 style={{ marginTop: 0 }}>{sel.name} <small className="muted">{sel.description}</small></h3>
        <div className="perm-grid"><span />{cat.actions.map((a: string) => <b key={a}>{label[a]}</b>)}
          {cat.resources.map((res: string) => <><span key={res}>{res}</span>{cat.actions.map((a: string) => { const p = `${res}:${a}`;
            return <input key={p} type="checkbox" style={{ width: 'auto' }} disabled={locked} checked={sel.permissions.includes(p)}
              onChange={(e) => setSel({ ...sel, permissions: e.target.checked ? [...sel.permissions, p] : sel.permissions.filter((x: string) => x !== p) })} />; })}</>)}</div>
        {msg && <div className="err">{msg}</div>}
        {!locked && <div className="right"><button className="primary" onClick={() => api('PUT', `/roles/${sel.id}/permissions`, { permissions: sel.permissions }).then(() => { setMsg('Salvo.'); load(); }).catch((e) => setMsg(e.message))}>Salvar permissões</button></div>}</div>}
    </div></>;
}

export function Audit() {
  const [f, setF] = useState({ entity: '', action: '' }); const [d, setD] = useState<any>({ items: [], total: 0 }); const [open, setOpen] = useState<any>(null);
  useEffect(() => { get('/audit' + qs(f)).then(setD); }, [f]);
  return <>
    <h1>Auditoria</h1><p className="sub">Registro imutável de ações críticas: quem, quando, antes e depois.</p>
    <div className="toolbar"><input placeholder="Entidade (product, customer, user…)" value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })} />
      <input placeholder="Ação (update, sale_price_change…)" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} /></div>
    <table><thead><tr><th>Data</th><th>Usuário</th><th>Entidade</th><th>Ação</th><th /></tr></thead><tbody>
      {d.items.map((a: any) => <tr key={a.id}><td>{new Date(a.created_at).toLocaleString('pt-BR')}</td><td>{a.user_name}</td><td>{a.entity}</td><td>{a.action}</td>
        <td>{(a.before || a.after) && <button onClick={() => setOpen(a)}>antes/depois</button>}</td></tr>)}</tbody></table>
    {open && <Modal onClose={() => setOpen(null)}><h3>{open.entity} · {open.action}</h3><div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <div><b>Antes</b><pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(open.before, null, 2)}</pre></div>
      <div><b>Depois</b><pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(open.after, null, 2)}</pre></div></div></Modal>}
  </>;
}

function CustomerButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return <div style={{ marginTop: 12 }}><button onClick={() => setOpen(true)}>Ver histórico, crédito e inadimplência</button>{open && <CustomerPanel id={id} onClose={() => setOpen(false)} />}</div>;
}

export const Branches = () => <DataPage title="Filiais e dados fiscais" subtitle="O emitente da nota é a filial da venda: CNPJ, IE, regime (CRT 1 = Simples Nacional) e endereço completo são obrigatórios para emitir." path="/branches" perm="branches" fields={[
  { key: 'code', label: 'Código', required: true, list: true }, { key: 'name', label: 'Nome', required: true, list: true }, { key: 'cnpj', label: 'CNPJ', list: true }, { key: 'ie', label: 'Inscrição estadual', list: true }, { key: 'im', label: 'Inscrição municipal', list: false },
  { key: 'crt', label: 'CRT (1 = Simples Nacional)', type: 'number', list: false }, { key: 'zip', label: 'CEP', list: false }, { key: 'street', label: 'Logradouro', list: false }, { key: 'number', label: 'Número', list: false }, { key: 'complement', label: 'Complemento', list: false }, { key: 'district', label: 'Bairro', list: false },
  { key: 'city', label: 'Cidade', list: true }, { key: 'state', label: 'UF', type: 'select', options: UFS, list: true }, { key: 'city_ibge', label: 'Cód. IBGE do município', list: false }, { key: 'phone', label: 'Telefone', list: false }, { key: 'is_headquarters', label: 'Matriz', type: 'checkbox', list: false }, active]} />;
