import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';
import { runChat } from '../ai/engine.js';
import { emitToTenant } from '../realtime/io.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

const ownScope = (req) => ({ tenantId: req.tenantId, userId: req.user.id });

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const conversations = await prisma.conversation.findMany({
      where: {
        ...ownScope(req),
        ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, updatedAt: true, createdAt: true },
    });
    res.json({ conversations });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const conversation = await prisma.conversation.create({
      data: { ...ownScope(req), title: req.body?.title || 'Nuova conversazione' },
    });
    res.status(201).json({ conversation });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, ...ownScope(req) },
      include: { messages: { where: { role: { not: 'system' } }, orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) throw notFound('Conversazione non trovata');
    res.json({ conversation });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const title = z.string().min(1).parse(req.body?.title);
    const { count } = await prisma.conversation.updateMany({
      where: { id: req.params.id, ...ownScope(req) },
      data: { title },
    });
    if (!count) throw notFound('Conversazione non trovata');
    res.json({ ok: true });
  }),
);

// DELETE /api/conversations/all — DEVE stare prima di /:id
router.delete(
  '/all',
  asyncHandler(async (req, res) => {
    const convs = await prisma.conversation.findMany({
      where: { tenantId: req.tenantId },
      select: { id: true },
    });
    const ids = convs.map((c) => c.id);
    if (ids.length) {
      await prisma.message.deleteMany({ where: { conversationId: { in: ids } } });
      await prisma.conversation.deleteMany({ where: { id: { in: ids } } });
    }
    res.json({ ok: true, deleted: ids.length });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.conversation.deleteMany({
      where: { id: req.params.id, ...ownScope(req) },
    });
    if (!count) throw notFound('Conversazione non trovata');
    res.json({ ok: true });
  }),
);

const sendSchema = z.object({
  content: z.string().min(1),
  attachments: z.array(z.any()).optional(),
  // documentIds: array di ID di documenti già caricati da allegare
  documentIds: z.array(z.string()).optional(),
});

// ── Costruisce il contenuto arricchito per l'AI includendo allegati ─────────
async function buildEnrichedContent(req, userContent, documentIds = []) {
  const parts = [userContent];

  // Carica profilo utente per numero WA e memoria
  const profile = await prisma.userProfile.findUnique({
    where: { userId: req.user.id },
  });

  // Inietta numero WA personale nel contesto se disponibile
  if (profile?.whatsappNumber) {
    parts.push(`\n[Contesto utente: il mio numero WhatsApp personale è ${profile.whatsappNumber}]`);
  }

  // Inietta memoria utente se presente
  if (profile?.memory && Object.keys(profile.memory).length > 0) {
    const memStr = Object.entries(profile.memory)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    parts.push(`[Dati memorizzati sull'utente: ${memStr}]`);
  }

  // Carica documenti allegati e inietta testo estratto + URL
  if (documentIds.length > 0) {
    const docs = await prisma.document.findMany({
      where: { id: { in: documentIds }, tenantId: req.tenantId },
      select: { id: true, filename: true, mimeType: true, extracted: true },
    });

    // Se l'utente ha un contatto collegato, sposta i documenti nella sua cartella cloud
    if (profile?.contactId) {
      try {
        // Trova o crea la cartella del contatto
        let folder = await prisma.cloudFolder.findFirst({
          where: { tenantId: req.tenantId, contactId: profile.contactId },
          select: { id: true },
        });
        if (!folder) {
          const contact = await prisma.contact.findUnique({ where: { id: profile.contactId } });
          const folderName = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() || contact?.company || 'Contatto';
          folder = await prisma.cloudFolder.create({
            data: { tenantId: req.tenantId, name: folderName, contactId: profile.contactId, parentId: null },
          });
        }
        // Assegna tutti i documenti caricati alla cartella e al contatto
        await prisma.$executeRawUnsafe(
          `UPDATE "Document" SET "folderId" = $1, "contactId" = $2 WHERE id = ANY($3::text[]) AND "tenantId" = $4`,
          folder.id, profile.contactId, documentIds, req.tenantId
        );
      } catch { /* non blocca l'invio del messaggio */ }
    }

    const base = process.env.PUBLIC_API_URL ||
      (req.secure ? 'https' : 'http') + '://' + req.headers.host;

    for (const doc of docs) {
      const url = `${base}/api/documents/${doc.id}/file`;
      parts.push(`\n[Documento allegato: "${doc.filename}"]`);
      parts.push(`URL pubblico (usalo per inviare via WhatsApp o API): ${url}`);
      if (doc.extracted && doc.extracted.trim()) {
        // Tronca a 8000 char per non esplodere il context
        const text = doc.extracted.trim().slice(0, 8000);
        parts.push(`Contenuto del documento:\n${text}${doc.extracted.length > 8000 ? '\n[... documento troncato ...]' : ''}`);
      }
    }
  }

  return parts.join('\n');
}

// Invia un messaggio e riceve la risposta AI in streaming (Server-Sent Events).
router.post(
  '/:id/messages',
  requirePermission(PERMISSIONS.CHAT_USE),
  asyncHandler(async (req, res) => {
    const { content, attachments, documentIds = [] } = sendSchema.parse(req.body);

    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, ...ownScope(req) },
      include: { messages: { where: { role: { not: 'system' } }, orderBy: { createdAt: 'asc' }, take: 40 } },
    });
    if (!conversation) throw notFound('Conversazione non trovata');

    // Persiste il messaggio utente (contenuto originale, senza enrichment)
    await prisma.message.create({
      data: { conversationId: conversation.id, role: 'user', content, attachments: attachments ?? undefined },
    });

    if (conversation.title === 'Nuova conversazione') {
      const title = content.slice(0, 48) + (content.length > 48 ? '…' : '');
      await prisma.conversation.update({ where: { id: conversation.id }, data: { title } });
    }

    // Costruisce l'history per l'AI — include il messaggio arricchito come ultimo elemento
    const enrichedUserContent = await buildEnrichedContent(req, content, documentIds);

    const history = [
      ...conversation.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: enrichedUserContent },
    ];

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      // Controlla se questa conversazione è in modalità addestramento
      const [trainingSession, conversationAgent] = await Promise.all([
        prisma.trainingChatSession.findUnique({
          where: { conversationId: conversation.id },
          select: { isActive: true },
        }),
        prisma.conversationAgent.findUnique({
          where: { conversationId: conversation.id },
          select: { agentId: true },
        }),
      ]);
      const isTraining = !!(trainingSession?.isActive);
      const activeAgentId = conversationAgent?.agentId || null;

      const { content: answer, toolCalls } = await runChat({
        tenantId: req.tenantId,
        conversationId: conversation.id,
        userId: req.user.id,
        isTraining,
        source: isTraining ? 'TRAINING' : 'CHAT',
        userRole: req.user.role,
        agentId: activeAgentId,
        history,
        onToken: (delta) => send('token', { delta }),
        onToolCall: (call) => send('tool', call),
        onToolResult: (res) => send('tool_result', res),
      });

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: 'assistant',
          content: answer,
          toolCalls: toolCalls.length ? toolCalls : undefined,
        },
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });

      // Se chat sincronizzata WA, invia anche su WhatsApp
      try {
        const sync = await prisma.whatsAppSyncedConversation.findUnique({
          where: { conversationId: conversation.id },
        });
        if (sync) {
          const waInst = await prisma.moduleInstance.findUnique({
            where: { tenantId_moduleKey: { tenantId: req.tenantId, moduleKey: 'whatsapp' } },
          });
          const cfg = waInst?.config || {};
          if (cfg.accessToken && cfg.phoneNumberId) {
            const contact = await prisma.whatsAppContact.findUnique({
              where: { tenantId_phone: { tenantId: req.tenantId, phone: sync.phone } },
            });
            if (contact?.sessionExpiresAt > new Date()) {
              await fetch(`https://graph.facebook.com/v25.0/${cfg.phoneNumberId}/messages`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ messaging_product: 'whatsapp', to: sync.phone, type: 'text', text: { body: answer } }),
              }).catch(() => {});
            }
          }
        }
      } catch { /* non blocca */ }

      emitToTenant(req.tenantId, 'conversation:updated', { id: conversation.id });
      send('done', { ok: true, toolCalls });
    } catch (err) {
      send('error', { message: err.message });
    } finally {
      res.end();
    }
  }),
);

export default router;
