-- FASE 5 — FINANCEIRO: contas bancárias/caixa, movimentos, baixas (parciais), contas a pagar/receber, conciliação, caixa, comissões.

create table cost_centers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null, active boolean not null default true,
  unique (company_id, name)
);
create table finance_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  kind text not null check (kind in ('receita','despesa','imposto','financeira','investimento','estoque','outras')),
  dre_group text,                                -- usado pela DRE (Fase 7)
  active boolean not null default true,
  unique (company_id, name)
);

create table bank_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  kind text not null default 'banco' check (kind in ('banco','caixa','aplicacao')),
  bank_name text, agency text, account_number text,
  opening_balance numeric(14,2) not null default 0,
  opening_date date not null default current_date,
  csv_profile jsonb,                             -- mapeamento de colunas do extrato CSV
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

-- Razão da conta: saldo = saldo inicial + soma dos movimentos.
create table account_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  account_id uuid not null references bank_accounts(id),
  movement_date date not null,
  amount numeric(14,2) not null check (amount <> 0),     -- + entrada / − saída
  kind text not null check (kind in ('recebimento','pagamento','transferencia','tarifa','juros','rendimento','aplicacao','resgate','ajuste','sangria','suprimento','quebra_caixa')),
  description text,
  category_id uuid references finance_categories(id),
  ref_type text, ref_id uuid,                            -- settlement | transfer | cash_session ...
  reversed boolean not null default false,
  created_by uuid references users(id), created_at timestamptz not null default now()
);
create index account_movements_idx on account_movements (company_id, account_id, movement_date);

alter table receivables drop constraint receivables_status_check;
alter table receivables add constraint receivables_status_check check (status in ('aberto','parcial','pago','cancelado','estornado'));
alter table receivables add column category_id uuid references finance_categories(id), add column competence date, add column description text;
alter table payables drop constraint payables_status_check;
alter table payables add constraint payables_status_check check (status in ('aberto','parcial','pago','cancelado'));
alter table payables add column category_id uuid references finance_categories(id), add column cost_center_id uuid references cost_centers(id),
  add column competence date, add column payee_user_id uuid references users(id), add column doc_number text;

-- Baixas (totais ou parciais) de títulos a receber/pagar.
create table settlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  kind text not null check (kind in ('receivable','payable')),
  receivable_id uuid references receivables(id), payable_id uuid references payables(id),
  settle_date date not null,
  principal numeric(14,2) not null check (principal > 0),   -- parcela do título quitada
  discount numeric(14,2) not null default 0 check (discount >= 0),
  interest numeric(14,2) not null default 0 check (interest >= 0),
  fine numeric(14,2) not null default 0 check (fine >= 0),
  fee numeric(14,2) not null default 0 check (fee >= 0),    -- taxa de cartão/gateway (só recebimentos)
  method text, account_id uuid references bank_accounts(id), movement_id uuid references account_movements(id),
  note text, reversed_at timestamptz, reversed_by uuid references users(id),
  created_by uuid references users(id), created_at timestamptz not null default now(),
  check ((kind = 'receivable' and receivable_id is not null) or (kind = 'payable' and payable_id is not null))
);
create index settlements_rec_idx on settlements (receivable_id) where receivable_id is not null;
create index settlements_pay_idx on settlements (payable_id) where payable_id is not null;

-- Linhas do extrato importado (CSV) e sua conciliação com o ERP.
create table bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  account_id uuid not null references bank_accounts(id),
  line_date date not null, description text, amount numeric(14,2) not null, doc_ref text,
  hash text not null,
  status text not null default 'pendente' check (status in ('pendente','conciliado','ignorado')),
  movement_id uuid references account_movements(id),
  reconciled_by uuid references users(id), reconciled_at timestamptz, note text,
  batch_id uuid, created_at timestamptz not null default now(),
  unique (account_id, hash)
);
create index statement_lines_idx on bank_statement_lines (company_id, account_id, status, line_date);

create table cash_sessions (                       -- caixa físico (opcional)
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  account_id uuid not null references bank_accounts(id),
  branch_id uuid references branches(id),
  opened_by uuid not null references users(id), opened_at timestamptz not null default now(), opening_amount numeric(14,2) not null default 0,
  status text not null default 'aberto' check (status in ('aberto','fechado')),
  closed_by uuid references users(id), closed_at timestamptz,
  expected_amount numeric(14,2), counted_amount numeric(14,2), difference numeric(14,2)
);
create unique index cash_sessions_one_open on cash_sessions (account_id) where status = 'aberto';

create table commission_closings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  seller_id uuid not null references users(id),
  up_to date not null, total numeric(14,2) not null, sales_count int not null,
  payable_id uuid references payables(id),
  created_by uuid not null references users(id), created_at timestamptz not null default now()
);
alter table sales add column commission_closing_id uuid references commission_closings(id);

-- Categorias e centros de custo padrão
insert into cost_centers (company_id, name) select c.id, n.name from companies c cross join (values ('Administrativo'),('Comercial'),('Logística'),('Estoque'),('Financeiro'),('Marketing'),('Diretoria'),('Filiais')) as n(name) on conflict do nothing;
insert into finance_categories (company_id, name, kind, dre_group)
select c.id, n.name, n.kind, n.grp from companies c cross join (values
  ('Vendas de mercadorias','receita','receita_bruta'),('Outras receitas','receita','outras_receitas'),
  ('Compra de mercadorias','estoque','estoque'),('Fretes','despesa','desp_comercial'),('Comissões','despesa','desp_comercial'),('Marketing','despesa','desp_comercial'),
  ('Aluguel','despesa','desp_administrativa'),('Salários e encargos','despesa','desp_administrativa'),('Energia, água e internet','despesa','desp_administrativa'),
  ('Contabilidade e serviços','despesa','desp_administrativa'),('Outras despesas administrativas','despesa','desp_administrativa'),
  ('Simples Nacional (DAS)','imposto','impostos'),
  ('Tarifas bancárias','financeira','desp_financeira'),('Juros e multas pagos','financeira','desp_financeira'),('Taxas de cartão e gateway','financeira','desp_financeira'),
  ('Juros e multas recebidos','financeira','rec_financeira'),('Rendimentos de aplicação','financeira','rec_financeira'),('Quebra de caixa','despesa','desp_administrativa')
) as n(name, kind, grp) on conflict do nothing;

-- Receitas e despesas já existentes herdam categoria/competência
update receivables r set category_id = (select id from finance_categories where company_id = r.company_id and name = 'Vendas de mercadorias'), competence = date_trunc('month', r.created_at)::date where category_id is null;
update payables p set category_id = (select id from finance_categories where company_id = p.company_id and name = case when p.receiving_id is not null then 'Compra de mercadorias' else 'Outras despesas administrativas' end), competence = date_trunc('month', p.created_at)::date where category_id is null;

-- Recebíveis já marcados como pagos na Fase 3 passam a ter baixa e movimento numa conta de migração (sem órfãos).
do $$
declare c record; acc uuid; r record; mv uuid;
begin
  for c in select distinct company_id from receivables where status = 'pago' loop
    insert into bank_accounts (company_id, name, kind, bank_name) values (c.company_id, 'Conta padrão (migração)', 'banco', 'Migração') returning id into acc;
    for r in select * from receivables where company_id = c.company_id and status = 'pago' loop
      insert into account_movements (company_id, account_id, movement_date, amount, kind, description, category_id, ref_type)
        values (c.company_id, acc, coalesce(r.paid_at::date, r.created_at::date), coalesce(r.paid_amount, r.amount), 'recebimento', 'Recebimento (migração Fase 3)', r.category_id, 'settlement') returning id into mv;
      insert into settlements (company_id, kind, receivable_id, settle_date, principal, method, account_id, movement_id, note)
        values (c.company_id, 'receivable', r.id, coalesce(r.paid_at::date, r.created_at::date), coalesce(r.paid_amount, r.amount), r.method, acc, mv, 'migração Fase 3');
    end loop;
  end loop;
end $$;

with grants(role_name, perm) as (
  select r, 'finance:' || a from (values ('administrador'),('diretor'),('gerente')) as roles_(r), (values ('view'),('create'),('edit'),('delete'),('approve')) as acts(a)
  union all select 'financeiro', 'finance:' || a from unnest(array['view','create','edit','delete']) a
  union all select r, 'finance:view' from unnest(array['fiscal']) r
)
insert into role_permissions (role_id, permission)
select r.id, g.perm from roles r join grants g on g.role_name = r.name where r.is_system on conflict do nothing;
