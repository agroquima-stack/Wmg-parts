import { createHash } from 'node:crypto';

/** Divide CSV respeitando aspas, "" escapado, BOM e CRLF. O separador é detectado se não informado. */
export function parseCsv(text: string, delimiter?: string): { rows: string[][]; delimiter: string } {
  const src = text.replace(/^﻿/, '');
  const d = delimiter ?? detectDelimiter(src);
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === d) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some((c) => c.trim() !== '')) rows.push(row);
  return { rows: rows.map((r) => r.map((c) => c.trim())), delimiter: d };
}
function detectDelimiter(src: string) {
  const head = src.split(/\r?\n/).slice(0, 8).join('\n');
  const score = (d: string) => (head.match(new RegExp(d === '\t' ? '\\t' : '\\' + d, 'g')) ?? []).length;
  return [';', '\t', ',', '|'].sort((a, b) => score(b) - score(a))[0];
}

export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Número em formato brasileiro ("1.234,56", "-R$ 10,00", "(10,00)") ou internacional. null se não for número. */
export function parseAmount(raw: string, decimal: ',' | '.' = ','): number | null {
  let s = raw.trim(); if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-\s*$/.test(s)) { neg = true; s = s.replace(/-\s*$/, ''); }
  s = s.replace(/R\$|\s/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s)) return null;
  s = decimal === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = Number(s); if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100) / 100;
}

/** Datas dd/mm/aaaa, dd/mm/aa, dd-mm-aaaa ou aaaa-mm-dd → 'AAAA-MM-DD' (null se inválida). */
export function parseDate(raw: string): string | null {
  const s = raw.trim().slice(0, 10); let y: number, m: number, d: number;
  let r = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (r) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/))) { d = +r[1]; m = +r[2]; y = +r[3]; }
  else if ((r = s.match(/^(\d{2})\/(\d{2})\/(\d{2})$/))) { d = +r[1]; m = +r[2]; y = 2000 + +r[3]; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface CsvMapping { delimiter?: string; decimal?: ',' | '.'; header_row?: number; date: number; description?: number; amount?: number; debit?: number; credit?: number; doc?: number }

const HEAD = {
  date: ['data', 'data lancamento', 'data movimento', 'data mov', 'dt lancamento', 'data da transacao', 'data transacao'],
  description: ['historico', 'descricao', 'lancamento', 'descricao do lancamento', 'detalhes', 'memo', 'transacao'],
  amount: ['valor', 'valor r', 'valor brl', 'montante'], debit: ['debito', 'saida', 'saidas', 'valor debito'], credit: ['credito', 'entrada', 'entradas', 'valor credito'],
  doc: ['documento', 'n documento', 'nr documento', 'id', 'id transacao', 'numero documento', 'codigo'],
};

/** Sugere o mapeamento de colunas pelo nome do cabeçalho; a primeira linha com data+valor define onde o cabeçalho está. */
export function guessMapping(rows: string[][]): { mapping: CsvMapping | null; header_row: number } {
  for (let h = 0; h < Math.min(rows.length, 15); h++) {
    const cols = rows[h].map(norm); const find = (names: string[]) => { const i = cols.findIndex((c) => names.includes(c)); return i >= 0 ? i : cols.findIndex((c) => names.some((n) => c.startsWith(n + ' ') || c.endsWith(' ' + n))); };
    const date = find(HEAD.date), amount = find(HEAD.amount), debit = find(HEAD.debit), credit = find(HEAD.credit);
    if (date >= 0 && (amount >= 0 || (debit >= 0 && credit >= 0))) {
      const m: CsvMapping = { header_row: h, date }; const desc = find(HEAD.description), doc = find(HEAD.doc);
      if (amount >= 0) m.amount = amount; else { m.debit = debit; m.credit = credit; }
      if (desc >= 0) m.description = desc; if (doc >= 0) m.doc = doc; return { mapping: m, header_row: h };
    }
  }
  return { mapping: null, header_row: 0 };
}

export interface StatementLine { line_date: string; description: string; amount: number; doc_ref: string | null; hash: string }

/** Converte as linhas do CSV em lançamentos de extrato. Débitos viram valores negativos. Hash estável permite reimportar sem duplicar. */
export function extractLines(rows: string[][], m: CsvMapping, accountId: string): { lines: StatementLine[]; skipped: { row: number; reason: string }[] } {
  const lines: StatementLine[] = []; const skipped: { row: number; reason: string }[] = []; const seen = new Map<string, number>();
  const dec = m.decimal ?? ',';
  for (let i = (m.header_row ?? 0) + 1; i < rows.length; i++) {
    const r = rows[i]; const date = parseDate(r[m.date] ?? '');
    let amount: number | null = null;
    if (m.amount != null) amount = parseAmount(r[m.amount] ?? '', dec);
    else {
      const db = parseAmount(r[m.debit!] ?? '', dec), cr = parseAmount(r[m.credit!] ?? '', dec);
      if (db != null || cr != null) amount = Math.round(((cr ?? 0) - Math.abs(db ?? 0)) * 100) / 100;
    }
    if (!date) { skipped.push({ row: i + 1, reason: 'data inválida' }); continue; }
    if (amount == null || amount === 0) { skipped.push({ row: i + 1, reason: 'valor ausente ou zero' }); continue; }
    const description = (m.description != null ? r[m.description] : '') ?? ''; const doc = m.doc != null ? (r[m.doc] || null) : null;
    const base = `${accountId}|${date}|${amount}|${norm(description)}|${doc ?? ''}`; const k = (seen.get(base) ?? 0) + 1; seen.set(base, k);
    lines.push({ line_date: date, description, amount, doc_ref: doc, hash: createHash('sha256').update(`${base}|${k}`).digest('hex') });
  }
  return { lines, skipped };
}
