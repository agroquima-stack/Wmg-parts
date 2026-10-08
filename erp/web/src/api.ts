const KEY = 'erp.token';
export const getToken = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
export const setToken = (t: string | null) => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage indisponível */ } };

export class ApiError extends Error {
  constructor(public status: number, message: string, public issues?: { path: string; message: string }[], public code?: string) { super(message); }
}
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (f: () => void) => { onUnauthorized = f; };

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const t = getToken();
  const res = await fetch('/api' + path, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    const detail = data.issues?.map((i: any) => `${i.path}: ${i.message}`).join('; ');
    throw new ApiError(res.status, detail ? `${data.error} ${detail}` : data.error ?? 'Erro', data.issues, data.code);
  }
  return data as T;
}
export const get = <T = any>(p: string) => api<T>('GET', p);
export const qs = (o: Record<string, unknown>) =>
  '?' + Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const brl = (v: unknown) => (v == null || v === '' ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
export const pct = (v: unknown) => (v == null || v === '' ? '—' : `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`);
