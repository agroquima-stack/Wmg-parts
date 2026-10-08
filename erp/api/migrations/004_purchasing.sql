-- FASE 4 — COMPRAS: fornecedor×produto, histórico de preços, cotações, pedidos, recebimento (XML/manual), devolução ao fornecedor.

create table supplier_products (
  company_id uuid not null references companies(id),
  supplier_id uuid not null references suppliers(id),
  product_id uuid not null references products(id),
  supplier_code text,                              -- cProd do fornecedor (casamento do XML)
  lead_time_days int,                              -- sobrescreve o prazo padrão do fornecedor
  preferred boolean not null default false,
  primary key (supplier_id, product_id)
);
create index supplier_products_code_idx on supplier_products (company_id, supplier_id, supplier_code);

create table supplier_prices (                      -- histórico de preço por fornecedor
  id bigserial primary key,
  company_id uuid not null references companies(id),
  supplier_id uuid not null references suppliers(id),
  product_id uuid not null references products(id),
  price numeric(14,4) not null check (price >= 0),
  source text not null check (source in ('manual','cotacao','pedido','nf')),
  ref text,
  created_at timestamptz not null default now()
);
create index supplier_prices_idx on supplier_prices (company_id, product_id, created_at desc);

create table quotations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  number int not null,
  status text not null default 'aberta' check (status in ('aberta','fechada','cancelada')),
  note text,
  created_by uuid not null references users(id), created_at timestamptz not null default now(),
  unique (company_id, number)
);
create table quotation_items (
  quotation_id uuid not null references quotations(id) on delete cascade,
  product_id uuid not null references products(id),
  qty numeric(14,3) not null check (qty > 0),
  primary key (quotation_id, product_id)
);
create table quotation_offers (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references quotations(id) on delete cascade,
  company_id uuid not null references companies(id),
  product_id uuid not null references products(id),
  supplier_id uuid not null references suppliers(id),
  unit_price numeric(14,4) not null check (unit_price >= 0),
  lead_time_days int, payment_terms_days int, note text,
  selected boolean not null default false,
  created_at timestamptz not null default now(),
  unique (quotation_id, product_id, supplier_id)
);

create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  branch_id uuid not null references branches(id),     -- filial de destino
  number int not null,
  supplier_id uuid not null references suppliers(id),
  status text not null default 'rascunho' check (status in ('rascunho','aguardando_aprovacao','aprovado','enviado','parcial','recebido','cancelado')),
  expected_date date,
  payment_terms_days int not null default 0,
  freight numeric(14,2) not null default 0, discount numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  notes text, quotation_id uuid references quotations(id),
  created_by uuid not null references users(id), created_at timestamptz not null default now(),
  approved_by uuid references users(id), approved_at timestamptz,
  unique (company_id, number)
);
create index purchase_orders_status_idx on purchase_orders (company_id, status);
create table purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references purchase_orders(id) on delete cascade,
  product_id uuid not null references products(id),
  qty numeric(14,3) not null check (qty > 0),
  unit_price numeric(14,4) not null check (unit_price >= 0),
  received_qty numeric(14,3) not null default 0,
  unique (po_id, product_id)
);

create table receivings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  branch_id uuid not null references branches(id),
  number int not null,
  po_id uuid references purchase_orders(id),
  supplier_id uuid not null references suppliers(id),
  status text not null default 'em_conferencia' check (status in ('em_conferencia','concluido','cancelado')),
  source text not null check (source in ('xml','manual')),
  nf_number text not null, nf_series text, nf_key text, issue_date date,
  freight numeric(14,2) not null default 0, insurance numeric(14,2) not null default 0, other_expenses numeric(14,2) not null default 0,
  ipi_total numeric(14,2) not null default 0, discount numeric(14,2) not null default 0,
  total_products numeric(14,2) not null default 0, total_nf numeric(14,2) not null default 0,
  installments jsonb,                                 -- [{due_date, amount}] vindo do XML (cobrança)
  divergence_note text,
  created_by uuid not null references users(id), created_at timestamptz not null default now(),
  finished_by uuid references users(id), finished_at timestamptz,
  unique (company_id, number)
);
create unique index receivings_nf_key_uq on receivings (company_id, nf_key) where nf_key is not null and status <> 'cancelado';
create unique index receivings_nf_supplier_uq on receivings (company_id, supplier_id, nf_number, coalesce(nf_series, '')) where status <> 'cancelado';
create table receiving_items (
  id uuid primary key default gen_random_uuid(),
  receiving_id uuid not null references receivings(id) on delete cascade,
  product_id uuid references products(id),             -- null até mapear o item do XML
  po_item_id uuid references purchase_order_items(id),
  supplier_code text, ean text, description text not null, ncm text, cfop text, unit text,
  qty_nf numeric(14,3) not null check (qty_nf > 0),
  unit_price_nf numeric(14,4) not null,
  ipi numeric(14,2) not null default 0,
  qty_received numeric(14,3),                          -- conferência física
  unit_cost_final numeric(14,4)                        -- preenchido na conclusão
);

-- Base do contas a pagar (Fase 5 estende: pagamento, juros, categorias, centro de custo).
create table payables (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  supplier_id uuid references suppliers(id),
  receiving_id uuid references receivings(id),
  kind text not null default 'titulo' check (kind in ('titulo','credito')),
  installment_no int not null default 1, installments int not null default 1,
  due_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  status text not null default 'aberto' check (status in ('aberto','pago','cancelado')),
  description text,
  paid_at timestamptz, paid_amount numeric(14,2),
  created_at timestamptz not null default now()
);
create index payables_due_idx on payables (company_id, status, due_date);

create table supplier_returns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  branch_id uuid not null references branches(id),
  number int not null,
  supplier_id uuid not null references suppliers(id),
  receiving_id uuid references receivings(id),
  reason text not null,
  total numeric(14,2) not null default 0,
  created_by uuid not null references users(id), created_at timestamptz not null default now(),
  unique (company_id, number)
);
create table supplier_return_items (
  return_id uuid not null references supplier_returns(id) on delete cascade,
  product_id uuid not null references products(id),
  qty numeric(14,3) not null check (qty > 0),
  unit_cost numeric(14,4) not null,
  primary key (return_id, product_id)
);

with grants(role_name, perm) as (
  select r, 'purchases:' || a from (values ('administrador'),('diretor'),('gerente')) as roles_(r), (values ('view'),('create'),('edit'),('delete'),('approve')) as acts(a)
  union all select 'comprador', 'purchases:' || a from unnest(array['view','create','edit','delete']) a
  union all select 'estoquista', 'purchases:' || a from unnest(array['view','create','edit']) a
  union all select r, 'purchases:view' from unnest(array['financeiro','fiscal','expedicao']) r
)
insert into role_permissions (role_id, permission)
select r.id, g.perm from roles r join grants g on g.role_name = r.name where r.is_system
on conflict do nothing;
