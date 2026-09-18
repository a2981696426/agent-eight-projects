import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';

export type Role = 'admin' | 'agent' | 'analyst';
export interface SessionUser {
  id: string;
  username: string;
  name: string;
  role: Role;
}
interface MeResponse {
  user: SessionUser | null;
  roles: Record<Role, string>;
  demo: { username: string; password: string; name: string; role: Role }[];
}
interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  roles: Record<Role, string>;
  demo: MeResponse['demo'];
  login: (username: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (roles: Role[]) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse>({ user: null, roles: { admin: '管理员', agent: '坐席', analyst: '质检与运营' }, demo: [] });
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setMe(await api<MeResponse>('/api/auth/me'));
    } catch {
      setMe((m) => ({ ...m, user: null }));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const value = useMemo<AuthState>(
    () => ({
      user: me.user,
      loading,
      roles: me.roles,
      demo: me.demo,
      can: (roles) => !!me.user && roles.includes(me.user.role),
      login: async (username, password) => {
        const r = await api<{ user: SessionUser }>('/api/auth/login', { method: 'POST', body: { username, password } });
        setMe((m) => ({ ...m, user: r.user }));
        return r.user;
      },
      logout: async () => {
        await api('/api/auth/logout', { method: 'POST' });
        setMe((m) => ({ ...m, user: null }));
      },
      refresh,
    }),
    [me, loading, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within AuthProvider');
  return v;
}
