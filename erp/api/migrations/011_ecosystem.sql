-- FASE 10 — Ecossistema: marketplace (estrutura independente de canal) e compartilhamento por link de WhatsApp.
alter table sale_payments drop constraint if exists sale_payments_method_check;
alter table sale_payments add constraint sale_payments_method_check check (method in ('dinheiro','pix','cartao_debito','cartao_credito','boleto','crediario','marketplace'));

create table marketplaces (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  commission_pct numeric(6,3) not null default 0 check (commission_pct >= 0 and commission_pct < 100),
  fixed_fee numeric(10,2) not null default 0 check (fixed_fee >= 0),        -- taxa fixa por pedido
  shipping_cost numeric(10,2) not null default 0 check (shipping_cost >= 0), -- frete médio pago pelo vendedor, por pedido
  payout_days int not null default 14 check (payout_days between 0 and 120),
  notes text, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (company_id, name)
);
create table marketplace_listings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  marketplace_id uuid not null references marketplaces(id) on delete cascade,
  product_id uuid not null references products(id),
  external_sku text,
  price numeric(14,2) not null check (price > 0),
  stock_buffer numeric(14,3) not null default 0 check (stock_buffer >= 0),   -- reserva de segurança: não publicar
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (marketplace_id, product_id)
);
create table marketplace_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  marketplace_id uuid not null references marketplaces(id),
  external_order_id text not null,
  sale_id uuid not null unique references sales(id),
  gross numeric(14,2) not null, commission numeric(14,2) not null default 0, fixed_fee numeric(14,2) not null default 0, shipping_cost numeric(14,2) not null default 0,
  expected_net numeric(14,2) not null,
  payout_date date not null,
  status text not null default 'a_receber' check (status in ('a_receber','recebido','cancelado')),
  received_at timestamptz, received_net numeric(14,2),
  created_by uuid references users(id), created_at timestamptz not null default now(),
  unique (marketplace_id, external_order_id)
);
create index marketplace_orders_status on marketplace_orders (company_id, status, payout_date);

with grants(role_name, perm) as (
  select r, 'marketplace:' || a from (values ('administrador'),('diretor'),('gerente')) as roles_(r), (values ('view'),('create'),('edit'),('delete'),('approve')) as acts(a)
  union all select r, 'marketplace:view' from unnest(array['financeiro','comprador','fiscal','estoquista']) r
  union all select 'financeiro', 'marketplace:edit'
  union all select 'vendedor', 'marketplace:view'
)
insert into role_permissions (role_id, permission)
select r.id, g.perm from roles r join grants g on g.role_name = r.name where r.is_system on conflict do nothing;
