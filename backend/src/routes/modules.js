import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, badRequest } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';
import { registry } from '../modules/registry.js';
import { writeAudit } from '../services/audit.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

// Stato di tutti i moduli per il tenant corrente.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const modules = await registry.instancesForTenant(req.tenantId);
    res.json({ modules });
  }),
);

const actionSchema = z.object({
  action: z.enum(['install', 'uninstall', 'enable', 'disable']),
});

router.post(
  '/:key/action',
  asyncHandler(async (req, res) => {
    // Solo il SUPER_ADMIN può attivare/disattivare moduli per i tenant
    if (req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Solo il Super Admin può gestire i moduli.' });
    }
    const def = registry.get(req.params.key);
    if (!def) throw notFound('Modulo inesistente');
    const { action } = actionSchema.parse(req.body);

    const patch = {
      install: { installed: true, enabled: true },
      uninstall: { installed: false, enabled: false },
      enable: { enabled: true },
      disable: { enabled: false },
    }[action];

    const instance = await prisma.moduleInstance.upsert({
      where: { tenantId_moduleKey: { tenantId: req.tenantId, moduleKey: def.key } },
      update: patch,
      create: { tenantId: req.tenantId, moduleKey: def.key, config: def.defaultConfig ?? {}, ...patch },
    });
    await writeAudit({ tenantId: req.tenantId, userId: req.user.id, action: `module.${action}`, target: def.key, req });
    res.json({ module: instance });
  }),
);

router.put(
  '/:key/config',
  requirePermission(PERMISSIONS.MODULES_MANAGE),
  asyncHandler(async (req, res) => {
    const def = registry.get(req.params.key);
    if (!def) throw notFound('Modulo inesistente');

    let config = req.body?.config ?? {};
    if (def.configSchema) {
      const parsed = def.configSchema.safeParse(config);
      if (!parsed.success) throw badRequest('Configurazione non valida', parsed.error.flatten());
      config = parsed.data;
    }

    const instance = await prisma.moduleInstance.upsert({
      where: { tenantId_moduleKey: { tenantId: req.tenantId, moduleKey: def.key } },
      update: { config },
      create: { tenantId: req.tenantId, moduleKey: def.key, config, installed: true, enabled: true },
    });
    await writeAudit({ tenantId: req.tenantId, userId: req.user.id, action: 'module.config', target: def.key, req });
    res.json({ module: instance });
  }),
);

export default router;
