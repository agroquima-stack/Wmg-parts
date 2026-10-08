-- FASE 1 — CORE: multiempresa, filiais, usuários/RBAC, sessões, auditoria,
-- cadastros mestres (marcas, categorias, produtos, aplicações, equivalências,
-- clientes, fornecedores).
-- Regra de isolamento: TODA tabela de negócio possui company_id e toda consulta o filtra.

create extension if not exists pg_trgm;
create extension if not exists unaccent;

create table companies (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  trade_name text,
  cnpj text unique,
  is_demo boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  cnpj text,
  is_headquarters boolean not null default false,
  city text, state char(2),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);
create unique index branches_one_hq on branches(company_id) where is_headquarters;

create table roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

create table role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission text not null,               -- ex.: products:view
  primary key (role_id, permission)
);

create table users (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  role_id uuid not null references roles(id),
  name text not null,
  email text not null,
  password_hash text not null,            -- scrypt; nunca texto puro
  active boolean not null default true,
  is_seller boolean not null default false,
  commission_pct numeric(5,2) not null default 0 check (commission_pct between 0 and 100),
  max_discount_pct numeric(5,2) not null default 0 check (max_discount_pct between 0 and 100),
  failed_attempts int not null default 0,
  locked_until timestamptz,
  must_change_password boolean not null default false,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index users_email_uq on users (lower(email));
create index users_company_idx on users (company_id);

create table user_branches (
  user_id uuid not null references users(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade,
  primary key (user_id, branch_id)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  company_id uuid not null references companies(id),
  branch_id uuid references branches(id),
  token_hash text not null unique,        -- SHA-256 do token opaco
  ip text, user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_user_idx on sessions(user_id);

create table audit_log (
  id bigserial primary key,
  company_id uuid not null references companies(id),
  branch_id uuid,
  user_id uuid,
  user_name text,
  entity text not null,
  entity_id text,
  action text not null,                   -- create | update | delete | login | login_failed | ...
  before jsonb,
  after jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_company_time_idx on audit_log (company_id, created_at desc);
create index audit_entity_idx on audit_log (company_id, entity, entity_id);

-- ---------------------------------------------------------------- cadastros
create table brands (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

create table categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  parent_id uuid references categories(id),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, parent_id, name)
);
create index categories_parent_idx on categories(parent_id);

create table products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  sku text not null,
  internal_code text,
  manufacturer_code text,
  original_code text,
  description text not null,
  commercial_description text,
  brand_id uuid references brands(id),
  category_id uuid references categories(id),
  subcategory_id uuid references categories(id),
  unit text not null default 'UN',
  ncm text, cest text,
  origin smallint check (origin between 0 and 8),
  weight_kg numeric(10,3), height_cm numeric(8,2), width_cm numeric(8,2), length_cm numeric(8,2),
  photo_url text,
  active boolean not null default true,
  min_stock numeric(14,3) not null default 0,
  max_stock numeric(14,3) not null default 0,
  ideal_stock numeric(14,3) not null default 0,
  location text,
  -- custos: cost_avg/cost_last serão atualizados pelo módulo de compras (Fase 4)
  cost_current numeric(14,4) not null default 0 check (cost_current >= 0),
  cost_avg numeric(14,4) not null default 0,
  cost_last numeric(14,4) not null default 0,
  sale_price numeric(14,2) not null default 0 check (sale_price >= 0),
  min_price numeric(14,2) not null default 0,
  min_margin_pct numeric(7,4) not null default 0,
  target_margin_pct numeric(7,4) not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, sku)
);
create index products_company_active_idx on products (company_id, active);
create index products_brand_idx on products (brand_id);
create index products_category_idx on products (category_id);
create index products_codes_idx on products (company_id, manufacturer_code, original_code, internal_code);
create index products_desc_trgm on products using gin (description gin_trgm_ops);

create table product_barcodes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  product_id uuid not null references products(id) on delete cascade,
  barcode text not null,
  unique (company_id, barcode)
);
create index product_barcodes_product_idx on product_barcodes(product_id);

-- Equivalências: um produto pertence a no máximo um grupo.
create table equivalence_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  created_at timestamptz not null default now()
);
create table product_equivalences (
  group_id uuid not null references equivalence_groups(id) on delete cascade,
  product_id uuid not null unique references products(id) on delete cascade,
  is_original boolean not null default false,
  primary key (group_id, product_id)
);

-- Motos e aplicações
create table vehicle_models (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  make text not null,                      -- Honda, Yamaha...
  model text not null,                     -- CG 160
  version text,                            -- Titan
  year_from smallint not null check (year_from between 1950 and 2100),
  year_to smallint check (year_to between 1950 and 2100),
  displacement_cc int,
  engine text,
  category text,                           -- street, trail, scooter...
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (year_to is null or year_to >= year_from)
);
create index vehicle_models_company_idx on vehicle_models (company_id, make, model);

create table product_applications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  product_id uuid not null references products(id) on delete cascade,
  vehicle_model_id uuid not null references vehicle_models(id),
  system text,                             -- Sistema de freio
  position text,                           -- Dianteira
  year_from smallint, year_to smallint,    -- opcional: restringe o intervalo do modelo
  notes text,
  unique (product_id, vehicle_model_id, system, position)
);
create index product_applications_model_idx on product_applications(vehicle_model_id);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  legal_name text not null,
  trade_name text,
  cnpj text,
  ie text,
  contact_name text, phone text, email text,
  zip text, street text, number text, complement text, district text, city text, state char(2),
  payment_terms_days int not null default 0,
  lead_time_days int not null default 0,
  freight_type text check (freight_type in ('CIF','FOB')),
  carrier text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, cnpj)
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  type char(2) not null check (type in ('PF','PJ')),
  document text,                           -- CPF ou CNPJ (somente dígitos)
  legal_name text not null,
  trade_name text,
  ie text,
  zip text, street text, number text, complement text, district text, city text, state char(2),
  phone text, whatsapp text, email text,
  segment text,                            -- oficina, lojista, revenda, consumidor...
  seller_id uuid references users(id),
  price_table text not null default 'varejo',
  credit_limit numeric(14,2) not null default 0 check (credit_limit >= 0),
  payment_condition text,
  payment_term_days int not null default 0,
  status text not null default 'ativo' check (status in ('ativo','inativo','bloqueado')),
  notes text,
  created_at timestamptz not null default now(),
  unique (company_id, document)
);
create index customers_company_name_idx on customers (company_id, legal_name);
create index customers_seller_idx on customers (seller_id);
create index customers_name_trgm on customers using gin (legal_name gin_trgm_ops);
