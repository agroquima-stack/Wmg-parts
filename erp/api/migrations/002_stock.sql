-- FASE 2 — ESTOQUE: saldos por filial/status, movimentações imutáveis, transferências, inventário.
create table stock_balances (
  company_id uuid not null references companies(id),
  product_id uuid not null references products(id),
  branch_id uuid not null references branches(id),
  status text not null check (status in ('disponivel','reservado','transito','avariado','quarentena','consignado')),
  qty numeric(14,3) not null default 0 check (qty >= 0),
  updated_at timestamptz not null default now(),
  primary key (product_id, branch_id, status)
);
create index stock_balances_company_branch_idx on stock_balances (company_id, branch_id);

-- Histórico append-only: todo saldo tem origem rastreável.
create table stock_movements (
  id bigserial primary key,
  company_id uuid not null references companies(id),
  branch_id uuid not null references branches(id),
  product_id uuid not null references products(id),
  type text not null,                         -- entrada, saida, ajuste, reserva, liberacao, bloqueio, desbloqueio, avaria,
                                              -- transferencia_saida, transferencia_recebimento, inventario
  from_status text, to_status text,           -- null = fora do estoque (entrada/saída externa)
  qty numeric(14,3) not null check (qty > 0),
  qty_before numeric(14,3) not null,          -- saldo do status afetado antes
  qty_after numeric(14,3) not null,           -- ... e depois
  unit_cost numeric(14,4),
  document_type text, document_ref text,      -- NF, venda, transferência, inventário...
  origin text, destination text,
  reason text,
  user_id uuid references users(id), user_name text,
  created_at timestamptz not null default now()
);
create index stock_mov_product_idx on stock_movements (company_id, product_id, created_at desc);
create index stock_mov_branch_idx on stock_movements (company_id, branch_id, created_at desc);
create function stock_movements_immutable() returns trigger language plpgsql as
$$ begin raise exception 'stock_movements é imutável'; end $$;
create trigger stock_movements_no_change before update or delete on stock_movements
  for each row execute function stock_movements_immutable();

create table stock_transfers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  from_branch_id uuid not null references branches(id),
  to_branch_id uuid not null references branches(id),
  status text not null default 'em_transito' check (status in ('em_transito','recebida','cancelada')),
  note text,
  created_by uuid references users(id), created_at timestamptz not null default now(),
  received_by uuid references users(id), received_at timestamptz,
  check (from_branch_id <> to_branch_id)
);
create table stock_transfer_items (
  transfer_id uuid not null references stock_transfers(id) on delete cascade,
  product_id uuid not null references products(id),
  qty numeric(14,3) not null check (qty > 0),
  primary key (transfer_id, product_id)
);

create table inventories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  branch_id uuid not null references branches(id),
  type text not null check (type in ('geral','rotativo')),
  status text not null default 'aberto' check (status in ('aberto','fechado','cancelado')),
  note text,
  created_by uuid references users(id), created_at timestamptz not null default now(),
  closed_by uuid references users(id), closed_at timestamptz
);
create table inventory_items (
  inventory_id uuid not null references inventories(id) on delete cascade,
  product_id uuid not null references products(id),
  system_qty numeric(14,3) not null,          -- foto do saldo disponível na abertura
  counted_qty numeric(14,3) check (counted_qty >= 0),
  primary key (inventory_id, product_id)
);

-- Concede as permissões de estoque aos perfis padrão das empresas já existentes.
insert into role_permissions (role_id, permission)
select r.id, p.perm from roles r join (values
  ('administrador','stock:view'),('administrador','stock:create'),('administrador','stock:edit'),('administrador','stock:delete'),('administrador','stock:approve'),
  ('diretor','stock:view'),('diretor','stock:create'),('diretor','stock:edit'),('diretor','stock:delete'),('diretor','stock:approve'),
  ('gerente','stock:view'),('gerente','stock:create'),('gerente','stock:edit'),('gerente','stock:delete'),('gerente','stock:approve'),
  ('estoquista','stock:view'),('estoquista','stock:create'),('estoquista','stock:edit'),
  ('expedicao','stock:view'),('expedicao','stock:create'),
  ('financeiro','stock:view'),('vendedor','stock:view'),('comprador','stock:view'),('fiscal','stock:view')
) as p(role_name, perm) on p.role_name = r.name and r.is_system
on conflict do nothing;
