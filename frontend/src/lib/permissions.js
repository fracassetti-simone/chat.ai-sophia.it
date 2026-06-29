// Speculare al backend (src/utils/rbac.js).
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
  CONFIG_MANAGE: 'config:manage', // modulo "Gestisci configurazione" per admin tenant
};
