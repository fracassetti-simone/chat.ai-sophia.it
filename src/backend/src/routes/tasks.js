import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant, requirePermission(PERMISSIONS.CHAT_USE));

// Elenca i task in background del tenant, opzionalmente filtrati per conversazione.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const conversationId = req.query.conversationId?.toString();
    const tasks = await prisma.backgroundTask.findMany({
      where: { tenantId: req.tenantId, ...(conversationId ? { conversationId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ tasks });
  }),
);

// Schema unificato: accetta RETRY (dal pulsante in chat), ONCE e RECURRING (dall'UI Automazioni)
const createTaskSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('RETRY'),
    conversationId: z.string().min(1),
    endpointId: z.string().min(1),
    endpointName: z.string().optional(),
    variables: z.record(z.any()).optional(),
    delaySeconds: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('ONCE'),
    instruction: z.string().min(1).max(4000),
    runAt: z.string().datetime(),
    conversationId: z.string().optional().nullable(),
  }),
  z.object({
    kind: z.literal('RECURRING'),
    instruction: z.string().min(1).max(4000),
    intervalSeconds: z.number().int().min(60).max(604800),
    conversationId: z.string().optional().nullable(),
  }),
]);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = createTaskSchema.parse(req.body);

    if (data.kind === 'RETRY') {
      const task = await prisma.backgroundTask.create({
        data: {
          tenantId: req.tenantId,
          conversationId: data.conversationId,
          kind: 'RETRY',
          instruction: `Riprova chiamata a "${data.endpointName || data.endpointId}"`,
          payload: { endpointId: data.endpointId, variables: data.variables ?? {} },
          runAt: new Date(Date.now() + data.delaySeconds * 1000),
          status: 'ACTIVE',
        },
      });
      return res.status(201).json({ task });
    }

    if (data.kind === 'ONCE') {
      const runAt = new Date(data.runAt);
      if (runAt <= new Date()) return res.status(400).json({ error: 'La data deve essere nel futuro.' });
      const task = await prisma.backgroundTask.create({
        data: {
          tenantId: req.tenantId,
          conversationId: data.conversationId || undefined,
          kind: 'ONCE',
          instruction: data.instruction,
          runAt,
          status: 'ACTIVE',
        },
      });
      return res.status(201).json({ task });
    }

    if (data.kind === 'RECURRING') {
      const task = await prisma.backgroundTask.create({
        data: {
          tenantId: req.tenantId,
          conversationId: data.conversationId || undefined,
          kind: 'RECURRING',
          instruction: data.instruction,
          intervalSeconds: data.intervalSeconds,
          runAt: new Date(Date.now() + data.intervalSeconds * 1000),
          status: 'ACTIVE',
        },
      });
      return res.status(201).json({ task });
    }
  }),
);

// Modifica completa (istruzione, orario, intervallo) — DEVE stare prima di /:id
router.patch(
  '/:id/edit',
  asyncHandler(async (req, res) => {
    const data = z.object({
      instruction: z.string().min(1).max(4000).optional(),
      runAt: z.string().datetime().optional(),
      intervalSeconds: z.number().int().min(60).optional(),
    }).parse(req.body || {});
    const update = {};
    if (data.instruction) update.instruction = data.instruction;
    if (data.runAt) {
      const runAt = new Date(data.runAt);
      if (runAt < new Date(Date.now() - 30000)) return res.status(400).json({ error: 'La data deve essere nel futuro.' });
      update.runAt = runAt;
      update.status = 'ACTIVE';
    }
    if (data.intervalSeconds) update.intervalSeconds = data.intervalSeconds;
    const { count } = await prisma.backgroundTask.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: update,
    });
    if (!count) throw notFound('Task non trovato');
    res.json({ ok: true });
  }),
);

// Pausa / riattiva un task.
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const status = z.enum(['ACTIVE', 'PAUSED']).parse(req.body?.status);
    const { count } = await prisma.backgroundTask.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: { status },
    });
    if (!count) throw notFound('Task non trovato');
    res.json({ ok: true });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.backgroundTask.deleteMany({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!count) throw notFound('Task non trovato');
    res.json({ ok: true });
  }),
);

export default router;
