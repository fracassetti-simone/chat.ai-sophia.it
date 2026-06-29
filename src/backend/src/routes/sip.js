/**
 * Credenziali SIP per tenant.
 *
 * SUPER_ADMIN: CRUD completo su tutti gli account SIP del tenant attivo.
 * ADMIN:       lettura sola — solo lista DID (senza password/dettagli).
 *
 * GET    /api/sip              → lista account (SUPER_ADMIN: completa; ADMIN: solo DID)
 * POST   /api/sip              → crea nuovo account (SUPER_ADMIN only)
 * PATCH  /api/sip/:id          → modifica account (SUPER_ADMIN only)
 * DELETE /api/sip/:id          → elimina account (SUPER_ADMIN only)
 *
 * Socket.io: il server emette eventi in tempo reale verso il tenant:
 *   sip:created  { client }
 *   sip:updated  { client }
 *   sip:deleted  { id }
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, forbidden } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { emitToTenant } from '../realtime/io.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

// ── Validazione ──────────────────────────────────────────────────────────────

const sipSchema = z.object({
  did:         z.string().min(1, 'DID obbligatorio'),
  internal:    z.string().default(''),
  username:    z.string().min(1, 'Username obbligatorio'),
  password:    z.string().min(1, 'Password obbligatoria'),
  host:        z.string().min(1, 'Host obbligatorio'),
  port:        z.number().int().min(1).max(65535).default(5060),
  protocol:    z.enum(['UDP', 'TCP', 'TLS']).default('UDP'),
  useLocalIp:  z.boolean().default(false),
  label:       z.string().nullable().optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Ritorna un client senza il campo password (per ADMIN) */
function stripSensitive(c) {
  const { password, ...rest } = c;
  return rest;
}

/** Ritorna solo DID + label (per ADMIN in lista) */
function didOnly(c) {
  return { id: c.id, did: c.did, label: c.label, createdAt: c.createdAt };
}

// ── GET /api/sip ─────────────────────────────────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const isSuperAdmin = req.user?.role === 'SUPER_ADMIN';
    const isAdmin      = req.user?.role === 'ADMIN';

    if (!isSuperAdmin && !isAdmin) {
      return res.status(403).json({ error: 'Permesso negato' });
    }

    const clients = await prisma.sipClient.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: 'asc' },
    });

    if (isSuperAdmin) {
      return res.json({ clients });
    }

    // ADMIN: solo lista DID
    return res.json({ clients: clients.map(didOnly), adminView: true });
  }),
);

// ── POST /api/sip ────────────────────────────────────────────────────────────

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (req.user?.role !== 'SUPER_ADMIN') throw forbidden('Solo i Super Admin possono aggiungere credenziali SIP.');

    const data = sipSchema.parse(req.body);
    const client = await prisma.sipClient.create({
      data: { ...data, tenantId: req.tenantId },
    });

    emitToTenant(req.tenantId, 'sip:created', { client });

    res.status(201).json({ client });
  }),
);

// ── PATCH /api/sip/:id ───────────────────────────────────────────────────────

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    if (req.user?.role !== 'SUPER_ADMIN') throw forbidden('Solo i Super Admin possono modificare le credenziali SIP.');

    const data = sipSchema.partial().parse(req.body);

    const existing = await prisma.sipClient.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!existing) throw notFound('Account SIP non trovato.');

    const client = await prisma.sipClient.update({
      where: { id: req.params.id },
      data,
    });

    emitToTenant(req.tenantId, 'sip:updated', { client });

    res.json({ client });
  }),
);

// ── DELETE /api/sip/:id ──────────────────────────────────────────────────────

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (req.user?.role !== 'SUPER_ADMIN') throw forbidden('Solo i Super Admin possono eliminare le credenziali SIP.');

    const existing = await prisma.sipClient.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!existing) throw notFound('Account SIP non trovato.');

    await prisma.sipClient.delete({ where: { id: req.params.id } });

    emitToTenant(req.tenantId, 'sip:deleted', { id: req.params.id });

    res.json({ ok: true });
  }),
);

export default router;
