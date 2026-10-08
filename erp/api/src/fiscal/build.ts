import type { Db } from '../db.js';
import { isValidCNPJ, isValidCPF } from '../lib/documents.js';
import { CSOSN_VALID, DEFAULT_CSOSN, SIMPLES_NOTE, PAYMENT_CODE, UF_CODE, chooseModel, determineCfop, ieIndicator, isFinalConsumer, presence, returnCfop } from './rules.js';

export interface FiscalSettings {
  provider: 'manual' | 'simulado'; environment: 'homologacao' | 'producao'; series_nfe: number; series_nfce: number; use_nfce_for_counter: boolean;
  cancel_window_hours: number; das_mode: 'manual' | 'anexo_i'; das_effective_pct: number | null; rbt12_override: number | null; ibs_cbs_enabled: boolean;
}
export const DEFAULT_FISCAL: FiscalSettings = { provider: 'manual', environment: 'homologacao', series_nfe: 1, series_nfce: 1, use_nfce_for_counter: false, cancel_window_hours: 24, das_mode: 'manual', das_effective_pct: null, rbt12_override: null, ibs_cbs_enabled: false };

export async function getFiscalSettings(db: Db, companyId: string): Promise<FiscalSettings> {
  const v = (await db.query(`select value from company_settings where company_id = $1 and key = 'fiscal'`, [companyId])).rows[0]?.value ?? {};
  return { ...DEFAULT_FISCAL, ...v };
}

export interface Issue { field: string; message: string }
export interface Validation { errors: Issue[]; warnings: Issue[] }
const addr = (o: any) => ({ logradouro: o.street, numero: o.number, complemento: o.complement, bairro: o.district, municipio: o.city, cod_municipio: o.city_ibge, uf: o.state, cep: o.zip ? String(o.zip).replace(/\D/g, '') : null });

/**
 * Monta o documento fiscal normalizado a partir da venda concluída e valida o cadastro (emitente, destinatário, itens, totais).
 * Não emite nada: o provedor recebe este payload. kind 'devolucao_venda' monta nota de entrada própria referenciando a nota original.
 */
export async function buildFiscalPayload(db: Db, companyId: string, saleId: string, opts: { model?: '55' | '65'; kind?: 'venda' | 'devolucao_venda'; returnItems?: { product_id: string; qty: number }[]; refKey?: string | null } = {}) {
  const v: Validation = { errors: [], warnings: [] }; const err = (field: string, message: string) => v.errors.push({ field, message }); const warn = (field: string, message: string) => v.warnings.push({ field, message });
  const settings = await getFiscalSettings(db, companyId); const kind = opts.kind ?? 'venda';
  const sale = (await db.query('select * from sales where id = $1 and company_id = $2', [saleId, companyId])).rows[0];
  if (!sale) throw new Error('Venda não encontrada.');
  if (sale.status !== 'concluida') err('venda', `A venda está ${sale.status}: só vendas concluídas podem ser faturadas.`);
  const co = (await db.query('select legal_name, trade_name, cnpj from companies where id = $1', [companyId])).rows[0];
  const br = (await db.query('select * from branches where id = $1', [sale.branch_id])).rows[0];
  const cnpj = String(br.cnpj ?? (br.is_headquarters ? co.cnpj : '') ?? '').replace(/\D/g, '');

  // --- emitente
  if (!isValidCNPJ(cnpj)) err('emitente.cnpj', 'CNPJ do emitente ausente ou inválido (Administração → Filiais).');
  if (!br.ie) err('emitente.ie', 'Inscrição estadual do emitente não informada (use ISENTO se for o caso).');
  if (br.crt !== 1) warn('emitente.crt', 'Regime diferente do Simples Nacional: as regras de CSOSN deste módulo não se aplicam.');
  for (const [k, l] of [['street', 'logradouro'], ['number', 'número'], ['district', 'bairro'], ['city', 'município'], ['state', 'UF'], ['zip', 'CEP']] as const) if (!br[k]) err(`emitente.${k}`, `Endereço do emitente sem ${l}.`);
  if (br.state && !UF_CODE[br.state]) err('emitente.state', 'UF do emitente inválida.');
  if (!br.city_ibge) warn('emitente.city_ibge', 'Código IBGE do município do emitente não informado (alguns provedores exigem).');
  const emitente = { cnpj, ie: br.ie, im: br.im, crt: br.crt, nome: co.legal_name, fantasia: co.trade_name, endereco: addr(br), uf: br.state };

  // --- destinatário
  let dest: any = null; let recipient = null as null | { type: 'PF' | 'PJ'; ie: string | null; ie_indicator: number | null; segment: string | null; final_consumer: boolean | null; state: string | null };
  if (sale.customer_id) {
    const c = (await db.query('select * from customers where id = $1', [sale.customer_id])).rows[0];
    recipient = { type: c.type, ie: c.ie, ie_indicator: c.ie_indicator, segment: c.segment, final_consumer: c.final_consumer, state: c.state };
    dest = { tipo: c.type, documento: c.document, nome: c.legal_name, ie: c.ie, indIEDest: ieIndicator(recipient), consumidor_final: isFinalConsumer(recipient), email: c.email, endereco: addr(c) };
  }
  const model = opts.model ?? chooseModel({ recipientType: recipient?.type ?? null, saleType: sale.type, useNfceForCounter: settings.use_nfce_for_counter });
  if (recipient?.type === 'PJ' && model === '65') err('modelo', 'Venda para CNPJ exige NF-e (modelo 55): NFC-e é só para consumidor final.');
  if (model === '65' && sale.type !== 'balcao') err('modelo', 'NFC-e só pode ser usada em venda presencial de balcão. Para venda externa/online use NF-e (55).');
  if (model === '55') {
    if (!dest) err('destinatario', 'NF-e exige destinatário identificado (CPF ou CNPJ).');
    else {
      const okDoc = dest.tipo === 'PF' ? isValidCPF(dest.documento ?? '') : isValidCNPJ(dest.documento ?? '');
      if (!okDoc) err('destinatario.documento', `${dest.tipo === 'PF' ? 'CPF' : 'CNPJ'} do destinatário ausente ou inválido.`);
      for (const [k, l] of [['logradouro', 'logradouro'], ['numero', 'número'], ['bairro', 'bairro'], ['municipio', 'município'], ['uf', 'UF'], ['cep', 'CEP']] as const) if (!dest.endereco[k]) err(`destinatario.${k}`, `Destinatário sem ${l} (obrigatório na NF-e).`);
      if (dest.endereco.uf && !UF_CODE[dest.endereco.uf]) err('destinatario.uf', 'UF do destinatário inválida.');
      if (dest.indIEDest === 1 && !dest.ie) err('destinatario.ie', 'Destinatário contribuinte sem inscrição estadual.');
      if (!dest.endereco.cod_municipio) warn('destinatario.cod_municipio', 'Código IBGE do município do destinatário não informado (alguns provedores exigem).');
    }
  } else if (dest && !dest.documento) warn('destinatario.documento', 'CPF/CNPJ na nota não informado.');

  const destUF: string = dest?.endereco.uf ?? emitente.uf ?? '';
  const ind = dest ? dest.indIEDest : 9;
  const { cfop: saleCfop, idDest } = determineCfop(emitente.uf ?? '', destUF || emitente.uf || '', ind);
  const cfop = kind === 'devolucao_venda' ? returnCfop(idDest) : saleCfop;
  const finalConsumer = dest ? dest.consumidor_final : true;
  if (idDest === 2 && finalConsumer && ind !== 1) warn('difal', 'Venda interestadual a consumidor final não contribuinte: pode haver DIFAL/partilha de ICMS e regras de ST do estado de destino. O sistema NÃO calcula DIFAL — valide com o contador.');
  warn('st', 'Confirme com o contador se os NCMs vendidos estão sujeitos a substituição tributária (autopeças/motopeças costumam estar, conforme o estado): nesse caso use CSOSN 500/201 e informe o CEST nos produtos.');

  // --- itens
  let rows = (await db.query(
    `select i.*, p.sku, p.description, p.ncm, p.cest, p.origin, p.unit, p.csosn, (select barcode from product_barcodes where product_id = p.id order by barcode limit 1) as ean
       from sale_items i join products p on p.id = i.product_id where i.sale_id = $1 order by p.description`, [saleId])).rows;
  if (kind === 'devolucao_venda') {
    const want = new Map((opts.returnItems ?? []).map((r) => [r.product_id, r.qty]));
    rows = rows.filter((r) => want.has(r.product_id)).map((r) => ({ ...r, qty: want.get(r.product_id) }));
    for (const r of rows) { const orig = Number((await db.query('select qty from sale_items where sale_id = $1 and product_id = $2', [saleId, r.product_id])).rows[0].qty); if (Number(r.qty) > orig + 1e-9) err('itens', `Quantidade devolvida de ${r.sku} maior que a vendida.`); }
    if (!rows.length) err('itens', 'Nenhum item informado para devolução.');
  }
  const itens = rows.map((r, k) => {
    const qty = Number(r.qty), list = Number(r.list_price), unit = Number(r.unit_price); const vProd = Math.round(list * qty * 100) / 100; const vDesc = Math.round((list - unit) * qty * 100) / 100;
    const csosn = r.csosn ?? DEFAULT_CSOSN;
    if (!r.ncm || !/^\d{8}$/.test(r.ncm)) err(`itens[${k}].ncm`, `${r.sku}: NCM ausente ou inválido (8 dígitos).`);
    if (r.origin == null) err(`itens[${k}].origem`, `${r.sku}: origem da mercadoria não informada.`);
    if (!r.unit) err(`itens[${k}].unidade`, `${r.sku}: unidade ausente.`);
    if (!CSOSN_VALID.includes(csosn)) err(`itens[${k}].csosn`, `${r.sku}: CSOSN inválido.`);
    if (['201', '202', '203', '500'].includes(csosn) && !r.cest) err(`itens[${k}].cest`, `${r.sku}: CSOSN ${csosn} (ST) exige CEST.`);
    return { n: k + 1, product_id: r.product_id, sku: r.sku, descricao: r.description, ean: r.ean ?? null, ncm: r.ncm, cest: r.cest, origem: r.origin, cfop, csosn, unidade: r.unit, quantidade: qty, valor_unitario: list, valor_produtos: vProd, valor_desconto: vDesc,
      pis: { cst: '49', valor: 0 }, cofins: { cst: '49', valor: 0 }, ...(settings.ibs_cbs_enabled ? { ibs: { valor: 0 }, cbs: { valor: 0 } } : {}) };
  });
  const vProd = Math.round(itens.reduce((s, i) => s + i.valor_produtos, 0) * 100) / 100, vDesc = Math.round(itens.reduce((s, i) => s + i.valor_desconto, 0) * 100) / 100, vNF = Math.round((vProd - vDesc) * 100) / 100;
  if (kind === 'venda' && Math.abs(vNF - Number(sale.total)) > 0.01) err('totais', `Total da nota (R$ ${vNF.toFixed(2)}) difere do total da venda (R$ ${Number(sale.total).toFixed(2)}).`);
  if (itens.some((i) => i.valor_unitario <= 0)) err('itens', 'Há item com valor unitário zerado.');

  const pays = kind === 'venda' ? (await db.query('select method, amount from sale_payments where sale_id = $1', [saleId])).rows : [];
  const pagamentos = kind === 'venda' ? pays.map((p) => ({ tPag: PAYMENT_CODE[p.method] ?? '99', metodo: p.method, valor: Number(p.amount) })) : [{ tPag: '90', metodo: 'sem pagamento', valor: 0 }];
  if (kind === 'venda' && !pagamentos.length) err('pagamentos', 'Venda sem pagamentos registrados.');

  const refs = kind === 'devolucao_venda' && opts.refKey ? [{ refNFe: opts.refKey }] : [];
  const payload = {
    model, kind, finalidade: kind === 'venda' ? 1 : 4, natureza: kind === 'venda' ? 'VENDA DE MERCADORIA' : 'DEVOLUCAO DE VENDA DE MERCADORIA',
    ide: { idDest, indFinal: finalConsumer ? 1 : 0, indPres: presence(sale.type), tipo_operacao: kind === 'venda' ? 1 : 0, tpAmb: settings.environment === 'producao' ? 1 : 2, serie: model === '55' ? settings.series_nfe : settings.series_nfce },
    emitente, destinatario: dest, itens, totais: { valor_produtos: vProd, valor_desconto: vDesc, valor_frete: 0, valor_outras: 0, valor_nf: vNF }, pagamentos, transporte: { modFrete: 9 }, referencias: refs,
    informacoes_complementares: SIMPLES_NOTE + (sale.number ? ` Pedido ${sale.number}.` : ''),
  };
  return { payload, validation: v, model, sale, settings };
}
