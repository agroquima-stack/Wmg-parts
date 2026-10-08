import { useState } from 'react';
import { api, ApiError } from './api';
import { Modal } from './DataPage';

/** Botão "WhatsApp": monta a mensagem pronta e abre a conversa pelo link (wa.me). Nada é enviado pelo sistema. */
export function WhatsAppButton({ kind, id, label = 'WhatsApp' }: { kind: 'receivable' | 'sale'; id: string; label?: string }) {
  const [msg, setMsg] = useState<any>(null); const [err, setErr] = useState('');
  const go = async () => { setErr(''); try { const r = await api('POST', '/share/whatsapp', { kind, id }); if (r.url) window.open(r.url, '_blank', 'noopener'); else setMsg(r); } catch (e) { setErr((e as ApiError).message); } };
  return <>{<button onClick={go}>{label}</button>}{err && <span className="err" style={{ marginLeft: 8 }}>{err}</span>}
    {msg && <Modal onClose={() => setMsg(null)}><h3 style={{ marginTop: 0 }}>Mensagem para {msg.recipient}</h3><div className="alert yellow">Cliente sem telefone/WhatsApp cadastrado. Copie o texto e envie pelo canal que preferir.</div>
      <textarea readOnly rows={7} value={msg.text} style={{ width: '100%' }} onFocus={(e) => e.target.select()} /><div className="right"><button onClick={() => navigator.clipboard?.writeText(msg.text)}>Copiar texto</button><button onClick={() => setMsg(null)}>Fechar</button></div></Modal>}</>;
}

