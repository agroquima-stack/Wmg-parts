-- FASE 11 — Devoluções, garantias e fechamento contábil.
alter table products add column warranty_days int check (warranty_days is null or warranty_days between 0 and 3650);

create table sale_returns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  branch_id uuid not null references branches(id),
  number int not null,
  sale_id uuid not null references sales(id),
  customer_id uuid references customers(id),
  reason text not null, notes text,
  total numeric(14,2) not null, cost_total numeric(14,2) not null, tax_total numeric(14,2) not null default 0, commission_reversal numeric(14,2) not null default 0,
  abated numeric(14,2) not null default 0,            -- parte abatida de títulos em aberto da venda
  refunded numeric(14,2) not null default 0,          -- parte a restituir ao cliente (contas a pagar)
  refund_payable_id uuid references payables(id),
  requires_fiscal_return boolean not null default false,
  warranty_claim_id uuid,
  created_by uuid not null references users(id), created_at timestamptz not null default now(),
  unique (company_id, number)
);
create table sale_return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references sale_returns(id) on delete cascade,
  company_id uuid not null references companies(id),
  sale_item_id uuid not null references sale_items(id),
  product_id uuid not null references products(id),
  qty numeric(14,3) not null check (qty > 0),
  unit_price numeric(14,2) not null, unit_cost numeric(14,4) not null, total numeric(14,2) not null,
  condition text not null check (condition in ('revenda','avariado'))
);
create index sale_return_items_item on sale_return_items (sale_item_id);

create table warranty_claims (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  branch_id uuid not null references branches(id),
  number int not null,
  sale_id uuid references sales(id), sale_item_id uuid references sale_items(id),
  customer_id uuid references customers(id),
  product_id uuid not null references products(id),
  qty numeric(14,3) not null check (qty > 0),
  defect text not null,
  purchased_at date, warranty_days int not null, in_warranty boolean,       -- null = sem data de compra conhecida
  status text not null default 'aberta' check (status in ('aberta','em_analise','recusada','resolvida')),
  resolution text check (resolution in ('troca','reembolso','reparo','recusa')),
  goodwill boolean not null default false,                                 -- concessão comercial fora do prazo
  decision_note text, resolved_by uuid references users(id), resolved_at timestamptz,
  return_id uuid references sale_returns(id),
  defective_pending numeric(14,3) not null default 0, defective_unit_cost numeric(14,4),   -- unidades defeituosas em estoque "avariado" aguardando o fornecedor
  supplier_id uuid references suppliers(id),
  supplier_status text not null default 'nenhum' check (supplier_status in ('nenhum','credito','recusado')),
  supplier_amount numeric(14,2), supplier_at timestamptz,
  created_by uuid not null references users(id), created_at timestamptz not null default now(),
  unique (company_id, number)
);
create index warranty_status on warranty_claims (company_id, status);

create table accounting_periods (
  company_id uuid not null references companies(id),
  period date not null check (period = date_trunc('month', period)::date),
  status text not null default 'fechado' check (status in ('fechado','aberto')),
  closed_by uuid references users(id), closed_at timestamptz,
  snapshot jsonb, entries_count int, total_debits numeric(16,2), checksum text, note text,
  reopened_by uuid references users(id), reopened_at timestamptz, reopen_reason text,
  primary key (company_id, period)
);
-- O banco recusa lançamentos (data ou competência) em período fechado: nenhuma rotina do sistema consegue contornar.
create function enforce_open_period() returns trigger language plpgsql as $$
declare p date;
begin
  foreach p in array array[date_trunc('month', new.entry_date)::date, new.competence] loop
    if exists (select 1 from accounting_periods where company_id = new.company_id and period = p and status = 'fechado') then
      raise exception 'PERIODO_FECHADO:%', to_char(p, 'MM/YYYY') using errcode = 'P0001';
    end if;
  end loop;
  return new;
end $$;
create trigger journal_entries_period before insert on journal_entries for each row execute function enforce_open_period();

with grants(role_name, perm) as (
  select r, 'returns:' || a from (values ('administrador'),('diretor'),('gerente')) as roles_(r), (values ('view'),('create'),('edit'),('delete'),('approve')) as acts(a)
  union all select r, 'returns:view' from unnest(array['financeiro','fiscal','comprador','vendedor']) r
  union all select 'estoquista', 'returns:view' union all select 'estoquista', 'returns:create' union all select 'vendedor', 'returns:create'
)
insert into role_permissions (role_id, permission)
select r.id, g.perm from roles r join grants g on g.role_name = r.name where r.is_system on conflict do nothing;
