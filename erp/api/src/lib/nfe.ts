import { XMLParser } from 'fast-xml-parser';

export interface NFeItem { supplier_code: string; ean: string | null; description: string; ncm: string | null; cfop: string | null; unit: string | null; qty: number; unit_price: number; total: number; ipi: number }
export interface NFe {
  key: string | null; number: string; series: string | null; issue_date: string | null;
  supplier: { cnpj: string; name: string };
  items: NFeItem[];
  totals: { products: number; freight: number; insurance: number; discount: number; other: number; ipi: number; nf: number };
  installments: { due_date: string; amount: number }[];
}

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false, trimValues: true,
  processEntities: false,                       // sem expansão de entidades (evita XXE / billion laughs)
  isArray: (name) => ['det', 'dup'].includes(name),
});
const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown) => (v == null || v === '' ? null : String(v));

/** Lê NF-e (modelo 55) de fornecedor. Lança Error com mensagem amigável se o XML não for uma NF-e válida. */
export function parseNFe(xml: string): NFe {
  if (xml.length > 3_000_000) throw new Error('XML muito grande.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML com DTD/entidades não é aceito.');
  let doc: any;
  try { doc = parser.parse(xml); } catch { throw new Error('XML inválido.'); }
  const inf = doc?.nfeProc?.NFe?.infNFe ?? doc?.NFe?.infNFe;
  if (!inf) throw new Error('Arquivo não é uma NF-e (infNFe não encontrado).');
  const ide = inf.ide ?? {}, emit = inf.emit ?? {}, tot = inf.total?.ICMSTot ?? {};
  const cnpj = String(emit.CNPJ ?? emit.CPF ?? '').replace(/\D/g, '');
  if (!cnpj) throw new Error('Emitente sem CNPJ/CPF no XML.');
  const dets: any[] = inf.det ?? [];
  if (!dets.length) throw new Error('NF-e sem itens.');
  const items: NFeItem[] = dets.map((d) => {
    const p = d.prod ?? {}; const qty = num(p.qCom);
    if (!(qty > 0)) throw new Error(`Item ${d['@_nItem'] ?? ''} com quantidade inválida.`);
    const ean = str(p.cEAN); const eanTrib = str(p.cEANTrib);
    const eanOk = (e: string | null) => (e && !/^SEM GTIN$/i.test(e) && /^\d{8,14}$/.test(e) ? e : null);
    return { supplier_code: String(p.cProd ?? ''), ean: eanOk(ean) ?? eanOk(eanTrib), description: String(p.xProd ?? ''), ncm: str(p.NCM), cfop: str(p.CFOP), unit: str(p.uCom),
      qty, unit_price: num(p.vUnCom), total: num(p.vProd), ipi: num(d.imposto?.IPI?.IPITrib?.vIPI) };
  });
  const issue = str(ide.dhEmi ?? ide.dEmi);
  const key = str(String(inf['@_Id'] ?? '').replace(/^NFe/, ''));
  const products = num(tot.vProd) || items.reduce((s, i) => s + i.total, 0);
  const ipiSum = items.reduce((s, i) => s + i.ipi, 0);
  const installments = ((inf.cobr?.dup ?? []) as any[]).map((d) => ({ due_date: String(d.dVenc ?? ''), amount: num(d.vDup) })).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.due_date) && d.amount > 0);
  return {
    key: key && /^\d{44}$/.test(key) ? key : null, number: String(ide.nNF ?? ''), series: str(ide.serie), issue_date: issue ? issue.slice(0, 10) : null,
    supplier: { cnpj, name: String(emit.xNome ?? '') }, items,
    totals: { products, freight: num(tot.vFrete), insurance: num(tot.vSeg), discount: num(tot.vDesc), other: num(tot.vOutro), ipi: num(tot.vIPI) || ipiSum, nf: num(tot.vNF) },
    installments,
  };
}
