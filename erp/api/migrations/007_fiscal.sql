-- FASE 6 — FISCAL: dados fiscais do emitente/destinatário/produto, documentos fiscais (NF-e/NFC-e), eventos, XMLs e obrigações de imposto (DAS).

alter table branches add column ie text, add column im text, add column crt smallint not null default 1 check (crt in (1,2,3)),   -- 1 = Simples Nacional
  add column street text, add column number text, add column complement text, add column district text, add column zip text, add column city_ibge text, add column phone text;
alter table customers add column ie_indicator smallint check (ie_indicator in (1,2,9)),   -- 1 contribuinte, 2 isento, 9 não contribuinte (null = automático)
  add column city_ibge text, add column final_consumer boolean;                           -- null = automático pelo segmento
alter table products add column csosn text check (csosn in ('101','102','103','201','202','203','300','400','500','900'));
alter table receivings add column xml text;

create table fiscal_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  branch_id uuid not null references branches(id),
  sale_id uuid references sales(id),
  original_doc_id uuid references fiscal_documents(id),     -- devolução referencia a nota original
  kind text not null check (kind in ('venda','devolucao_venda')),
  model text not null check (model in ('55','65')),
  status text not null default 'rascunho' check (status in ('rascunho','autorizada','cancelada','rejeitada')),
  environment text not null default 'homologacao' check (environment in ('homologacao','producao')),
  series int, number int, access_key text, protocol text,
  issued_at timestamptz, authorized_at timestamptz,
  total numeric(14,2) not null default 0,
  payload jsonb not null,                                    -- documento fiscal normalizado (emitente, destinatário, itens, totais, pagamentos...)
  validation jsonb not null default '{"errors":[],"warnings":[]}',
  provider text not null, provider_message text, simulated boolean not null default false,
  xml text,
  cancel_reason text, cancelled_at timestamptz, cancel_protocol text,
  created_by uuid not null references users(id), created_at timestamptz not null default now()
);
create unique index fiscal_docs_access_key_uq on fiscal_documents (company_id, access_key) where access_key is not null;
create unique index fiscal_docs_number_uq on fiscal_documents (company_id, environment, model, series, number) where number is not null and status <> 'rascunho';
create unique index fiscal_docs_active_sale_uq on fiscal_documents (sale_id, kind) where sale_id is not null and original_doc_id is null and status in ('rascunho','autorizada');
create index fiscal_docs_status_idx on fiscal_documents (company_id, status, created_at desc);

create table fiscal_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  document_id uuid not null references fiscal_documents(id) on delete cascade,
  type text not null check (type in ('autorizacao','registro_manual','cancelamento','cce','rejeicao')),
  seq int not null default 1, text text, protocol text, xml text,
  created_by uuid references users(id), created_at timestamptz not null default now()
);

create table tax_obligations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  tax text not null default 'DAS',
  competence date not null,                                  -- primeiro dia do mês de competência
  estimated_amount numeric(14,2) not null,                   -- estimativa pelo faturamento
  amount numeric(14,2),                                      -- valor oficial da guia (informado pelo contador/PGDAS-D)
  due_date date not null,
  status text not null default 'previsto' check (status in ('previsto','a_pagar','pago','cancelado')),
  guide_ref text, receipt_note text,
  revenue numeric(14,2) not null default 0, effective_rate numeric(7,4), rbt12 numeric(14,2), method text,
  payable_id uuid references payables(id),
  created_by uuid references users(id), created_at timestamptz not null default now(),
  unique (company_id, tax, competence)
);

with grants(role_name, perm) as (
  select r, 'fiscal:' || a from (values ('administrador'),('diretor'),('gerente'),('fiscal')) as roles_(r), (values ('view'),('create'),('edit'),('delete'),('approve')) as acts(a)
  union all select r, 'fiscal:view' from unnest(array['financeiro']) r
)
insert into role_permissions (role_id, permission)
select r.id, g.perm from roles r join grants g on g.role_name = r.name where r.is_system on conflict do nothing;
