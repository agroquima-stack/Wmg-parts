-- Recebimento de mercadoria vira recurso próprio: o estoquista confere e dá entrada, sem emitir pedidos de compra.
delete from role_permissions rp using roles r where rp.role_id = r.id and r.is_system and r.name = 'estoquista' and rp.permission in ('purchases:create','purchases:edit');
with grants(role_name, perm) as (
  select r, 'receiving:' || a from (values ('administrador'),('diretor'),('gerente')) as roles_(r), (values ('view'),('create'),('edit'),('delete'),('approve')) as acts(a)
  union all select 'comprador', 'receiving:' || a from unnest(array['view','create','edit','delete']) a
  union all select 'estoquista', 'receiving:' || a from unnest(array['view','create','edit']) a
  union all select r, 'receiving:view' from unnest(array['financeiro','fiscal']) r
)
insert into role_permissions (role_id, permission)
select r.id, g.perm from roles r join grants g on g.role_name = r.name where r.is_system
on conflict do nothing;
