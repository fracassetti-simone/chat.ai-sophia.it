import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, tokens } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    if (!tokens.access) { setLoading(false); return; }
    try {
      const { user } = await api('/auth/me');
      setUser(user);
    } catch {
      tokens.clear();
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadMe(); }, [loadMe]);

  const login = async (email, password) => {
    const data = await api('/auth/login', { method: 'POST', body: { email, password }, retry: false });
    tokens.set(data);
    if (data.user.tenantId) tokens.setTenant(data.user.tenantId);
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST', body: { refreshToken: tokens.refresh } }); } catch {}
    tokens.clear();
    setUser(null);
  };

  // Permessi impliciti per ruolo (speculare al backend ROLE_PERMISSIONS)
  const ROLE_PERMISSIONS = {
    SUPER_ADMIN: null, // tutto
    ADMIN: new Set([
      'users:create','users:update','users:delete','users:read',
      'training:manage','embed:manage','chat:use',
      // NON include modules:manage, endpoints:manage (solo super admin può toccare moduli)
    ]),
    MEMBER: new Set(['chat:use']),
  };

  const can = (perm) => {
    if (!user) return false;
    if (user.role === 'SUPER_ADMIN') return true;
    // Permessi espliciti assegnati all'utente
    if (Array.isArray(user.permissions) && user.permissions.includes(perm)) return true;
    // Permessi impliciti del ruolo
    return ROLE_PERMISSIONS[user.role]?.has(perm) ?? false;
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, can, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
