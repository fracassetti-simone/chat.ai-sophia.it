import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../utils/http.js';
import { authenticate, requirePermission, tenantScope } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';
import { hashPassword } from '../utils/password.js';
import { writeAudit } from '../services/audit.js';

const router = Router();
router.use(authenticate, tenantScope);

// Un ADMIN può agire solo entro il proprio tenant; il SUPER_ADMIN ovunque.
function scopeWhere(req) {
  if (req.user.role === 'SUPER_ADMIN') {
    return req.tenantId ? { tenantId: req.tenantId } : {};
  }
  return { tenantId: req.user.tenantId };
}

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role,
    isActive: u.isActive, tenantId: u.tenantId, createdAt: u.createdAt,
    permissions: u.permissions?.map((p) => p.key) ?? [],
  };
}

router.get(
  '/',
  requirePermission(PERMISSIONS.USERS_READ),
  asyncHandler(async (req, res) => {
    const users = await prisma.user.findMany({
      where: scopeWhere(req),
      include: { permissions: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ users: users.map(publicUser) });
  }),
);

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional(),
  role: z.enum(['SUPER_ADMIN', 'ADMIN', 'MEMBER']).default('MEMBER'),
  tenantId: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

router.post(
  '/',
  requirePermission(PERMISSIONS.USERS_CREATE),
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);

    // Solo il Super Admin può creare SUPER_ADMIN o assegnare un tenant diverso dal proprio.
    if (body.role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      throw forbidden('Solo il Super Admin può creare altri Super Admin');
    }
    let tenantId = body.tenantId ?? req.tenantId ?? null;
    if (req.user.role !== 'SUPER_ADMIN') tenantId = req.user.tenantId; // forza isolamento
    if (body.role !== 'SUPER_ADMIN' && !tenantId) throw badRequest('tenantId richiesto');

    const exists = await prisma.user.findUnique({ where: { email: body.email } });
    if (exists) throw badRequest('Email già registrata');

    const user = await prisma.user.create({
      data: {
        email: body.email,
        name: body.name,
        role: body.role,
        tenantId: body.role === 'SUPER_ADMIN' ? null : tenantId,
        passwordHash: await hashPassword(body.password),
        permissions: body.permissions?.length
          ? { create: body.permissions.map((key) => ({ key })) }
          : undefined,
      },
      include: { permissions: true },
    });
    await writeAudit({ tenantId, userId: req.user.id, action: 'user.create', target: user.id, req });
    res.status(201).json({ user: publicUser(user) });
  }),
);

const updateSchema = z.object({
  name: z.string().optional(),
  role: z.enum(['SUPER_ADMIN', 'ADMIN', 'MEMBER']).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(6).optional(),
  permissions: z.array(z.string()).optional(),
});

router.patch(
  '/:id',
  requirePermission(PERMISSIONS.USERS_UPDATE),
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound('Utente non trovato');
    if (req.user.role !== 'SUPER_ADMIN' && target.tenantId !== req.user.tenantId) {
      throw forbidden();
    }

    const body = updateSchema.parse(req.body);
    if (body.role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') throw forbidden();

    const data = {
      name: body.name,
      role: body.role,
      isActive: body.isActive,
    };
    if (body.password) data.passwordHash = await hashPassword(body.password);

    if (body.permissions) {
      await prisma.userPermission.deleteMany({ where: { userId: target.id } });
      data.permissions = { create: body.permissions.map((key) => ({ key })) };
    }

    const user = await prisma.user.update({
      where: { id: target.id },
      data,
      include: { permissions: true },
    });
    await writeAudit({ tenantId: target.tenantId, userId: req.user.id, action: 'user.update', target: user.id, req });
    res.json({ user: publicUser(user) });
  }),
);

router.delete(
  '/:id',
  requirePermission(PERMISSIONS.USERS_DELETE),
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound('Utente non trovato');
    if (req.user.role !== 'SUPER_ADMIN' && target.tenantId !== req.user.tenantId) throw forbidden();
    if (target.id === req.user.id) throw badRequest('Non puoi eliminare te stesso');

    await prisma.user.delete({ where: { id: target.id } });
    await writeAudit({ tenantId: target.tenantId, userId: req.user.id, action: 'user.delete', target: target.id, req });
    res.json({ ok: true });
  }),
);

export default router;
