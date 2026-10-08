import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, get, getToken, setToken, setUnauthorizedHandler } from './api';

export interface Me {
  user: { id: string; name: string; role: string };
  company: { id: string; legal_name: string; trade_name: string | null; is_demo: boolean };
  branchId: string | null; branches: { id: string; name: string; code: string }[]; permissions: string[];
}
interface Ctx {
  me: Me | null; loading: boolean; mustChange: boolean;
  login(email: string, password: string): Promise<void>; logout(): Promise<void>; reload(): Promise<void>;
  can(p: string): boolean;
}
const C = createContext<Ctx>(null!);
export const useAuth = () => useContext(C);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(!!getToken());
  const [mustChange, setMustChange] = useState(false);

  const reload = useCallback(async () => {
    try { setMe(await get<Me>('/auth/me')); }
    catch { setMe(null); setToken(null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { setUnauthorizedHandler(() => { setToken(null); setMe(null); }); if (getToken()) reload(); }, [reload]);

  const login = async (email: string, password: string) => {
    const r = await api('POST', '/auth/login', { email, password });
    setToken(r.token); setMustChange(r.mustChangePassword); await reload();
  };
  const logout = async () => { try { await api('POST', '/auth/logout'); } catch { /* sessão já inválida */ } setToken(null); setMe(null); };
  return <C.Provider value={{ me, loading, mustChange, login, logout, reload, can: (p) => !!me?.permissions.includes(p) }}>{children}</C.Provider>;
}
