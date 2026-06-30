import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, forbidden } from '../utils/http.js';
import { authenticate, requireSuperAdmin, SUPER_TOKEN_PREFIX } from '../middleware/auth.js';
import { writeAudit } from '../services/audit.js';

const router = Router();
router.use(authenticate, requireSuperAdmin);

// Per sicurezza: un super token NON può gestire (creare/revocare) altri super
// token. Solo un Super Admin autenticato via login web può farlo.
router.use((req, _res, next) => {
  if (req.user?.isSuperToken) return next(forbidden('Operazione non consentita ai super token'));
  next();
});

function newSuperToken() {
  const raw = SUPER_TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash, prefix: raw.slice(0, 16) };
}

// Lista dei super token (mai la chiave in chiaro, solo prefisso e metadati).
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const tokens = await prisma.superApiToken.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, prefix: true, lastUsedAt: true,
        revokedAt: true, createdAt: true,
      },
    });
    res.json({ tokens });
  }),
);

const createSchema = z.object({ name: z.string().trim().min(1) });

// Genera un nuovo super token. La chiave in chiaro è mostrata UNA sola volta.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name } = createSchema.parse(req.body);
    const { raw, hash, prefix } = newSuperToken();
    const token = await prisma.superApiToken.create({
      data: { name, keyHash: hash, prefix, createdById: req.user.id },
    });
    await writeAudit({ userId: req.user.id, action: 'super-token.create', target: token.id, req });
    res.status(201).json({
      token: { id: token.id, name: token.name, prefix: token.prefix, createdAt: token.createdAt },
      secret: raw,
    });
  }),
);

// Revoca (disabilita) un super token. Non lo elimina, ne conserva lo storico.
router.post(
  '/:id/revoke',
  asyncHandler(async (req, res) => {
    const updated = await prisma.superApiToken
      .update({ where: { id: req.params.id }, data: { revokedAt: new Date() } })
      .catch(() => null);
    if (!updated) throw notFound('Super token non trovato');
    await writeAudit({ userId: req.user.id, action: 'super-token.revoke', target: updated.id, req });
    res.json({ ok: true });
  }),
);

// Elimina definitivamente un super token.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await prisma.superApiToken.delete({ where: { id: req.params.id } }).catch(() => {
      throw notFound('Super token non trovato');
    });
    await writeAudit({ userId: req.user.id, action: 'super-token.delete', target: req.params.id, req });
    res.json({ ok: true });
  }),
);

export default router;
