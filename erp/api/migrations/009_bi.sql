-- FASE 8 — BI: metas configuráveis (geral, por vendedor, por categoria; padrão ou por mês).
create table goals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  kind text not null check (kind in ('faturamento','margem_bruta_pct','ticket_medio','giro_estoque','cobertura_dias_max','inadimplencia_max_pct')),
  scope_type text not null default 'company' check (scope_type in ('company','seller','category')),
  scope_id uuid,                                    -- vendedor (users) ou categoria
  month date,                                       -- null = meta padrão para todos os meses
  target numeric(14,2) not null check (target >= 0),
  updated_by uuid references users(id), updated_at timestamptz not null default now(),
  check ((scope_type = 'company') = (scope_id is null))
);
create unique index goals_uq on goals (company_id, kind, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(month, date '1900-01-01'));

-- A meta mensal de faturamento que existia nos parâmetros passa a viver aqui.
insert into goals (company_id, kind, scope_type, target)
select company_id, 'faturamento', 'company', (value->>'monthly')::numeric from company_settings where key = 'goal' and coalesce((value->>'monthly')::numeric, 0) > 0
on conflict do nothing;

with grants(role_name, perm) as (
  select r, 'bi:' || a from (values ('administrador'),('diretor'),('gerente')) as roles_(r), (values ('view'),('create'),('edit'),('delete'),('approve')) as acts(a)
  union all select r, 'bi:view' from unnest(array['financeiro','comprador','fiscal']) r
)
insert into role_permissions (role_id, permission)
select r.id, g.perm from roles r join grants g on g.role_name = r.name where r.is_system on conflict do nothing;
