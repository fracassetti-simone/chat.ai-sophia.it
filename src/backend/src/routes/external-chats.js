/**
 * Rotte Chat Esterne.
 *
 * GET    /api/external-chats                → Lista
 * GET    /api/external-chats/:id            → Messaggi chat
 * POST   /api/external-chats                → Crea nuova chat WA verso un numero
 * POST   /api/external-chats/:id/send       → Invia testo come operatore
 * POST   /api/external-chats/:id/send-media → Invia immagine/documento come operatore
 * DELETE /api/external-chats/:id            → Elimina chat
 */

import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, badRequest } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { logger } from '../config/logger.js';
import { config } from '../config/index.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 },
});

// ── Helper WA ──────────────────────────────────────────────────────────────

async function getWAConfig(tenantId) {
  const inst = await prisma.moduleInstance.findUnique({
    where: { tenantId_moduleKey: { tenantId, moduleKey: 'whatsapp' } },
  });
  return inst?.config || {};
}

async function sendWAText(cfg, to, text) {
  const r = await fetch(`https://graph.facebook.com/v25.0/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`WA API: ${JSON.stringify(data.error || data)}`);
  return data;
}

async function sendWATemplate(cfg, to) {
  const lang = cfg.templateLanguage === 'en' ? 'en' : 'it';
  const r = await fetch(`https://graph.facebook.com/v25.0/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: 'conversation_continue',
        language: { code: lang },
        components: [{
          type: 'button', sub_type: 'quick_reply', index: 0,
          parameters: [{ type: 'payload', payload: lang === 'en' ? 'Continue' : 'Continua' }],
        }],
      },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`WA template: ${JSON.stringify(data.error || data)}`);
  return data;
}

async function sendWAMedia(cfg, to, type, mediaUrl, filename, caption) {
  const body = { messaging_product: 'whatsapp', to, type };
  if (type === 'image')    body.image    = { link: mediaUrl, caption: caption || '' };
  if (type === 'document') body.document = { link: mediaUrl, filename: filename || 'file', caption: caption || '' };
  if (type === 'audio')    body.audio    = { link: mediaUrl };
  if (type === 'video')    body.video    = { link: mediaUrl, caption: caption || '' };
  const r = await fetch(`https://graph.facebook.com/v25.0/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`WA media: ${JSON.stringify(data.error || data)}`);
  return data;
}

/** Controlla se la sessione WA 24h è aperta o se l'ultimo messaggio è >6h fa */
async function needsTemplate(tenantId, externalId) {
  const contact = await prisma.whatsAppContact.findUnique({
    where: { tenantId_phone: { tenantId, phone: externalId } },
  });
  if (!contact?.sessionExpiresAt || contact.sessionExpiresAt < new Date()) return true;
  return false;
}

// ── GET /api/external-chats ───────────────────────────────────────────────

router.get('/', asyncHandler(async (req, res) => {
  const source = req.query.source;
  const chats = await prisma.externalChat.findMany({
    where: { tenantId: req.tenantId, ...(source ? { source } : {}) },
    orderBy: { lastMessageAt: 'desc' },
    include: {
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true, role: true, createdAt: true } },
    },
  });
  res.json({ chats });
}));

// ── GET /api/external-chats/:id ──────────────────────────────────────────

router.get('/:id', asyncHandler(async (req, res) => {
  const chat = await prisma.externalChat.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!chat) throw notFound('Chat non trovata');
  res.json({ chat });
}));

// ── POST /api/external-chats — nuova chat verso un numero WA ─────────────

const newChatSchema = z.object({
  phone:       z.string().regex(/^\d{7,15}$/, 'Numero senza + (es. 393331234567)'),
  displayName: z.string().max(120).optional(),
  message:     z.string().max(4096).optional(), // messaggio iniziale opzionale
});

router.post('/', asyncHandler(async (req, res) => {
  const { phone, displayName, message } = newChatSchema.parse(req.body);

  const cfg = await getWAConfig(req.tenantId);
  const waReady = !!(cfg.accessToken && cfg.phoneNumberId);

  // Crea o recupera la chat esterna — funziona anche senza WA configurato
  const chat = await prisma.externalChat.upsert({
    where: { tenantId_source_externalId: { tenantId: req.tenantId, source: 'WHATSAPP', externalId: phone } },
    update: { displayName: displayName || undefined },
    create: { tenantId: req.tenantId, source: 'WHATSAPP', externalId: phone, displayName: displayName || null, lastMessageAt: new Date() },
  });

  const { emitToTenant } = await import('../realtime/io.js');
  const msgs = [];

  // Invia su WhatsApp solo se configurato
  if (waReady) {
    const useTemplate = await needsTemplate(req.tenantId, phone);

    if (useTemplate && cfg.templateReady) {
      await sendWATemplate(cfg, phone).catch((e) => logger.warn({ e }, 'Template fallito'));
      const tMsg = await prisma.externalMessage.create({
        data: { chatId: chat.id, role: 'operator', content: '[Template: Continua inviato]' },
      });
      msgs.push(tMsg);
      emitToTenant(req.tenantId, 'external-chat:message', { chatId: chat.id, message: tMsg });
    }

    if (message) {
      if (useTemplate) {
        await prisma.whatsAppPendingMessage.create({
          data: { tenantId: req.tenantId, to: phone, type: 'text', content: { text: message } },
        });
        const pendMsg = await prisma.externalMessage.create({
          data: { chatId: chat.id, role: 'operator', content: `[In attesa] ${message}` },
        });
        msgs.push(pendMsg);
        emitToTenant(req.tenantId, 'external-chat:message', { chatId: chat.id, message: pendMsg });
      } else {
        await sendWAText(cfg, phone, message);
        const sentMsg = await prisma.externalMessage.create({
          data: { chatId: chat.id, role: 'operator', content: message },
        });
        msgs.push(sentMsg);
        await prisma.externalChat.update({ where: { id: chat.id }, data: { lastMessageAt: new Date() } });
        emitToTenant(req.tenantId, 'external-chat:message', { chatId: chat.id, message: sentMsg });
      }
    }
  }

  emitToTenant(req.tenantId, 'external-chat:updated', { chatId: chat.id });
  res.status(201).json({ ok: true, chat, messages: msgs });
}));

// ── POST /api/external-chats/:id/send — testo operatore ─────────────────

router.post('/:id/send', asyncHandler(async (req, res) => {
  const { content } = z.object({ content: z.string().min(1).max(4096) }).parse(req.body);
  const chat = await prisma.externalChat.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!chat) throw notFound('Chat non trovata');

  let sent = false;
  if (chat.source === 'WHATSAPP') {
    const cfg = await getWAConfig(req.tenantId);
    if (cfg.accessToken && cfg.phoneNumberId) {
      const useTemplate = await needsTemplate(req.tenantId, chat.externalId);
      if (useTemplate && cfg.templateReady) {
        // Prima invia template, poi accoda il testo
        await sendWATemplate(cfg, chat.externalId).catch(() => {});
        await prisma.whatsAppPendingMessage.create({
          data: { tenantId: req.tenantId, to: chat.externalId, type: 'text', content: { text: content } },
        });
      } else if (!useTemplate) {
        await sendWAText(cfg, chat.externalId, content);
        sent = true;
      }
    }
  }

  const msg = await prisma.externalMessage.create({
    data: { chatId: chat.id, role: 'operator', content: sent ? content : `[In attesa] ${content}` },
  });
  await prisma.externalChat.update({ where: { id: chat.id }, data: { lastMessageAt: new Date() } });

  const { emitToTenant } = await import('../realtime/io.js');
  emitToTenant(req.tenantId, 'external-chat:message', { chatId: chat.id, message: msg });
  res.json({ ok: true, message: msg });
}));

// ── POST /api/external-chats/:id/send-media — invia immagine/doc ─────────

router.post(
  '/:id/send-media',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Nessun file ricevuto');
    const chat = await prisma.externalChat.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!chat) throw notFound('Chat non trovata');

    const caption = req.body.caption || '';
    const mime = req.file.mimetype;
    let mediaType = 'document';
    if (mime.startsWith('image/')) mediaType = 'image';
    else if (mime.startsWith('video/')) mediaType = 'video';
    else if (mime.startsWith('audio/')) mediaType = 'audio';

    // Salva il file nel DB per avere un URL pubblico
    const doc = await prisma.document.create({
      data: {
        tenantId: req.tenantId,
        filename: req.file.originalname,
        mimeType: mime,
        sizeBytes: req.file.size,
        extracted: '',
        data: req.file.buffer,
      },
      select: { id: true, filename: true },
    });
    const base = process.env.PUBLIC_API_URL || 'https://api.ai-sophia.it';
    const publicUrl = `${base}/api/documents/${doc.id}/file`;

    const attData = { type: mediaType, url: `/api/documents/${doc.id}/file`, filename: doc.filename, mimeType: mime };

    if (chat.source === 'WHATSAPP') {
      const cfg = await getWAConfig(req.tenantId);
      if (cfg.accessToken && cfg.phoneNumberId) {
        await sendWAMedia(cfg, chat.externalId, mediaType, publicUrl, doc.filename, caption)
          .catch((e) => logger.warn({ e }, 'WA send-media fallito'));
      }
    }

    const msgContent = caption || `[${mediaType}: ${doc.filename}]`;
    const msg = await prisma.externalMessage.create({
      data: { chatId: chat.id, role: 'operator', content: msgContent, attachments: [attData] },
    });
    await prisma.externalChat.update({ where: { id: chat.id }, data: { lastMessageAt: new Date() } });

    const { emitToTenant } = await import('../realtime/io.js');
    emitToTenant(req.tenantId, 'external-chat:message', { chatId: chat.id, message: msg });
    res.json({ ok: true, message: msg });
  }),
);

// ── DELETE /api/external-chats/:id ───────────────────────────────────────

router.delete('/:id', asyncHandler(async (req, res) => {
  const { count } = await prisma.externalChat.deleteMany({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!count) throw notFound('Chat non trovata');
  const { emitToTenant } = await import('../realtime/io.js');
  emitToTenant(req.tenantId, 'external-chat:deleted', { chatId: req.params.id });
  res.json({ ok: true });
}));

export default router;

// ── Utility ──────────────────────────────────────────────────────────────

export async function upsertExternalMessage({ tenantId, source, externalId, displayName, role, content, attachments = null, waMessageId = null }) {
  const chat = await prisma.externalChat.upsert({
    where: { tenantId_source_externalId: { tenantId, source, externalId } },
    update: { lastMessageAt: new Date(), ...(displayName ? { displayName } : {}) },
    create: { tenantId, source, externalId, displayName, lastMessageAt: new Date() },
  });

  if (waMessageId) {
    const existing = await prisma.externalMessage.findFirst({ where: { chatId: chat.id, waMessageId } });
    if (existing) return { chat, message: existing, isDuplicate: true };
  }

  const message = await prisma.externalMessage.create({
    data: { chatId: chat.id, role, content, attachments: attachments || undefined, waMessageId: waMessageId || undefined },
  });
  return { chat, message, isDuplicate: false };
}
