import { buildAccessKey } from './rules.js';

export interface EmitContext { payload: any; model: '55' | '65'; environment: 'homologacao' | 'producao'; series: number; nextNumber: () => Promise<number> }
export interface EmitResult { status: 'autorizada' | 'rejeitada'; number?: number; series?: number; access_key?: string; protocol?: string; xml?: string; message: string }
export interface EventResult { protocol: string; xml?: string; message: string }

/**
 * Contrato de provedor fiscal. Cada integração (Focus NFe, eNotas, PlugNotas, SEFAZ direta...) implementa esta interface;
 * o restante do sistema só conhece o payload normalizado. Enquanto o provedor não é escolhido: 'manual' (registra nota emitida
 * fora do sistema) e 'simulado' (sandbox de testes, SEM valor fiscal).
 */
export interface FiscalProvider {
  name: string; label: string; canEmit: boolean; simulated: boolean;
  emit(ctx: EmitContext): Promise<EmitResult>;
  cancel(ctx: { accessKey: string; reason: string }): Promise<EventResult | null>;       // null = o provedor não executa; informar protocolo manualmente
  correct(ctx: { accessKey: string; text: string; seq: number }): Promise<EventResult | null>;
}

const esc = (s: unknown) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
const proto = () => `SIM${Date.now()}${Math.floor(Math.random() * 1e4)}`;

/** XML ilustrativo e NÃO assinado, só para exercitar o fluxo em homologação. */
export function simulatedXml(p: any, key: string, number: number, series: number): string {
  const d = p.destinatario;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- SIMULADO — SEM VALOR FISCAL: gerado pelo provedor de testes, não assinado nem autorizado pela SEFAZ -->\n<NFe><infNFe Id="NFe${key}" versao="4.00"><ide><mod>${p.model}</mod><serie>${series}</serie><nNF>${number}</nNF><natOp>${esc(p.natureza)}</natOp><finNFe>${p.finalidade}</finNFe><idDest>${p.ide.idDest}</idDest><indFinal>${p.ide.indFinal}</indFinal><indPres>${p.ide.indPres}</indPres></ide>`
    + `<emit><CNPJ>${p.emitente.cnpj}</CNPJ><xNome>${esc(p.emitente.nome)}</xNome><IE>${esc(p.emitente.ie)}</IE><CRT>${p.emitente.crt}</CRT></emit>`
    + (d ? `<dest><${d.tipo === 'PJ' ? 'CNPJ' : 'CPF'}>${esc(d.documento)}</${d.tipo === 'PJ' ? 'CNPJ' : 'CPF'}><xNome>${esc(d.nome)}</xNome><indIEDest>${d.indIEDest}</indIEDest></dest>` : '')
    + p.itens.map((i: any) => `<det nItem="${i.n}"><prod><cProd>${esc(i.sku)}</cProd><xProd>${esc(i.descricao)}</xProd><NCM>${i.ncm}</NCM><CFOP>${i.cfop}</CFOP><uCom>${esc(i.unidade)}</uCom><qCom>${i.quantidade}</qCom><vUnCom>${i.valor_unitario.toFixed(2)}</vUnCom><vProd>${i.valor_produtos.toFixed(2)}</vProd><vDesc>${i.valor_desconto.toFixed(2)}</vDesc></prod><imposto><ICMS><ICMSSN${i.csosn}><orig>${i.origem}</orig><CSOSN>${i.csosn}</CSOSN></ICMSSN${i.csosn}></ICMS></imposto></det>`).join('')
    + `<total><ICMSTot><vProd>${p.totais.valor_produtos.toFixed(2)}</vProd><vDesc>${p.totais.valor_desconto.toFixed(2)}</vDesc><vNF>${p.totais.valor_nf.toFixed(2)}</vNF></ICMSTot></total><infAdic><infCpl>${esc(p.informacoes_complementares)}</infCpl></infAdic></infNFe></NFe>`;
}

export const providers: Record<string, FiscalProvider> = {
  manual: {
    name: 'manual', label: 'Emissão externa (registro manual)', canEmit: false, simulated: false,
    emit: async () => ({ status: 'rejeitada', message: 'Provedor manual não emite: emita a nota no seu sistema/portal e registre-a aqui.' }),
    cancel: async () => null, correct: async () => null,
  },
  simulado: {
    name: 'simulado', label: 'Simulado — SEM VALOR FISCAL (testes)', canEmit: true, simulated: true,
    async emit(ctx) {
      const number = await ctx.nextNumber(); const key = buildAccessKey({ uf: ctx.payload.emitente.uf, issue: new Date(), cnpj: ctx.payload.emitente.cnpj, model: ctx.model, series: ctx.series, number });
      return { status: 'autorizada', number, series: ctx.series, access_key: key, protocol: proto(), xml: simulatedXml(ctx.payload, key, number, ctx.series), message: 'AUTORIZADO (SIMULADO — sem valor fiscal)' };
    },
    cancel: async () => ({ protocol: proto(), message: 'Cancelamento simulado' }),
    correct: async () => ({ protocol: proto(), message: 'CC-e simulada' }),
  },
};
