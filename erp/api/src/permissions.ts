export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve'] as const;
export type Action = (typeof ACTIONS)[number];

/** Catálogo de recursos (módulo/tela). Novas fases acrescentam recursos aqui. */
export const RESOURCES = [
  'products', 'brands', 'categories', 'vehicles', 'equivalences',
  'customers', 'suppliers', 'stock', 'users', 'roles', 'branches', 'audit', 'settings',
] as const;

export const ALL_PERMISSIONS = RESOURCES.flatMap((r) => ACTIONS.map((a) => `${r}:${a}`));

const all = (res: readonly string[], acts: readonly Action[] = ACTIONS) =>
  res.flatMap((r) => acts.map((a) => `${r}:${a}`));
const view = (res: readonly string[]) => all(res, ['view']);
const crud = (res: readonly string[]) => all(res, ['view', 'create', 'edit', 'delete']);
const catalogRes = ['products', 'brands', 'categories', 'vehicles', 'equivalences'];

/** Perfis padrão criados para cada empresa. */
export const DEFAULT_ROLES: Record<string, { description: string; permissions: string[] }> = {
  administrador: { description: 'Acesso total', permissions: ALL_PERMISSIONS },
  diretor: { description: 'Visão e aprovação em todos os módulos', permissions: [...ALL_PERMISSIONS.filter((p) => !p.startsWith('roles:') || p.endsWith(':view'))] },
  gerente: { description: 'Gestão operacional', permissions: [...crud(catalogRes), ...all(['stock']), ...crud(['customers', 'suppliers']), ...all(['products', 'customers', 'suppliers'], ['approve']), ...view(['users', 'audit', 'branches'])] },
  financeiro: { description: 'Financeiro', permissions: [...view(['stock']), ...view([...catalogRes]), ...crud(['customers', 'suppliers']), ...view(['audit'])] },
  vendedor: { description: 'Vendas', permissions: [...view(['stock']), ...view(catalogRes), ...view(['suppliers']), ...all(['customers'], ['view', 'create', 'edit'])] },
  comprador: { description: 'Compras', permissions: [...view(['stock']), ...crud(catalogRes), ...crud(['suppliers']), ...view(['customers'])] },
  estoquista: { description: 'Estoque', permissions: [...all(['stock'], ['view','create','edit']), ...view(catalogRes), ...all(['products'], ['edit']), ...view(['suppliers'])] },
  fiscal: { description: 'Fiscal', permissions: [...view(['stock']), ...view(catalogRes), ...all(['products'], ['edit']), ...view(['customers', 'suppliers', 'audit'])] },
  expedicao: { description: 'Expedição', permissions: [...view(['stock']), ...all(['stock'], ['create']), ...view(catalogRes), ...view(['customers'])] },
};
