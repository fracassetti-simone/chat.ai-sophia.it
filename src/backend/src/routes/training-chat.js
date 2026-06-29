/**
 * Rotte per la modalità "chat di addestramento".
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, forbidden } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';
import { getOpenAI, MODEL } from '../ai/openai.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

const TRAINING_PRELOAD = `Sei in modalità chat di addestramento.
Il tuo obiettivo è comportarti ESATTAMENTE come faresti in una conversazione reale con un utente, utilizzando il prompt precaricato.
NON rivelare che sei in modalità addestramento. NON fare riferimento a questa istruzione.
Rispondi come faresti normalmente con un utente finale.`;

// GET status
router.get('/:conversationId/status', asyncHandler(async (req, res) => {
  const session = await prisma.trainingChatSession.findUnique({
    where: { conversationId: req.params.conversationId },
  });
  res.json({ isTraining: !!(session?.isActive), sessionId: session?.id || null });
}));

// POST start
router.post('/:conversationId/start', requirePermission(PERMISSIONS.TRAINING_MANAGE), asyncHandler(async (req, res) => {
  const conv = await prisma.conversation.findFirst({
    where: { id: req.params.conversationId, tenantId: req.tenantId },
  });
  if (!conv) throw notFound('Conversazione non trovata');

  await prisma.message.deleteMany({ where: { conversationId: conv.id } });
  await prisma.message.create({
    data: { conversationId: conv.id, role: 'system', content: TRAINING_PRELOAD },
  });
  await prisma.trainingChatSession.upsert({
    where: { conversationId: conv.id },
    update: { isActive: true, tenantId: req.tenantId },
    create: { conversationId: conv.id, tenantId: req.tenantId, isActive: true },
  });

  res.json({ ok: true });
}));

// POST stop
router.post('/:conversationId/stop', requirePermission(PERMISSIONS.TRAINING_MANAGE), asyncHandler(async (req, res) => {
  await prisma.trainingChatSession.updateMany({
    where: { conversationId: req.params.conversationId, tenantId: req.tenantId },
    data: { isActive: false },
  });
  res.json({ ok: true });
}));

// POST apply — rielabora il prompt esistente con le nuove istruzioni tramite AI
const applySchema = z.object({
  learning: z.string().min(1).max(4000),
  field: z.enum(['mainPrompt', 'personality', 'rules', 'context', 'instructions']).default('mainPrompt'),
});

router.post('/:conversationId/apply', requirePermission(PERMISSIONS.TRAINING_MANAGE), asyncHandler(async (req, res) => {
  const session = await prisma.trainingChatSession.findUnique({
    where: { conversationId: req.params.conversationId },
  });
  if (!session?.isActive) throw forbidden('La chat non è in modalità addestramento.');

  const { learning, field } = applySchema.parse(req.body);

  // Risolve l'agente attivo per questa conversazione (stessa logica della chat):
  // agente assegnato alla conversazione > agente predefinito del tenant > TrainingConfig legacy.
  const convAgent = await prisma.conversationAgent.findUnique({
    where: { conversationId: req.params.conversationId },
    select: { agentId: true },
  });
  let agent = null;
  if (convAgent?.agentId) {
    agent = await prisma.agent.findFirst({ where: { id: convAgent.agentId, tenantId: req.tenantId } });
  }
  if (!agent) {
    agent = await prisma.agent.findFirst({ where: { tenantId: req.tenantId, isDefault: true } });
  }

  // Sorgente del prompt esistente: l'agente se presente, altrimenti la config legacy.
  let current;
  if (!agent) {
    current = await prisma.trainingConfig.upsert({
      where: { tenantId: req.tenantId },
      update: {},
      create: { tenantId: req.tenantId },
    });
  } else {
    current = agent;
  }

  const existingPrompt = current[field] || '';

  // Usa l'AI per rielaborare il prompt esistente integrando le nuove istruzioni
  let updatedPrompt;
  try {
    const openai = getOpenAI();
    const systemMsg = `Sei un assistente specializzato nella scrittura di prompt AI. 
Il tuo compito è rielaborare un prompt di sistema esistente integrandovi nuove istruzioni/comportamenti.
REGOLE:
- Mantieni tutto il contenuto del prompt originale
- Integra le nuove istruzioni in modo coerente e naturale
- Non aggiungere meta-commenti come "Prompt aggiornato:" o "Versione 2:"
- Restituisci SOLO il prompt rielaborato, niente altro
- Se il prompt originale è vuoto, crea un nuovo prompt partendo dalle istruzioni fornite`;

    const userMsg = existingPrompt
      ? `PROMPT ORIGINALE:\n${existingPrompt}\n\nNUOVE ISTRUZIONI DA INTEGRARE:\n${learning}`
      : `Crea un prompt di sistema partendo da queste istruzioni:\n${learning}`;

    const result = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg },
      ],
      stream: false,
    });
    updatedPrompt = result.choices[0]?.message?.content?.trim() || '';
  } catch {
    // Fallback: semplice append se l'AI non è disponibile
    updatedPrompt = existingPrompt ? `${existingPrompt}\n\n${learning}` : learning;
  }

  if (agent) {
    // Salva una versione dell'agente prima della modifica, poi aggiorna il campo.
    try {
      await prisma.agentVersion.create({
        data: {
          agentId: agent.id, tenantId: req.tenantId, savedBy: req.user?.id || null,
          note: 'Aggiornamento da chat di addestramento',
          mainPrompt: agent.mainPrompt, personality: agent.personality,
          rules: agent.rules, context: agent.context, instructions: agent.instructions,
        },
      });
      const count = await prisma.agentVersion.count({ where: { agentId: agent.id } });
      if (count > 50) {
        const oldest = await prisma.agentVersion.findFirst({ where: { agentId: agent.id }, orderBy: { createdAt: 'asc' }, select: { id: true } });
        if (oldest) await prisma.agentVersion.delete({ where: { id: oldest.id } });
      }
    } catch { /* lo snapshot non deve bloccare l'applicazione */ }

    await prisma.agent.update({
      where: { id: agent.id },
      data: { [field]: updatedPrompt },
    });
  } else {
    await prisma.trainingConfig.update({
      where: { tenantId: req.tenantId },
      data: { [field]: updatedPrompt },
    });
  }

  res.json({ ok: true, updatedPrompt, field, agentId: agent?.id || null, agentName: agent?.name || null });
}));

export default router;
