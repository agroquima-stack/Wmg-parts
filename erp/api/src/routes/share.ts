import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { can, HttpError } from '../auth.js';
import { audit } from '../audit.js';
import { calcCharges, getFinanceSettings, loadTitle, today } from '../finance.js';
import { waLink } from '../lib/whatsapp.js';

const brl = (n: number) => 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const br = (d: string) => d.slice(0, 10).split('-').reverse().join('/');
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** Mensagens prontas para WhatsApp por link (wa.me): o sistema monta o texto e abre a conversa; quem envia é a pessoa. */
export async function shareRoutes(app: FastifyInstance) {
  app.post('/share/whatsapp', async (req) => {
    const a = can(req, 'sales:view'); const b = z.object({ kind: z.enum(['receivable', 'sale']), id: z.string().uuid() }).parse(req.body);
    const co = (await pool.query('select coalesce(trade_name, legal_name) as name from companies where id = $1', [a.companyId])).rows[0].name as string;
    let text = '', phone: string | null = null, who = '';
    if (b.kind === 'receivable') {
      can(req, 'finance:view'); const t = await loadTitle(pool, 'receivable', b.id, a.companyId);
      if (!['aberto', 'parcial'].includes(t.status) || t.outstanding <= 0) throw new HttpError(409, 'Este título não está em aberto.');
      const c = t.customer_id ? (await pool.query('select legal_name, trade_name, phone, whatsapp from customers where id = $1 and company_id = $2', [t.customer_id, a.companyId])).rows[0] : null;
      if (!c) throw new HttpError(422, 'Título sem cliente identificado.'); who = c.trade_name ?? c.legal_name; phone = c.whatsapp ?? c.phone;
      const late = dayDiff(t.due_date, today());
      if (late > 0) { const ch = calcCharges({ outstanding: t.outstanding, due_date: t.due_date, on_date: today(), fine_already_charged: t.fine_paid > 0, last_settle_date: t.last_settle }, await getFinanceSettings(pool, a.companyId));
        text = `Olá, ${who}! Aqui é da ${co}. Identificamos o título${t.description ? ` "${t.description}"` : ''} de ${brl(t.outstanding)} vencido em ${br(t.due_date)} (${late} dia(s) de atraso). Valor atualizado hoje com multa e juros: ${brl(t.outstanding + ch.total)}. Podemos ajudar com a regularização? Caso já tenha pago, desconsidere e nos envie o comprovante. Obrigado!`; }
      else text = `Olá, ${who}! Aqui é da ${co}. Lembrete: o título${t.description ? ` "${t.description}"` : ''} de ${brl(t.outstanding)} vence em ${br(t.due_date)}${late === 0 ? ' (hoje)' : ''}. Qualquer dúvida, estamos à disposição. Obrigado!`;
    } else {
      const s = (await pool.query(`select s.*, c.legal_name, c.trade_name, c.phone, c.whatsapp from sales s left join customers c on c.id = s.customer_id where s.id = $1 and s.company_id = $2`, [b.id, a.companyId])).rows[0]; if (!s) throw new HttpError(404, 'Venda não encontrada.');
      if (s.status === 'cancelada') throw new HttpError(409, 'Venda cancelada.');
      who = s.trade_name ?? s.legal_name ?? 'cliente'; phone = s.whatsapp ?? s.phone;
      const items = (await pool.query('select p.sku, p.description, i.qty, i.unit_price, i.total from sale_items i join products p on p.id = i.product_id where i.sale_id = $1 order by p.sku limit 12', [b.id])).rows;
      const lines = items.map((i) => `• ${Number(i.qty)}x ${i.description} — ${brl(Number(i.total))}`).join('\n');
      text = `Olá, ${who}! Pedido nº ${s.number} da ${co}${s.status === 'concluida' ? ' confirmado' : ' registrado'}:\n${lines}\nTotal: ${brl(Number(s.total))}.\nObrigado pela preferência!`;
    }
    await audit(pool, a, b.kind, b.id, 'share_whatsapp', null, { to: who });
    return { text, phone_missing: !waLink(phone, 'x'), url: waLink(phone, text), recipient: who };
  });
}
