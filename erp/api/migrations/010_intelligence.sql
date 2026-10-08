-- FASE 9 — Inteligência: central de alertas por regras (dentro do sistema), recomendações e perguntas.
create table alert_rules (
  company_id uuid not null references companies(id),
  rule_key text not null,
  enabled boolean not null default true,
  params jsonb not null default '{}',
  updated_by uuid references users(id), updated_at timestamptz not null default now(),
  primary key (company_id, rule_key)
);
create table alerts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  rule_key text not null,
  fingerprint text not null,                       -- identifica o "mesmo" problema entre execuções
  severity text not null check (severity in ('critico','atencao','info')),
  title text not null, detail text, link text,
  value numeric(16,2),
  status text not null default 'aberto' check (status in ('aberto','reconhecido','adiado','resolvido')),
  snoozed_until date,
  first_seen timestamptz not null default now(), last_seen timestamptz not null default now(),
  resolved_at timestamptz, handled_by uuid references users(id), handled_at timestamptz, note text,
  unique (company_id, fingerprint)
);
create index alerts_open on alerts (company_id, status, severity);
create table ask_log (
  id bigserial primary key, company_id uuid not null references companies(id), user_id uuid references users(id),
  question text not null, intent text, answered boolean not null, created_at timestamptz not null default now()
);
with grants(role_name, perm) as (
  select r, 'alerts:' || a from (values ('administrador'),('diretor'),('gerente')) as roles_(r), (values ('view'),('create'),('edit'),('delete'),('approve')) as acts(a)
  union all select r, 'alerts:view' from unnest(array['financeiro','comprador','fiscal','estoquista']) r
  union all select r, 'ai:view' from unnest(array['administrador','diretor','gerente','financeiro','comprador','fiscal']) r
)
insert into role_permissions (role_id, permission)
select r.id, g.perm from roles r join grants g on g.role_name = r.name where r.is_system on conflict do nothing;
