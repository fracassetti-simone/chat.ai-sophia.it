import { prisma } from '../db/prisma.js';
import { verifyAccessToken } from '../utils/tokens.js';
import { unauthorized, forbidden } from '../utils/http.js';
import { userCan } from '../utils/rbac.js';

// Carica l'utente dal Bearer token e lo allega a req.user.
export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();

    const payload = verifyAccessToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { permissions: true },
    });
    if (!user || !user.isActive) throw unauthorized('Utente non valido');

    req.user = user;
    next();
  } catch (err) {
    if (err.status) return next(err);
    next(unauthorized('Token non valido o scaduto'));
  }
}

// Richiede uno dei permessi indicati.
export function requirePermission(...perms) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    const ok = perms.some((p) => userCan(req.user, p));
    if (!ok) return next(forbidden());
    next();
  };
}

// Solo Super Admin.
export function requireSuperAdmin(req, _res, next) {
  if (req.user?.role !== 'SUPER_ADMIN') return next(forbidden('Riservato al Super Admin'));
  next();
}

// Determina il tenant attivo della richiesta e ne garantisce l'isolamento.
// - ADMIN/MEMBER: bloccati sul proprio tenant.
// - SUPER_ADMIN: può operare su qualsiasi tenant indicando l'header X-Tenant-Id.
export function tenantScope(req, _res, next) {
  if (!req.user) return next(unauthorized());

  if (req.user.role === 'SUPER_ADMIN') {
    req.tenantId = req.headers['x-tenant-id'] || req.user.tenantId || null;
    return next();
  }

  if (!req.user.tenantId) return next(forbidden('Utente senza azienda associata'));
  req.tenantId = req.user.tenantId;
  next();
}

// Garantisce che un tenantId sia presente nello scope (per risorse tenant-bound).
export function requireTenant(req, _res, next) {
  if (!req.tenantId) return next(forbidden('Nessuna azienda selezionata'));
  next();
}
