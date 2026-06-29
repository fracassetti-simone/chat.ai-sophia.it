import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound } from '../utils/http.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { writeAudit } from '../services/audit.js';

const router = Router();
router.use(authenticate, requireSuperAdmin);

function newKey() {
  const raw = 'sph_' + crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash, prefix: raw.slice(0, 12) };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const where = req.query.tenantId ? { tenantId: String(req.query.tenantId) } : {};
    const keys = await prisma.apiKey.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, description: true, tenantId: true, prefix: true,
        permissions: true, enabled: true, lastUsedAt: true, createdAt: true,
      },
    });
    res.json({ apiKeys: keys });
  }),
);

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tenantId: z.string(),
  permissions: z.array(z.string()).default([]),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const { raw, hash, prefix } = newKey();
    const apiKey = await prisma.apiKey.create({
      data: {
        name: body.name,
        description: body.description ?? '',
        tenantId: body.tenantId,
        permissions: body.permissions,
        keyHash: hash,
        prefix,
      },
    });
    await writeAudit({ tenantId: body.tenantId, userId: req.user.id, action: 'apikey.create', target: apiKey.id, req });
    // La chiave in chiaro è mostrata UNA sola volta.
    res.status(201).json({ apiKey: { ...apiKey, keyHash: undefined }, secret: raw });
  }),
);

router.post(
  '/:id/regenerate',
  asyncHandler(async (req, res) => {
    const { raw, hash, prefix } = newKey();
    const updated = await prisma.apiKey
      .update({ where: { id: req.params.id }, data: { keyHash: hash, prefix } })
      .catch(() => null);
    if (!updated) throw notFound('API Key non trovata');
    await writeAudit({ tenantId: updated.tenantId, userId: req.user.id, action: 'apikey.regenerate', target: updated.id, req });
    res.json({ secret: raw, prefix });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = z.object({ enabled: z.boolean().optional(), permissions: z.array(z.string()).optional() }).parse(req.body);
    const updated = await prisma.apiKey.update({ where: { id: req.params.id }, data }).catch(() => null);
    if (!updated) throw notFound('API Key non trovata');
    res.json({ ok: true });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await prisma.apiKey.delete({ where: { id: req.params.id } }).catch(() => {
      throw notFound('API Key non trovata');
    });
    await writeAudit({ userId: req.user.id, action: 'apikey.delete', target: req.params.id, req });
    res.json({ ok: true });
  }),
);

export default router;
