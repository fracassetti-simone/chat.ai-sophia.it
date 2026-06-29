// Catalogo dei permessi granulari. Formato: "risorsa:azione".
export const PERMISSIONS = {
  TENANTS_MANAGE: 'tenants:manage',
  USERS_CREATE: 'users:create',
  USERS_UPDATE: 'users:update',
  USERS_DELETE: 'users:delete',
  USERS_READ: 'users:read',
  APIKEYS_MANAGE: 'apikeys:manage',
  MODULES_MANAGE: 'modules:manage',
  TRAINING_MANAGE: 'training:manage',
  EMBED_MANAGE: 'embed:manage',
  ENDPOINTS_MANAGE: 'endpoints:manage',
  CHAT_USE: 'chat:use',
  CONFIG_MANAGE: 'config:manage', // attivato dal modulo "Gestisci configurazione"
};

// Permessi impliciti per ruolo. Il SUPER_ADMIN ha tutto in modo implicito.
export const ROLE_PERMISSIONS = {
  SUPER_ADMIN: Object.values(PERMISSIONS),
  ADMIN: [
    PERMISSIONS.USERS_CREATE,
    PERMISSIONS.USERS_UPDATE,
    PERMISSIONS.USERS_DELETE,
    PERMISSIONS.USERS_READ,
    PERMISSIONS.TRAINING_MANAGE,
    PERMISSIONS.EMBED_MANAGE,
    PERMISSIONS.CHAT_USE,
    // NON include MODULES_MANAGE (solo super admin gestisce i moduli per i tenant)
    // NON include ENDPOINTS_MANAGE
    // CONFIG_MANAGE è opzionale — attivato dal modulo "config-manage"
  ],
  MEMBER: [PERMISSIONS.CHAT_USE],
};

// Permessi effettivi = permessi di ruolo ∪ permessi assegnati esplicitamente.
export function effectivePermissions(user) {
  const base = ROLE_PERMISSIONS[user.role] ?? [];
  const extra = (user.permissions ?? []).map((p) => p.key);
  return new Set([...base, ...extra]);
}

export function userCan(user, permission) {
  if (user.role === 'SUPER_ADMIN') return true;
  return effectivePermissions(user).has(permission);
}
