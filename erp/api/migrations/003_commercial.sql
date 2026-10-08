-- FASE 3 — COMERCIAL: tabelas de preço, precificação, orçamentos, vendas/PDV/B2B, alçada de desconto.

create table company_settings (
  company_id uuid not null references companies(id),
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (company_id, key)
);

create table doc_counters (
  company_id uuid not null references companies(id),
  kind text not null,
  last int not null default 0,
  primary key (company_id, kind)
);

create table price_tables (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,                       -- casa com customers.price_table
  kind text not null check (kind in ('varejo','oficina','atacado','revenda','especial','marketplace','promocao')),
  valid_from date, valid_to date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);
-- A tabela 'varejo' usa products.sale_price como base; as demais aplicam regras sobre ela.
create table price_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  table_id uuid not null references price_tables(id) on delete cascade,
  scope text not null check (scope in ('all','category','brand','product')),
  scope_id uuid,
  customer_id uuid references customers(id),      -- preço por cliente
  channel text,                                   -- balcao, atacado, b2b, externo, online, marketplace
  min_qty numeric(14,3) not null default 1,       -- preço por quantidade
  fixed_price numeric(14,2) check (fixed_price >= 0),
  adjust_pct numeric(7,3),                        -- sobre o preço de varejo (negativo = desconto)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (fixed_price is not null or adjust_pct is not null),
  check ((scope = 'all') = (scope_id is null))
);
create index price_rules_table_idx on price_rules (table_id, scope, scope_id);

create table quotes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  branch_id uuid not null references branches(id),
  number int not null,
  customer_id uuid not null references customers(id),
  seller_id uuid not null references users(id),
  status text not null default 'rascunho' check (status in ('rascunho','enviado','visualizado','aprovado','recusado','expirado','convertido')),
  valid_until date not null,
  payment_condition text, lead_time_days int, notes text,
  public_token_hash text unique,
  subtotal numeric(14,2) not null default 0, discount_total numeric(14,2) not null default 0, total numeric(14,2) not null default 0,
  converted_sale_id uuid,
  created_at timestamptz not null default now(), sent_at timestamptz, viewed_at timestamptz, decided_at timestamptz,
  unique (company_id, number)
);
create table quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  company_id uuid not null references companies(id),
  product_id uuid not null references products(id),
  qty numeric(14,3) not null check (qty > 0),
  list_price numeric(14,2) not null, discount_pct numeric(7,3) not null default 0 check (discount_pct >= 0 and discount_pct < 100),
  unit_price numeric(14,2) not null, total numeric(14,2) not null
);

create table sales (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  branch_id uuid not null references branches(id),
  number int not null,
  type text not null check (type in ('balcao','atacado','b2b','recorrente','externo','online')),
  channel text not null default 'balcao',
  customer_id uuid references customers(id),       -- null = consumidor final (balcão)
  seller_id uuid not null references users(id),
  status text not null default 'aberto' check (status in ('aguardando_aprovacao','aberto','concluida','cancelada')),
  quote_id uuid references quotes(id), recurring_id uuid,
  subtotal numeric(14,2) not null default 0,       -- a preço de tabela
  discount_total numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  cost_total numeric(14,2) not null default 0,     -- CMV (custo médio global no momento)
  tax_pct numeric(7,3) not null default 0, tax_amount numeric(14,2) not null default 0,   -- estimativa Simples
  margin_total numeric(14,2) not null default 0,   -- total - impostos - CMV
  commission_pct numeric(5,2) not null default 0, commission_amount numeric(14,2) not null default 0,
  notes text,
  created_by uuid not null references users(id), created_at timestamptz not null default now(),
  confirmed_at timestamptz, cancelled_at timestamptz, cancel_reason text,
  unique (company_id, number)
);
create index sales_company_date_idx on sales (company_id, confirmed_at desc);
create index sales_customer_idx on sales (customer_id);
create index sales_seller_idx on sales (seller_id);
create table sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id) on delete cascade,
  company_id uuid not null references companies(id),
  product_id uuid not null references products(id),
  qty numeric(14,3) not null check (qty > 0),
  list_price numeric(14,2) not null, discount_pct numeric(7,3) not null default 0 check (discount_pct >= 0 and discount_pct < 100),
  unit_price numeric(14,2) not null, total numeric(14,2) not null,
  unit_cost numeric(14,4) not null
);
create index sale_items_product_idx on sale_items (product_id);
create table sale_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id) on delete cascade,
  company_id uuid not null references companies(id),
  method text not null check (method in ('dinheiro','pix','cartao_debito','cartao_credito','boleto','crediario')),
  amount numeric(14,2) not null check (amount > 0),
  installments int not null default 1 check (installments between 1 and 24)
);
-- Base do contas a receber (Fase 5 estende com juros, multa, conciliação).
create table receivables (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  sale_id uuid references sales(id),
  customer_id uuid references customers(id),
  installment_no int not null, installments int not null,
  due_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  method text not null,
  status text not null default 'aberto' check (status in ('aberto','pago','cancelado','estornado')),
  paid_at timestamptz, paid_amount numeric(14,2),
  created_at timestamptz not null default now()
);
create index receivables_customer_idx on receivables (company_id, customer_id, status);
create index receivables_due_idx on receivables (company_id, status, due_date);

create table sale_approvals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  sale_id uuid not null references sales(id) on delete cascade,
  violations jsonb not null,
  status text not null default 'pendente' check (status in ('pendente','aprovado','recusado')),
  requested_by uuid not null references users(id), requested_at timestamptz not null default now(),
  decided_by uuid references users(id), decided_at timestamptz, note text
);
create index sale_approvals_status_idx on sale_approvals (company_id, status);

create table recurring_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  branch_id uuid not null references branches(id),
  customer_id uuid not null references customers(id),
  seller_id uuid not null references users(id),
  interval_days int not null check (interval_days between 1 and 365),
  next_run date not null,
  items jsonb not null,                           -- [{product_id, qty, discount_pct}]
  active boolean not null default true,
  last_sale_id uuid, created_at timestamptz not null default now()
);

-- Alçada padrão: 5% de desconto para quem não aprova (gestores com sales:approve não têm teto).
alter table users alter column max_discount_pct set default 5;
update users set max_discount_pct = 5 where max_discount_pct = 0 and role_id in (select id from roles where name in ('vendedor'));

-- Tabelas de preço padrão para empresas existentes
insert into price_tables (company_id, name, kind)
select c.id, t.name, t.name from companies c cross join (values ('varejo'),('oficina'),('atacado'),('revenda'),('especial'),('marketplace')) as t(name)
on conflict do nothing;

-- Permissões dos novos módulos nos perfis padrão existentes
with grants(role_name, perm) as (
  select r, res || ':' || a from (values ('administrador'),('diretor'),('gerente')) as roles_(r)
    cross join (values ('sales'),('quotes'),('pricing')) as m(res)
    cross join (values ('view'),('create'),('edit'),('delete'),('approve')) as acts(a)
  union all select 'vendedor', x from unnest(array['sales:view','sales:create','sales:edit','quotes:view','quotes:create','quotes:edit','pricing:view']) x
  union all select 'comprador', x from unnest(array['sales:view','pricing:view','pricing:edit']) x
  union all select 'financeiro', x from unnest(array['sales:view','quotes:view','pricing:view']) x
  union all select r, 'sales:view' from unnest(array['estoquista','expedicao','fiscal']) r
)
insert into role_permissions (role_id, permission)
select r.id, g.perm from roles r join grants g on g.role_name = r.name where r.is_system
on conflict do nothing;
