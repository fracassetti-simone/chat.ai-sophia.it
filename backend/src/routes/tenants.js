import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound } from '../utils/http.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { registry } from '../modules/registry.js';
import { writeAudit } from '../services/audit.js';

const router = Router();
router.use(authenticate, requireSuperAdmin);

const slugify = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { users: true, conversations: true } } },
    });
    res.json({ tenants });
  }),
);

const createSchema = z.object({ name: z.string().trim().min(1), slug: z.string().optional() });

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, slug } = createSchema.parse(req.body);

    // Genera uno slug univoco: se occupato, aggiunge un suffisso numerico.
    // Così la creazione non fallisce mai per un nome duplicato.
    const base = (slug ? slugify(slug) : slugify(name)) || 'azienda';
    let finalSlug = base;
    let n = 2;
    // eslint-disable-next-line no-await-in-loop
    while (await prisma.tenant.findUnique({ where: { slug: finalSlug } })) {
      finalSlug = `${base}-${n++}`;
    }

    const tenant = await prisma.tenant.create({
      data: { name, slug: finalSlug, training: { create: {} } },
    });
    // Installa i moduli di default per la nuova azienda.
    await registry.installDefaultsForTenant(tenant.id);
    await writeAudit({ userId: req.user.id, action: 'tenant.create', target: tenant.id, req });
    res.status(201).json({ tenant });
  }),
);

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  isActive: z.boolean().optional(),
});

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data }).catch(() => null);
    if (!tenant) throw notFound('Azienda non trovata');
    await writeAudit({ userId: req.user.id, action: 'tenant.update', target: tenant.id, req });
    res.json({ tenant });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await prisma.tenant.delete({ where: { id: req.params.id } }).catch(() => {
      throw notFound('Azienda non trovata');
    });
    await writeAudit({ userId: req.user.id, action: 'tenant.delete', target: req.params.id, req });
    res.json({ ok: true });
  }),
);

export default router;
