import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, tokens } from '../lib/api.js';
import { useAuth } from './AuthContext.jsx';

const TenantContext = createContext(null);

export function TenantProvider({ children }) {
  const { user } = useAuth();
  const isSuper = user?.role === 'SUPER_ADMIN';

  const [tenants, setTenants] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;

    // Utenti Admin/Member: il contesto è sempre la loro azienda.
    if (!isSuper) {
      setActiveId(user.tenantId || null);
      tokens.setTenant(user.tenantId || null);
      setReady(true);
      return;
    }

    // Super Admin: carica le aziende e seleziona quella salvata o la prima.
    try {
      const { tenants } = await api('/tenants');
      setTenants(tenants);
      const stored = tokens.tenant;
      const valid = tenants.find((t) => t.id === stored);
      const next = valid ? stored : tenants[0]?.id || null;
      setActiveId(next);
      tokens.setTenant(next);
    } catch {
      setTenants([]);
      setActiveId(null);
    } finally {
      setReady(true);
    }
  }, [user, isSuper]);

  useEffect(() => { refresh(); }, [refresh]);

  const selectTenant = useCallback((id) => {
    setActiveId(id);
    tokens.setTenant(id);
  }, []);

  const activeTenant = tenants.find((t) => t.id === activeId) || null;

  const value = {
    tenants,
    activeId,
    activeTenant,
    isSuper,
    hasTenant: !!activeId,
    ready,
    selectTenant,
    refresh,
  };

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export const useTenant = () => useContext(TenantContext);
