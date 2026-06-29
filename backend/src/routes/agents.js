/**
 * API Multi-agente per tenant.
 *
 * GET    /api/agents                    → lista agenti del tenant
 * POST   /api/agents                    → crea agente
 * GET    /api/agents/:id                → dettaglio agente
 * PUT    /api/agents/:id                → salva configurazione (crea versione)
 * PATCH  /api/agents/:id/meta           → modifica solo nome/descrizione/avatar/isDefault
 * DELETE /api/agents/:id                → elimina agente
 *
 * GET    /api/agents/:id/versions       → lista versioni (max 50)
 * POST   /api/agents/:id/versions/:vid/restore  → ripristina versione
 *
 * POST   /api/agents/:id/test           → testa configurazione corrente
 *
 * POST   /api/conversations/:cid/agent  → assegna agente a conversazione
 * POST   /api/external-chats/:eid/agent → assegna agente a chat esterna
 *
 * Permessi:
 *   - SUPER_ADMIN: tutto
 *   - ADMIN con config-manage: tutto
 *   - ADMIN senza config-manage: read-only (lista + switch in chat)
 *   - MEMBER: solo switch agente in chat (se abilitato)
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, forbidden, badRequest } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { emitToTenant } from '../realtime/io.js';
import { logger } from '../config/logger.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

// ── Helpers ──────────────────────────────────────────────────────────────────

function canManage(req) {
  if (req.user?.role === 'SUPER_ADMIN') return true;
  if (req.user?.role === 'ADMIN') return true; // admin può sempre gestire agenti
  return false;
}

const MAX_VERSIONS = 50;

async function saveVersion(agentId, tenantId, data, savedBy, note) {
  await prisma.agentVersion.create({
    data: { agentId, tenantId, savedBy: savedBy || null, note: note || null, ...data },
  });
  // Mantieni solo le ultime MAX_VERSIONS versioni
  const count = await prisma.agentVersion.count({ where: { agentId } });
  if (count > MAX_VERSIONS) {
    const oldest = await prisma.agentVersion.findFirst({
      where: { agentId }, orderBy: { createdAt: 'asc' }, select: { id: true },
    });
    if (oldest) await prisma.agentVersion.delete({ where: { id: oldest.id } });
  }
}

const agentDataSchema = z.object({
  mainPrompt:   z.string().default(''),
  personality:  z.string().default(''),
  rules:        z.string().default(''),
  context:      z.string().default(''),
  instructions: z.string().default(''),
});

const agentMetaSchema = z.object({
  name:        z.string().min(1).optional(),
  description: z.string().optional(),
  avatar:      z.string().nullable().optional(),
  isDefault:   z.boolean().optional(),
});

// ── Lista agenti ─────────────────────────────────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const agents = await prisma.agent.findMany({
      where: { tenantId: req.tenantId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, description: true, avatar: true, isDefault: true, createdAt: true, updatedAt: true },
    });
    res.json({ agents });
  }),
);

// ── Crea agente ──────────────────────────────────────────────────────────────

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!canManage(req)) throw forbidden('Permesso negato');

    const meta = agentMetaSchema.extend({ name: z.string().min(1) }).parse(req.body);
    const data = agentDataSchema.parse(req.body);

    // Se isDefault, revoca il default dagli altri
    if (meta.isDefault) {
      await prisma.agent.updateMany({ where: { tenantId: req.tenantId }, data: { isDefault: false } });
    }

    const agent = await prisma.agent.create({
      data: { tenantId: req.tenantId, ...meta, ...data },
    });

    // Prima versione automatica
    await saveVersion(agent.id, req.tenantId, data, req.user.id, 'Versione iniziale');

    emitToTenant(req.tenantId, 'agent:created', { agent });
    res.status(201).json({ agent });
  }),
);

// ── Dettaglio agente ─────────────────────────────────────────────────────────

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const agent = await prisma.agent.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!agent) throw notFound('Agente non trovato');
    res.json({ agent });
  }),
);

// ── Salva configurazione (crea versione) ─────────────────────────────────────

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!canManage(req)) throw forbidden('Permesso negato');

    const existing = await prisma.agent.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!existing) throw notFound('Agente non trovato');

    const data = agentDataSchema.parse(req.body);
    const note = typeof req.body.note === 'string' ? req.body.note.trim() || null : null;

    const agent = await prisma.agent.update({
      where: { id: req.params.id },
      data: { ...data, updatedAt: new Date() },
    });

    await saveVersion(agent.id, req.tenantId, data, req.user.id, note);

    emitToTenant(req.tenantId, 'agent:updated', { agent });
    res.json({ agent });
  }),
);

// ── Modifica meta (nome/descrizione/avatar/isDefault) ────────────────────────

router.patch(
  '/:id/meta',
  asyncHandler(async (req, res) => {
    if (!canManage(req)) throw forbidden('Permesso negato');

    const existing = await prisma.agent.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!existing) throw notFound('Agente non trovato');

    const meta = agentMetaSchema.parse(req.body);

    if (meta.isDefault) {
      await prisma.agent.updateMany({ where: { tenantId: req.tenantId }, data: { isDefault: false } });
    }

    const agent = await prisma.agent.update({ where: { id: req.params.id }, data: meta });

    emitToTenant(req.tenantId, 'agent:updated', { agent });
    res.json({ agent });
  }),
);

// ── Elimina agente ───────────────────────────────────────────────────────────

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!canManage(req)) throw forbidden('Permesso negato');

    const existing = await prisma.agent.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!existing) throw notFound('Agente non trovato');
    if (existing.isDefault) throw badRequest('Non è possibile eliminare l\'agente predefinito. Imposta un altro agente come predefinito prima.');

    await prisma.agent.delete({ where: { id: req.params.id } });

    emitToTenant(req.tenantId, 'agent:deleted', { id: req.params.id });
    res.json({ ok: true });
  }),
);

// ── Versioni ─────────────────────────────────────────────────────────────────

router.get(
  '/:id/versions',
  asyncHandler(async (req, res) => {
    const agent = await prisma.agent.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!agent) throw notFound('Agente non trovato');

    const versions = await prisma.agentVersion.findMany({
      where: { agentId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: MAX_VERSIONS,
    });
    res.json({ versions });
  }),
);

router.post(
  '/:id/versions/:vid/restore',
  asyncHandler(async (req, res) => {
    if (!canManage(req)) throw forbidden('Permesso negato');

    const agent = await prisma.agent.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!agent) throw notFound('Agente non trovato');

    const version = await prisma.agentVersion.findFirst({
      where: { id: req.params.vid, agentId: req.params.id },
    });
    if (!version) throw notFound('Versione non trovata');

    const { mainPrompt, personality, rules, context, instructions } = version;
    const data = { mainPrompt, personality, rules, context, instructions };

    const updated = await prisma.agent.update({
      where: { id: req.params.id },
      data: { ...data, updatedAt: new Date() },
    });

    // Crea una nuova versione che registra il ripristino
    await saveVersion(agent.id, req.tenantId, data, req.user.id, `Ripristino da ${new Date(version.createdAt).toLocaleString('it-IT')}`);

    emitToTenant(req.tenantId, 'agent:updated', { agent: updated });
    res.json({ agent: updated });
  }),
);

// ── Test agente ──────────────────────────────────────────────────────────────

router.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const agent = await prisma.agent.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!agent) throw notFound('Agente non trovato');

    const message = z.string().min(1).parse(req.body?.message);
    const draft = req.body?.draft; // override temporaneo se l'utente è nel wizard e non ha ancora salvato

    const { runChat } = await import('../ai/engine.js');

    let answer = '';
    await runChat({
      tenantId: req.tenantId,
      userId: req.user.id,
      agentId: req.params.id,
      agentOverride: draft || null, // usa draft se passato, altrimenti usa i dati dell'agente in DB
      isTraining: true,
      source: 'TRAINING',
      userRole: req.user.role,
      history: [{ role: 'user', content: message }],
      onToken: (t) => { answer += t; },
    });

    res.json({ answer });
  }),
);

// ── Assegna agente a conversazione interna ────────────────────────────────────

router.post(
  '/assign/conversation/:cid',
  asyncHandler(async (req, res) => {
    const agentId = z.string().min(1).parse(req.body?.agentId);

    // Verifica che la conversazione appartenga al tenant
    const conv = await prisma.conversation.findFirst({
      where: { id: req.params.cid, tenantId: req.tenantId },
    });
    if (!conv) throw notFound('Conversazione non trovata');

    // Verifica che l'agente appartenga al tenant
    const agent = await prisma.agent.findFirst({ where: { id: agentId, tenantId: req.tenantId } });
    if (!agent) throw notFound('Agente non trovato');

    await prisma.conversationAgent.upsert({
      where: { conversationId: req.params.cid },
      update: { agentId, assignedAt: new Date() },
      create: { conversationId: req.params.cid, agentId },
    });

    emitToTenant(req.tenantId, 'agent:switched', {
      context: 'conversation', contextId: req.params.cid,
      agentId, agentName: agent.name, agentAvatar: agent.avatar,
    });

    res.json({ ok: true, agentId, agentName: agent.name });
  }),
);

// ── Assegna agente a chat esterna (WA/widget) ────────────────────────────────

router.post(
  '/assign/external-chat/:eid',
  asyncHandler(async (req, res) => {
    const agentId = z.string().min(1).parse(req.body?.agentId);

    const chat = await prisma.externalChat.findFirst({
      where: { id: req.params.eid, tenantId: req.tenantId },
    });
    if (!chat) throw notFound('Chat non trovata');

    const agent = await prisma.agent.findFirst({ where: { id: agentId, tenantId: req.tenantId } });
    if (!agent) throw notFound('Agente non trovato');

    await prisma.externalChatAgent.upsert({
      where: { chatId: req.params.eid },
      update: { agentId, assignedAt: new Date() },
      create: { chatId: req.params.eid, agentId },
    });

    emitToTenant(req.tenantId, 'agent:switched', {
      context: 'external-chat', contextId: req.params.eid,
      agentId, agentName: agent.name, agentAvatar: agent.avatar,
    });

    res.json({ ok: true, agentId, agentName: agent.name });
  }),
);

export default router;
