-- FASE 7 — CONTROLADORIA: plano de contas, razão de partidas dobradas (imutável e balanceado), mapeamento das categorias financeiras.

create table ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null, name text not null,
  type text not null check (type in ('ativo','passivo','pl','receita','deducao','custo','despesa','outros')),
  dre_group text,                                   -- receita_bruta, deducoes, impostos, cmv, desp_comercial, desp_administrativa, desp_financeira, rec_financeira, outros
  system_key text,                                  -- chave estável usada pelos lançamentos automáticos (a empresa pode renumerar/renomear)
  parent_id uuid references ledger_accounts(id),
  is_system boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);
create unique index ledger_accounts_key_uq on ledger_accounts (company_id, system_key) where system_key is not null;

create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  entry_date date not null,
  competence date not null,                         -- 1º dia do mês de competência (a DRE usa este campo)
  description text not null,
  kind text not null default 'sistema' check (kind in ('sistema','manual','abertura')),
  ref_type text, ref_id text,                       -- id da origem (uuid ou bigint em texto)
  reversal_of uuid references journal_entries(id),
  created_by uuid references users(id), created_at timestamptz not null default now()
);
create unique index journal_entries_ref_uq on journal_entries (company_id, ref_type, ref_id) where ref_id is not null;
create index journal_entries_date_idx on journal_entries (company_id, entry_date);
create index journal_entries_comp_idx on journal_entries (company_id, competence);

create table journal_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references journal_entries(id),
  company_id uuid not null references companies(id),
  account_id uuid not null references ledger_accounts(id),
  debit numeric(14,2) not null default 0 check (debit >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  -- dimensões para a DRE por filial, canal, cliente, produto, marca e categoria
  branch_id uuid, channel text, customer_id uuid, product_id uuid, brand_id uuid, category_id uuid, seller_id uuid,
  finance_category_id uuid, cost_center_id uuid, supplier_id uuid, bank_account_id uuid,
  description text,
  check ((debit > 0) <> (credit > 0))
);
create index journal_lines_account_idx on journal_lines (company_id, account_id);
create index journal_lines_entry_idx on journal_lines (entry_id);
create index journal_lines_bank_idx on journal_lines (bank_account_id) where bank_account_id is not null;

-- O razão é imutável: correção só por estorno (novo lançamento).
create function journal_immutable() returns trigger language plpgsql as $$ begin raise exception 'O razão contábil é imutável: faça um estorno.'; end $$;
create trigger journal_lines_no_change before update or delete on journal_lines for each row execute function journal_immutable();
create trigger journal_entries_no_change before update or delete on journal_entries for each row execute function journal_immutable();
-- Partidas dobradas garantidas pelo banco: ao fim da transação, débitos = créditos em cada lançamento.
create function journal_check_balanced() returns trigger language plpgsql as $$
declare d numeric; c numeric;
begin
  select coalesce(sum(debit),0), coalesce(sum(credit),0) into d, c from journal_lines where entry_id = new.entry_id;
  if d <> c then raise exception 'Lançamento contábil desbalanceado (débitos % ≠ créditos %)', d, c; end if;
  return null;
end $$;
create constraint trigger journal_lines_balanced after insert on journal_lines deferrable initially deferred for each row execute function journal_check_balanced();

alter table finance_categories add column ledger_account_id uuid references ledger_accounts(id);

-- Plano de contas padrão (uma única fonte: usada para empresas existentes e novas)
create function seed_chart(p_company uuid) returns void language plpgsql as $$
declare r record;
begin
  for r in select * from (values
    ('1.1.1.01','Caixa','ativo',null,'caixa'),('1.1.1.02','Bancos conta movimento','ativo',null,'bancos'),('1.1.1.03','Aplicações financeiras','ativo',null,'aplicacoes'),
    ('1.1.1.09','Transferências entre contas (a compensar)','ativo',null,'transferencias'),('1.1.2.01','Clientes — contas a receber','ativo',null,'contas_receber'),
    ('1.1.3.01','Estoque de mercadorias para revenda','ativo',null,'estoques'),('1.1.4.01','Créditos e diferenças com fornecedores','ativo',null,'creditos_fornecedores'),('1.2.1.01','Imobilizado','ativo',null,'imobilizado'),
    ('2.1.1.01','Fornecedores','passivo',null,'fornecedores'),('2.1.2.01','Comissões a pagar','passivo',null,'comissoes_pagar'),('2.1.3.01','Simples Nacional (DAS) a recolher','passivo',null,'obrigacoes_trib'),
    ('2.1.4.01','Outras contas a pagar','passivo',null,'outras_pagar'),('2.1.5.01','Clientes — valores a restituir','passivo',null,'clientes_restituir'),('2.2.1.01','Empréstimos e financiamentos','passivo',null,'emprestimos'),
    ('2.3.1.01','Capital social','pl',null,'capital'),('2.3.2.01','Reservas','pl',null,'reservas'),('2.3.3.01','Lucros / prejuízos acumulados','pl',null,'lucros_acumulados'),('2.3.4.01','Ajustes de abertura a classificar','pl',null,'ajustes_abertura'),
    ('3.1.1.01','Receita de vendas de mercadorias','receita','receita_bruta','receita_vendas'),('3.1.2.01','(-) Devoluções e cancelamentos de vendas','deducao','deducoes','devolucoes'),
    ('3.1.3.01','(-) Descontos e abatimentos concedidos','deducao','deducoes','descontos_concedidos'),('3.2.1.01','(-) Impostos sobre vendas (Simples Nacional)','deducao','impostos','impostos_vendas'),
    ('4.1.1.01','Custo das mercadorias vendidas','custo','cmv','cmv'),('4.1.2.01','Perdas e ajustes de estoque','custo','cmv','perdas_estoque'),
    ('5.1.1.01','Comissões de vendas','despesa','desp_comercial','desp_comissoes'),('5.1.2.01','Fretes e entregas','despesa','desp_comercial','desp_fretes'),('5.1.3.01','Marketing e publicidade','despesa','desp_comercial','desp_marketing'),('5.1.9.01','Outras despesas comerciais','despesa','desp_comercial','desp_comerciais_outras'),
    ('5.2.1.01','Aluguel','despesa','desp_administrativa','desp_aluguel'),('5.2.2.01','Salários e encargos','despesa','desp_administrativa','desp_salarios'),('5.2.3.01','Energia, água e internet','despesa','desp_administrativa','desp_utilidades'),
    ('5.2.4.01','Contabilidade e serviços','despesa','desp_administrativa','desp_servicos'),('5.2.5.01','Quebra de caixa','despesa','desp_administrativa','desp_quebra_caixa'),('5.2.9.01','Outras despesas administrativas','despesa','desp_administrativa','desp_adm_outras'),
    ('5.3.1.01','Tarifas bancárias','despesa','desp_financeira','desp_tarifas'),('5.3.2.01','Juros e multas pagos','despesa','desp_financeira','desp_juros'),('5.3.3.01','Taxas de cartão e gateway','despesa','desp_financeira','desp_taxas_cartao'),
    ('6.1.1.01','Juros e multas recebidos','receita','rec_financeira','rec_juros'),('6.1.2.01','Rendimentos de aplicação','receita','rec_financeira','rec_rendimentos'),('6.1.3.01','Descontos obtidos','receita','rec_financeira','rec_descontos_obtidos'),
    ('7.1.1.01','Outras receitas','receita','outros','outras_receitas'),('7.1.2.01','Outras despesas e ajustes','despesa','outros','outras_despesas')
  ) as t(code, name, type, grp, key) loop
    insert into ledger_accounts (company_id, code, name, type, dre_group, system_key, is_system) values (p_company, r.code, r.name, r.type, r.grp, r.key, true) on conflict do nothing;
  end loop;
  -- categorias financeiras novas e vínculo categoria → conta contábil
  insert into finance_categories (company_id, name, kind, dre_group) values (p_company, 'Restituições a clientes', 'outras', null), (p_company, 'Aquisição de imobilizado', 'investimento', null) on conflict do nothing;
  update finance_categories c set ledger_account_id = (select a.id from ledger_accounts a where a.company_id = p_company and a.system_key = m.key)
    from (values ('Vendas de mercadorias','receita_vendas'),('Outras receitas','outras_receitas'),('Fretes','desp_fretes'),('Comissões','desp_comissoes'),('Marketing','desp_marketing'),('Aluguel','desp_aluguel'),
      ('Salários e encargos','desp_salarios'),('Energia, água e internet','desp_utilidades'),('Contabilidade e serviços','desp_servicos'),('Outras despesas administrativas','desp_adm_outras'),
      ('Simples Nacional (DAS)','obrigacoes_trib'),('Tarifas bancárias','desp_tarifas'),('Juros e multas pagos','desp_juros'),('Taxas de cartão e gateway','desp_taxas_cartao'),
      ('Juros e multas recebidos','rec_juros'),('Rendimentos de aplicação','rec_rendimentos'),('Quebra de caixa','desp_quebra_caixa'),('Restituições a clientes','clientes_restituir'),
      ('Aquisição de imobilizado','imobilizado'),('Compra de mercadorias','estoques')) as m(name, key)
   where c.company_id = p_company and c.name = m.name and c.ledger_account_id is null;
end $$;
select seed_chart(id) from companies;

with grants(role_name, perm) as (
  select r, 'accounting:' || a from (values ('administrador'),('diretor'),('gerente')) as roles_(r), (values ('view'),('create'),('edit'),('delete'),('approve')) as acts(a)
  union all select 'financeiro', 'accounting:' || a from unnest(array['view','create','edit']) a
  union all select 'fiscal', 'accounting:view'
)
insert into role_permissions (role_id, permission)
select r.id, g.perm from roles r join grants g on g.role_name = r.name where r.is_system on conflict do nothing;
