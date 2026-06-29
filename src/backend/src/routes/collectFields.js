import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

// Solo admin e superadmin possono gestire i dati da collezionare
function requireAdmin(req, _res, next) {
  if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'ADMIN') return next();
  next({ status: 403, message: 'Sezione riservata agli amministratori.' });
}

const fieldSchema = z.object({
  label:       z.string().trim().min(1).max(80),
  key:         z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/, 'Usa solo lettere minuscole, numeri e underscore'),
  description: z.string().trim().max(300).optional().nullable(),
  fieldType:   z.enum(['text', 'email', 'phone', 'number', 'date', 'boolean']).default('text'),
  required:    z.boolean().default(false),
  order:       z.number().int().optional(),
  active:      z.boolean().default(true),
});

// GET /api/collect-fields
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const fields = await prisma.collectField.findMany({
    where: { tenantId: req.tenantId },
    orderBy: { order: 'asc' },
  });
  res.json({ fields });
}));

// POST /api/collect-fields
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const data = fieldSchema.parse(req.body || {});
  const maxOrder = await prisma.collectField.aggregate({ where: { tenantId: req.tenantId }, _max: { order: true } });
  const field = await prisma.collectField.create({
    data: { tenantId: req.tenantId, ...data, order: data.order ?? (maxOrder._max.order ?? 0) + 1 },
  });
  res.status(201).json({ field });
}));

// PATCH /api/collect-fields/reorder  { ids: ['id1','id2',...] }
// MUST be before /:id to avoid Express treating 'reorder' as an id
router.patch('/reorder', requireAdmin, asyncHandler(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string()) }).parse(req.body || {});
  await Promise.all(ids.map((id, i) =>
    prisma.collectField.updateMany({ where: { id, tenantId: req.tenantId }, data: { order: i } })
  ));
  res.json({ ok: true });
}));

// PATCH /api/collect-fields/:id
router.patch('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const data = fieldSchema.partial().parse(req.body || {});
  const { count } = await prisma.collectField.updateMany({
    where: { id: req.params.id, tenantId: req.tenantId },
    data,
  });
  if (!count) throw notFound('Campo non trovato');
  res.json({ ok: true });
}));

// DELETE /api/collect-fields/:id
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { count } = await prisma.collectField.deleteMany({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!count) throw notFound('Campo non trovato');
  res.json({ ok: true });
}));


export default router;
