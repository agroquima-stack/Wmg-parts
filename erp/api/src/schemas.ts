import { z } from 'zod';
import { digits, isValidCNPJ, isValidCPF } from './lib/documents.js';

export const text = (max = 200) => z.string().trim().max(max).nullish().transform((v) => v || null);
export const reqText = (max = 200) => z.string().trim().min(1, 'Obrigatório').max(max);
export const uuidN = z.string().uuid().nullish().transform((v) => v || null);
export const money = z.coerce.number().min(0).max(1e10);
export const uf = z.string().trim().length(2).toUpperCase().nullish().transform((v) => v || null);
const optMoney = money.optional();

const address = {
  zip: text(10), street: text(), number: text(20), complement: text(), district: text(), city: text(), state: uf,
};

export const brandSchema = z.object({ name: reqText(), active: z.boolean().optional() });
export const categorySchema = z.object({ name: reqText(), parent_id: uuidN, active: z.boolean().optional() });

export const vehicleSchema = z.object({
  make: reqText(60), model: reqText(80), version: text(80),
  year_from: z.coerce.number().int().min(1950).max(2100),
  year_to: z.coerce.number().int().min(1950).max(2100).nullish().transform((v) => v ?? null),
  displacement_cc: z.coerce.number().int().min(0).nullish().transform((v) => v ?? null),
  engine: text(80), category: text(60), active: z.boolean().optional(),
});

/** Regras entre campos: executadas com o registro já mesclado (criação ou edição parcial). */
export const vehicleCheck = (v: Record<string, unknown>) => {
  if (v.year_to != null && Number(v.year_to) < Number(v.year_from)) return 'Ano final menor que o inicial.';
  return null;
};
export const customerCheck = (v: Record<string, unknown>) => {
  if (v.document == null) return null;
  const doc = String(v.document);
  return (v.type === 'PF' ? isValidCPF(doc) : isValidCNPJ(doc)) ? null : (v.type === 'PF' ? 'CPF inválido.' : 'CNPJ inválido.');
};

export const supplierSchema = z.object({
  legal_name: reqText(), trade_name: text(), ie: text(30),
  cnpj: z.string().trim().nullish().transform((v) => (v ? digits(v) : null))
    .refine((v) => v == null || isValidCNPJ(v), 'CNPJ inválido'),
  contact_name: text(), phone: text(30), email: z.string().trim().email().nullish().transform((v) => v || null),
  ...address,
  payment_terms_days: z.coerce.number().int().min(0).max(365).optional(),
  lead_time_days: z.coerce.number().int().min(0).max(365).optional(),
  freight_type: z.enum(['CIF', 'FOB']).nullish().transform((v) => v ?? null),
  carrier: text(), notes: text(2000), active: z.boolean().optional(),
});

export const customerSchema = z.object({
  type: z.enum(['PF', 'PJ']),
  document: z.string().trim().nullish().transform((v) => (v ? digits(v) : null)),
  legal_name: reqText(), trade_name: text(), ie: text(30),
  ...address,
  phone: text(30), whatsapp: text(30), email: z.string().trim().email().nullish().transform((v) => v || null),
  segment: text(60), seller_id: uuidN,
  ie_indicator: z.coerce.number().refine((v) => [1, 2, 9].includes(v)).nullish().transform((v) => v ?? null), city_ibge: text(7), final_consumer: z.boolean().nullish().transform((v) => v ?? null),
  price_table: z.string().trim().min(1).max(40).optional(),
  credit_limit: optMoney,
  payment_condition: text(80),
  payment_term_days: z.coerce.number().int().min(0).max(365).optional(),
  status: z.enum(['ativo', 'inativo', 'bloqueado']).optional(),
  notes: text(2000),
});

export const productSchema = z.object({
  sku: reqText(60), internal_code: text(60), manufacturer_code: text(60), original_code: text(60),
  description: reqText(300), commercial_description: text(500),
  brand_id: uuidN, category_id: uuidN, subcategory_id: uuidN,
  unit: z.string().trim().min(1).max(10).optional(),
  ncm: z.string().trim().nullish().transform((v) => (v ? digits(v) : null)).refine((v) => v == null || v.length === 8, 'NCM deve ter 8 dígitos'),
  cest: text(10), csosn: z.enum(['101', '102', '103', '201', '202', '203', '300', '400', '500', '900']).nullish().transform((v) => v ?? null), origin: z.coerce.number().int().min(0).max(8).nullish().transform((v) => v ?? null),
  weight_kg: z.coerce.number().min(0).nullish().transform((v) => v ?? null),
  height_cm: z.coerce.number().min(0).nullish().transform((v) => v ?? null),
  width_cm: z.coerce.number().min(0).nullish().transform((v) => v ?? null),
  length_cm: z.coerce.number().min(0).nullish().transform((v) => v ?? null),
  photo_url: text(500), active: z.boolean().optional(), warranty_days: z.coerce.number().int().min(0).max(3650).nullish().transform((v) => v ?? null),
  min_stock: optMoney, max_stock: optMoney, ideal_stock: optMoney, location: text(60),
  cost_current: optMoney, sale_price: optMoney, min_price: optMoney,
  min_margin_pct: z.coerce.number().min(0).max(99.99).optional(),
  target_margin_pct: z.coerce.number().min(0).max(99.99).optional(),
  barcodes: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
});
