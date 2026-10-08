/** Link de compartilhamento do WhatsApp (wa.me): abre a conversa com o texto pronto; nada é enviado pelo sistema. */
export const waLink = (phone: string | null | undefined, text: string) => {
  const d = (phone ?? '').replace(/\D/g, ''); if (d.length < 10) return null;
  return `https://wa.me/${d.length <= 11 ? '55' + d : d}?text=${encodeURIComponent(text)}`;
};
