/**
 * Rotte Flussi (trigger globali su eventi WA/widget).
 *
 * GET    /api/flows           → Lista flussi del tenant
 * POST   /api/flows           → Crea flusso
 * PATCH  /api/flows/:id       → Aggiorna flusso
 * DELETE /api/flows/:id       → Elimina flusso
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant, requirePermission(PERMISSIONS.MODULES_MANAGE));

const TRIGGERS = ['WA_MESSAGE_RECEIVED', 'WA_FILE_RECEIVED', 'WA_AUDIO_RECEIVED', 'WIDGET_MESSAGE_RECEIVED'];

const flowSchema = z.object({
  name:        z.string().min(1).max(120),
  description: z.string().max(500).optional().default(''),
  trigger:     z.enum(['WA_MESSAGE_RECEIVED', 'WA_FILE_RECEIVED', 'WA_AUDIO_RECEIVED', 'WIDGET_MESSAGE_RECEIVED']),
  instruction: z.string().min(1).max(4000),
  status:      z.enum(['ACTIVE', 'PAUSED']).optional().default('ACTIVE'),
});

router.get('/', asyncHandler(async (req, res) => {
  const flows = await prisma.flow.findMany({
    where: { tenantId: req.tenantId },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ flows, triggers: TRIGGERS });
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = flowSchema.parse(req.body);
  const flow = await prisma.flow.create({ data: { ...data, tenantId: req.tenantId } });
  res.status(201).json({ flow });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const data = flowSchema.partial().parse(req.body);
  const { count } = await prisma.flow.updateMany({
    where: { id: req.params.id, tenantId: req.tenantId },
    data,
  });
  if (!count) throw notFound('Flusso non trovato');
  const updated = await prisma.flow.findUnique({ where: { id: req.params.id } });
  res.json({ flow: updated });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { count } = await prisma.flow.deleteMany({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!count) throw notFound('Flusso non trovato');
  res.json({ ok: true });
}));

export default router;

// ── Esegui i flussi che matchano un trigger ──────────────────────────────

/**
 * @param {string} tenantId
 * @param {string} trigger
 * @param {object} context  - coppie chiave/valore testuali del contesto evento
 * @param {Array}  imageBuffers - [{base64, mimeType}] immagini da passare a GPT vision
 */
export async function runFlows(tenantId, trigger, context = {}, imageBuffers = []) {
  const flows = await prisma.flow.findMany({
    where: { tenantId, trigger, status: 'ACTIVE' },
  });
  if (!flows.length) return;

  const { runChat } = await import('../ai/engine.js');

  for (const flow of flows) {
    try {
      const contextStr = Object.entries(context)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      const instruction = `${flow.instruction}\n\nContesto evento:\n${contextStr}`;

      // Messaggio utente con eventuale immagine allegata
      const userMsg = { role: 'user', content: instruction };
      if (imageBuffers.length > 0) {
        userMsg.images = imageBuffers;
      }

      await runChat({
        tenantId,
        source: 'FLOW',
        history: [userMsg],
        onToken: () => {},
      });

      await prisma.flow.update({
        where: { id: flow.id },
        data: { lastRunAt: new Date(), runCount: { increment: 1 } },
      });
    } catch (err) {
      console.error(`Flow ${flow.id} error:`, err.message);
    }
  }
}
