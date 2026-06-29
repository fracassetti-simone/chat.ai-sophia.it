import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';
import { writeAudit } from '../services/audit.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const training = await prisma.trainingConfig.upsert({
      where: { tenantId: req.tenantId },
      update: {},
      create: { tenantId: req.tenantId },
    });
    res.json({ training });
  }),
);

const schema = z.object({
  mainPrompt: z.string().optional(),
  personality: z.string().optional(),
  rules: z.string().optional(),
  context: z.string().optional(),
  instructions: z.string().optional(),
});

router.put(
  '/',
  requirePermission(PERMISSIONS.TRAINING_MANAGE),
  asyncHandler(async (req, res) => {
    const data = schema.parse(req.body);
    const training = await prisma.trainingConfig.upsert({
      where: { tenantId: req.tenantId },
      update: data,
      create: { tenantId: req.tenantId, ...data },
    });
    // Salva una versione storica (max 20 per tenant — elimina le più vecchie)
    await prisma.trainingVersion.create({
      data: { tenantId: req.tenantId, savedBy: req.user.id, ...data },
    });
    const count = await prisma.trainingVersion.count({ where: { tenantId: req.tenantId } });
    if (count > 20) {
      const oldest = await prisma.trainingVersion.findFirst({
        where: { tenantId: req.tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true },
      });
      if (oldest) await prisma.trainingVersion.delete({ where: { id: oldest.id } });
    }
    await writeAudit({ tenantId: req.tenantId, userId: req.user.id, action: 'training.update', req });
    res.json({ training });
  }),
);

router.get(
  '/versions',
  requirePermission(PERMISSIONS.TRAINING_MANAGE),
  asyncHandler(async (req, res) => {
    const versions = await prisma.trainingVersion.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, savedBy: true, note: true, mainPrompt: true, personality: true, rules: true, context: true, instructions: true },
    });
    res.json({ versions });
  }),
);

router.post(
  '/versions/:id/restore',
  requirePermission(PERMISSIONS.TRAINING_MANAGE),
  asyncHandler(async (req, res) => {
    const version = await prisma.trainingVersion.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!version) throw notFound('Versione non trovata');
    const { mainPrompt, personality, rules, context, instructions } = version;
    await prisma.trainingConfig.upsert({
      where: { tenantId: req.tenantId },
      update: { mainPrompt, personality, rules, context, instructions },
      create: { tenantId: req.tenantId, mainPrompt, personality, rules, context, instructions },
    });
    res.json({ ok: true, training: { mainPrompt, personality, rules, context, instructions } });
  }),
);

router.post(
  '/test',
  requirePermission(PERMISSIONS.TRAINING_MANAGE),
  asyncHandler(async (req, res) => {
    const { message, draft } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'Messaggio vuoto' });
    const { runChat } = await import('../ai/engine.js');

    // Se viene passato un draft, salvalo temporaneamente prima di testare
    // così il prompt riflette la configurazione attuale degli step
    if (draft && typeof draft === 'object') {
      await prisma.trainingConfig.upsert({
        where: { tenantId: req.tenantId },
        update: draft,
        create: { tenantId: req.tenantId, ...draft },
      });
    }

    let answer = '';
    await runChat({
      tenantId: req.tenantId,
      userId: req.user.id,
      isTraining: true,
      source: 'TRAINING',
      userRole: req.user.role,
      history: [{ role: 'user', content: message }],
      onToken: (t) => { answer += t; },
    });
    res.json({ answer });
  }),
);

export default router;
