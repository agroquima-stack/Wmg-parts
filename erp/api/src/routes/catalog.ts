import type { FastifyInstance } from 'fastify';
import { registerCrud } from '../crud.js';
import { brandSchema, categorySchema, customerCheck, customerSchema, vehicleCheck, supplierSchema, vehicleSchema } from '../schemas.js';

export async function catalogRoutes(app: FastifyInstance) {
  registerCrud(app, { path: '/brands', table: 'brands', entity: 'brand', perm: 'brands', schema: brandSchema,
    searchCols: ['name'], orderBy: 't.name', hasActive: true });
  registerCrud(app, { path: '/categories', table: 'categories', entity: 'category', perm: 'categories', schema: categorySchema,
    searchCols: ['name'], orderBy: 't.name', filters: ['parent_id'], refs: { parent_id: 'categories' }, hasActive: true });
  registerCrud(app, { path: '/vehicle-models', table: 'vehicle_models', entity: 'vehicle_model', perm: 'vehicles', schema: vehicleSchema, check: vehicleCheck,
    searchCols: ['make', 'model', 'version'], orderBy: 't.make, t.model, t.year_from', filters: ['make'], hasActive: true });
  registerCrud(app, { path: '/suppliers', table: 'suppliers', entity: 'supplier', perm: 'suppliers', schema: supplierSchema,
    searchCols: ['legal_name', 'trade_name', 'cnpj', 'city'], orderBy: 't.legal_name', hasActive: true });
  registerCrud(app, { path: '/customers', table: 'customers', entity: 'customer', perm: 'customers', schema: customerSchema, check: customerCheck,
    searchCols: ['legal_name', 'trade_name', 'document', 'phone', 'whatsapp', 'city'], orderBy: 't.legal_name',
    filters: ['status', 'segment', 'seller_id', 'type'], refs: { seller_id: 'users' } });
}
