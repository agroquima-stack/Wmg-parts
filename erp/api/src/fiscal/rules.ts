// Regras fiscais (Simples Nacional, venda de mercadoria adquirida de terceiros).
// IMPORTANTE: parametrização a ser validada por contador. Itens marcados como "padrão" podem ser sobrescritos por cadastro.

export const UF_CODE: Record<string, string> = { AC: '12', AL: '27', AP: '16', AM: '13', BA: '29', CE: '23', DF: '53', ES: '32', GO: '52', MA: '21', MT: '51', MS: '50', MG: '31', PA: '15', PB: '25', PR: '41', PE: '26', PI: '22', RJ: '33', RN: '24', RS: '43', RO: '11', RR: '14', SC: '42', SP: '35', SE: '28', TO: '17' };
export const CSOSN_VALID = ['101', '102', '103', '201', '202', '203', '300', '400', '500', '900'];
export const DEFAULT_CSOSN = '102';           // Simples sem permissão de crédito (venda sem ST)

/** Dígito verificador (módulo 11) da chave de acesso de 43 posições. */
export function accessKeyDV(base43: string): number {
  let w = 2, sum = 0;
  for (let i = base43.length - 1; i >= 0; i--) { sum += Number(base43[i]) * w; w = w === 9 ? 2 : w + 1; }
  const r = sum % 11; return r < 2 ? 0 : 11 - r;
}

export function buildAccessKey(o: { uf: string; issue: Date; cnpj: string; model: '55' | '65'; series: number; number: number; code?: number; tpEmis?: number }): string {
  const cod = String(o.code ?? Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const aamm = `${String(o.issue.getUTCFullYear()).slice(2)}${String(o.issue.getUTCMonth() + 1).padStart(2, '0')}`;
  const base = `${UF_CODE[o.uf]}${aamm}${o.cnpj}${o.model}${String(o.series).padStart(3, '0')}${String(o.number).padStart(9, '0')}${o.tpEmis ?? 1}${cod}`;
  return base + accessKeyDV(base);
}

export function parseAccessKey(key: string): { uf: string; aamm: string; cnpj: string; model: string; series: number; number: number } | null {
  if (!/^\d{44}$/.test(key) || accessKeyDV(key.slice(0, 43)) !== Number(key[43])) return null;
  return { uf: key.slice(0, 2), aamm: key.slice(2, 6), cnpj: key.slice(6, 20), model: key.slice(20, 22), series: Number(key.slice(22, 25)), number: Number(key.slice(25, 34)) };
}

export type Segment = string | null;
export interface Recipient { type: 'PF' | 'PJ'; ie: string | null; ie_indicator: number | null; segment: Segment; final_consumer: boolean | null; state: string | null }

/** Indicador de IE do destinatário: 1 contribuinte, 2 isento, 9 não contribuinte. PF é sempre 9; PJ com IE informada é contribuinte. */
export function ieIndicator(r: Recipient): 1 | 2 | 9 {
  if (r.type === 'PF') return 9;
  if (r.ie_indicator === 1 || r.ie_indicator === 2 || r.ie_indicator === 9) return r.ie_indicator;
  return r.ie && !/^isent/i.test(r.ie) ? 1 : 9;
}
/** Consumidor final (indFinal): padrão = PF e PJ que não revende. Revenda/lojista compram para revender (0). Pode ser forçado no cadastro. */
export function isFinalConsumer(r: Recipient): boolean {
  if (r.final_consumer != null) return r.final_consumer;
  if (r.type === 'PF') return true;
  return !['revenda', 'lojista', 'distribuidor', 'atacado'].includes(String(r.segment ?? '').toLowerCase());
}

/**
 * CFOP de venda de mercadoria adquirida de terceiros: 5102 (dentro da UF) / 6102 (fora da UF);
 * 6108 para venda interestadual a não contribuinte (consumidor final sem IE).
 */
export function determineCfop(emitUF: string, destUF: string, ind: 1 | 2 | 9): { cfop: string; idDest: 1 | 2 | 3 } {
  if (emitUF === destUF) return { cfop: '5102', idDest: 1 };
  return { cfop: ind === 9 ? '6108' : '6102', idDest: 2 };
}
/** CFOP de entrada para devolução de venda (nota de entrada própria): 1202 / 2202. */
export const returnCfop = (idDest: 1 | 2 | 3) => (idDest === 1 ? '1202' : '2202');

/**
 * Modelo do documento. Venda para CNPJ → sempre NF-e (55). Para CPF: NFC-e (65) só em venda presencial de balcão e se habilitada;
 * vendas por representante externo ou online (não presenciais) → NF-e (55).
 */
export function chooseModel(o: { recipientType: 'PF' | 'PJ' | null; saleType: string; useNfceForCounter: boolean }): '55' | '65' {
  if (o.recipientType === 'PJ') return '55';
  if (o.saleType === 'balcao' && o.useNfceForCounter) return '65';
  return '55';
}
/** Indicador de presença do comprador (indPres): 1 presencial, 2 internet, 9 outros (venda externa/atacado não presencial). */
export const presence = (saleType: string): 1 | 2 | 9 => (saleType === 'balcao' ? 1 : saleType === 'online' ? 2 : 9);

export const PAYMENT_CODE: Record<string, string> = { dinheiro: '01', cartao_credito: '03', cartao_debito: '04', boleto: '15', pix: '17', crediario: '05' };

export const SIMPLES_NOTE = 'DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL. NAO GERA DIREITO A CREDITO FISCAL DE IPI.';

// ---------------------------------------------------------------- DAS (Simples Nacional — Anexo I, comércio)
// Tabela de referência da LC 123/2006 (Anexo I). Serve só para ESTIMATIVA: validar com o contador / PGDAS-D.
export const ANEXO_I = [
  { upTo: 180000, rate: 4.0, deduction: 0 }, { upTo: 360000, rate: 7.3, deduction: 5940 }, { upTo: 720000, rate: 9.5, deduction: 13860 },
  { upTo: 1800000, rate: 10.7, deduction: 22500 }, { upTo: 3600000, rate: 14.3, deduction: 87300 }, { upTo: 4800000, rate: 19.0, deduction: 378000 },
];
/** Alíquota efetiva = (RBT12 × alíquota nominal − parcela a deduzir) ÷ RBT12. Até a 1ª faixa vale a nominal. null acima do teto do Simples. */
export function effectiveRateAnexoI(rbt12: number): { rate: number; band: number } | null {
  const i = ANEXO_I.findIndex((b) => rbt12 <= b.upTo); if (i < 0) return null;
  if (i === 0 || rbt12 <= 0) return { rate: ANEXO_I[0].rate, band: 1 };
  const b = ANEXO_I[i]; return { rate: Math.round(((rbt12 * b.rate / 100 - b.deduction) / rbt12) * 10000) / 100, band: i + 1 };
}
