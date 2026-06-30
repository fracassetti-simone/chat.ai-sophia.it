import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { verifyAccessToken } from '../utils/tokens.js';
import { unauthorized, forbidden } from '../utils/http.js';
import { userCan } from '../utils/rbac.js';

// Prefisso dei super token API (a livello di piattaforma).
export const SUPER_TOKEN_PREFIX = 'sphsuper_';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Carica l'utente dal Bearer token e lo allega a req.user.
// Supporta due tipi di credenziale:
//  - JWT di accesso utente (login web)
//  - Super token API (Bearer sphsuper_...) → autentica come Super Admin di sistema
export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();

    // ── Super token API: accesso trasversale a tutti i tenant ──────────────
    if (token.startsWith(SUPER_TOKEN_PREFIX)) {
      const st = await prisma.superApiToken.findUnique({ where: { keyHash: hashToken(token) } });
      if (!st || st.revokedAt) throw unauthorized('Super token non valido o revocato');
      // Aggiorna lastUsedAt senza bloccare la richiesta.
      prisma.superApiToken
        .update({ where: { id: st.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {});
      // Utente sintetico di sistema: Super Admin, nessun id reale (audit con userId null).
      req.user = {
        id: null,
        email: `super-token:${st.id}`,
        name: st.name,
        role: 'SUPER_ADMIN',
        isActive: true,
        tenantId: null,
        permissions: [],
        isSuperToken: true,
        superTokenId: st.id,
      };
      return next();
    }

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
