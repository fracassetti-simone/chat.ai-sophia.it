/**
 * Rotte WhatsApp
 * GET  /api/whatsapp/webhook   Meta verification
 * POST /api/whatsapp/webhook   Ricezione eventi da Meta
 * Setup wizard autenticato in /api/modules/whatsapp/setup/...
 */

import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { asyncHandler } from '../utils/http.js';
import { logger } from '../config/logger.js';

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

async function getWAConfig(tenantId) {
  const inst = await prisma.moduleInstance.findUnique({
    where: { tenantId_moduleKey: { tenantId, moduleKey: 'whatsapp' } },
  });
  return inst?.config ?? {};
}

async function sendWAMessage(accessToken, phoneNumberId, to, body) {
  const res = await fetch(
    `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body, to }),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`WhatsApp API: ${JSON.stringify(data)}`);
  return data;
}


/**
 * Estrai contenuto e allegati da un messaggio Meta.
 * Scarica e mette in cache i media binari.
 */
/**
 * Estrai contenuto + allegati + buffer immagini da un messaggio Meta.
 * Restituisce anche imageBuffers: [{base64, mimeType}] per passarli a GPT.
 */
async function extractMessageContent(msg, accessToken) {
  const type = msg.type;
  let content = '';
  let attachments = null;
  let imageBuffers = []; // per GPT vision

  async function downloadMedia(mediaUrl, mediaId, mimeType) {
    if (!mediaUrl || !mediaId) return null;
    try {
      const r = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      // Salva in cache
      await prisma.waMediaCache.upsert({
        where: { waMediaId: mediaId },
        update: { data: buf, mimeType, updatedAt: new Date() },
        create: { waMediaId: mediaId, data: buf, mimeType },
      });
      return { buf, cachedPath: '/api/whatsapp/media/' + mediaId };
    } catch (err) {
      logger.warn({ err, mediaId }, 'WA: download media fallito');
      return null;
    }
  }

  if (type === 'text') {
    content = msg.text?.body || '';
  } else if (type === 'image') {
    const img = msg.image;
    const res = await downloadMedia(img?.url, img?.id, img?.mime_type || 'image/jpeg');
    content = img?.caption || '[Immagine]';
    attachments = [{ type: 'image', url: res?.cachedPath || null, mimeType: img?.mime_type, waMediaId: img?.id }];
    if (res?.buf) imageBuffers.push({ base64: res.buf.toString('base64'), mimeType: img?.mime_type || 'image/jpeg' });
  } else if (type === 'document') {
    const doc = msg.document;
    const res = await downloadMedia(doc?.url, doc?.id, doc?.mime_type || 'application/octet-stream');
    content = doc?.caption || '[Documento: ' + (doc?.filename || 'file') + ']';
    attachments = [{ type: 'document', url: res?.cachedPath || null, filename: doc?.filename, mimeType: doc?.mime_type, waMediaId: doc?.id }];
  } else if (type === 'audio') {
    const aud = msg.audio;
    const res = await downloadMedia(aud?.url, aud?.id, aud?.mime_type || 'audio/ogg');
    // Trascrivi l'audio con Whisper e usa il testo come contenuto del messaggio
    let transcription = null;
    if (res?.buf) {
      transcription = await transcribeAudio(res.buf, aud?.mime_type || 'audio/ogg');
    }
    content = transcription ? `[Trascrizione audio]: ${transcription}` : '[Audio vocale]';
    attachments = [{ type: 'audio', url: res?.cachedPath || null, mimeType: aud?.mime_type, waMediaId: aud?.id, transcription }];
  } else if (type === 'video') {
    const vid = msg.video;
    const res = await downloadMedia(vid?.url, vid?.id, vid?.mime_type || 'video/mp4');
    content = vid?.caption || '[Video]';
    attachments = [{ type: 'video', url: res?.cachedPath || null, mimeType: vid?.mime_type, waMediaId: vid?.id }];
  } else if (type === 'sticker') {
    content = '[Sticker]';
  } else if (type === 'location') {
    content = '[Posizione: ' + msg.location?.latitude + ', ' + msg.location?.longitude + ']';
  } else {
    content = '[Messaggio tipo: ' + type + ']';
  }

  return { content, attachments, imageBuffers };
}


/**
 * Trascrive un buffer audio con OpenAI Whisper.
 * Supporta ogg/opus (formato WA), mp4, mp3, wav ecc.
 */
async function transcribeAudio(audioBuffer, mimeType) {
  try {
    const { getOpenAI } = await import('../ai/openai.js');
    const openai = getOpenAI();

    // OpenAI SDK accetta un File-like object con name per capire il formato
    const ext = mimeType?.includes('ogg') ? 'ogg'
      : mimeType?.includes('mp4') ? 'mp4'
      : mimeType?.includes('mpeg') || mimeType?.includes('mp3') ? 'mp3'
      : mimeType?.includes('wav') ? 'wav'
      : 'ogg';

    // Crea un File object dal buffer (Node 18+ / fetch API)
    const file = new File([audioBuffer], `audio.${ext}`, { type: mimeType || 'audio/ogg' });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'gpt-4o-transcribe',
    });
    return transcription.text || '';
  } catch (err) {
    logger.warn({ err }, 'WA: trascrizione audio fallita');
    return null;
  }
}

async function deliverPendingMessages(tenantId, phone) {
  const cfg = await getWAConfig(tenantId);
  if (!cfg.accessToken || !cfg.phoneNumberId) return;
  const pending = await prisma.whatsAppPendingMessage.findMany({
    where: { tenantId, to: phone, deliveredAt: null },
    orderBy: { createdAt: 'asc' },
  });
  for (const msg of pending) {
    try {
      let body;
      if (msg.type === 'text') body = { type: 'text', text: { body: msg.content.text } };
      else if (msg.type === 'image') body = { type: 'image', image: { link: msg.content.url, caption: msg.content.caption } };
      else if (msg.type === 'document') body = { type: 'document', document: { link: msg.content.url, caption: msg.content.caption, filename: msg.content.filename } };
      if (body) await sendWAMessage(cfg.accessToken, cfg.phoneNumberId, phone, body);
      await prisma.whatsAppPendingMessage.update({ where: { id: msg.id }, data: { deliveredAt: new Date() } });
    } catch (err) {
      logger.warn({ err, msgId: msg.id }, 'WA: errore consegna pendente');
    }
  }
  const sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.whatsAppContact.upsert({
    where: { tenantId_phone: { tenantId, phone } },
    update: { sessionExpiresAt, updatedAt: new Date() },
    create: { tenantId, phone, sessionExpiresAt },
  });
}

// ── GET /api/whatsapp/media/:waMediaId — serve immagini/media cachati ─────

router.get('/media/:waMediaId', asyncHandler(async (req, res) => {
  const cached = await prisma.waMediaCache.findUnique({
    where: { waMediaId: req.params.waMediaId },
  });
  if (!cached?.data) return res.status(404).send('Not found');
  res.set({
    'Content-Type': cached.mimeType || 'application/octet-stream',
    'Cache-Control': 'public, max-age=604800', // 7 giorni
  });
  res.send(cached.data);
}));

// ── Webhook pubblico ───────��────────────────────────────────────────────────

router.get('/webhook', asyncHandler(async (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe') {
    const instances = await prisma.moduleInstance.findMany({ where: { moduleKey: 'whatsapp' } });
    const match = instances.find((i) => i.config?.webhookVerifyToken === token);
    if (match) return res.status(200).send(challenge);
  }
  res.sendStatus(403);
}));

router.post('/webhook', asyncHandler(async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  logger.info({ webhook: JSON.stringify(body) }, 'WA webhook: payload ricevuto');
  if (body?.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry ?? []) {
    const wabaId = entry.id;
    const instances = await prisma.moduleInstance.findMany({ where: { moduleKey: 'whatsapp' } });
    const inst = instances.find((i) => i.config?.businessAccountId === wabaId);
    if (!inst) {
      logger.warn({ wabaId }, 'WA webhook: tenant non trovato');
      continue;
    }
    const tenantId = inst.tenantId;
    const cfg = inst.config || {};

    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value;

      // Ignora aggiornamenti di stato (delivered, read, ecc.)
      if (value?.statuses?.length && !value?.messages?.length) {
        logger.info({ count: value.statuses.length }, 'WA webhook: status update, skip');
        continue;
      }

      for (const msg of value?.messages ?? []) {
        const phone     = msg.from;
        const waMessageId = msg.id;
        logger.info({ tenantId, phone, type: msg.type }, 'WA webhook: messaggio');

        // Pulsante Continua
        const isButtonContinue =
          msg.type === 'button' || msg.type === 'interactive' ||
          (msg.type === 'text' && (
            msg.text?.body?.toLowerCase() === 'continua' ||
            msg.text?.body?.toLowerCase() === 'continue'
          ));
        if (isButtonContinue) { await deliverPendingMessages(tenantId, phone); continue; }

        // Estrai contenuto + scarica media binario (immagini → base64 per GPT)
        const { content, attachments, imageBuffers } = await extractMessageContent(msg, cfg.accessToken);

        // ── 1. Chat esterna ──────────────────────────────────────────────
        (async () => {
          try {
            const { upsertExternalMessage } = await import('./external-chats.js');
            const { emitToTenant }          = await import('../realtime/io.js');
            const { runFlows }              = await import('./flows.js');

            const contactName = value?.contacts?.[0]?.profile?.name || null;

            // Popola nome del contatto dal profilo WhatsApp se non ce l'abbiamo ancora
            try {
              if (contactName) {
                const existing = await prisma.contact.findFirst({ where: { tenantId, phone } });
                if (existing && !existing.firstName && !existing.lastName) {
                  await prisma.contact.update({ where: { id: existing.id }, data: { firstName: contactName } });
                }
              }
            } catch (e) { logger.warn({ e }, 'Rubrica: aggiornamento nome WA fallito'); }

            const { chat, message, isDuplicate } = await upsertExternalMessage({
              tenantId, source: 'WHATSAPP', externalId: phone,
              displayName: contactName, role: 'customer',
              content, attachments, waMessageId,
            });
            if (isDuplicate) return;

            emitToTenant(tenantId, 'external-chat:message', { chatId: chat.id, message });
            emitToTenant(tenantId, 'external-chat:updated', { chatId: chat.id });

            // AI risponde
            const { runChat } = await import('../ai/engine.js');
            const history = await prisma.externalMessage.findMany({
              where: { chatId: chat.id },
              orderBy: { createdAt: 'asc' },
              select: { role: true, content: true },
            });
            const aiHistory = history.map((m) => ({
              role: m.role === 'customer' ? 'user' : 'assistant',
              content: m.content,
            }));

            // Aggiunge le immagini all'ultimo messaggio utente per GPT vision
            let enrichedHistory = aiHistory;
            if (imageBuffers.length > 0 && enrichedHistory.length > 0) {
              const lastIdx = enrichedHistory.length - 1;
              enrichedHistory = [
                ...enrichedHistory.slice(0, lastIdx),
                { ...enrichedHistory[lastIdx], images: imageBuffers },
              ];
            }

            let aiText = '';
            let waContactId = null; // id del contatto WhatsApp, per l'accesso "utente del contatto" nel cloud
            try {
              let contactContext = `Stai parlando su WhatsApp con il numero ${phone}.`;
              let savedDocUrls = [];
              try {
                let contact = await prisma.contact.findFirst({ where: { tenantId, phone } });
                if (!contact) {
                  contact = await prisma.contact.create({ data: { tenantId, phone, source: 'whatsapp' } });
                }
                waContactId = contact.id;

                // Salva automaticamente i media WA nel cloud del contatto
                for (const att of attachments || []) {
                  if (!att.waMediaId) continue;
                  try {
                    const cached = await prisma.waMediaCache.findUnique({ where: { waMediaId: att.waMediaId } });
                    if (!cached?.data) continue;

                    let folder = await prisma.cloudFolder.findFirst({ where: { tenantId, contactId: contact.id } });
                    if (!folder) {
                      const fn = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || contact.company || phone;
                      folder = await prisma.cloudFolder.create({
                        data: { tenantId, name: fn, contactId: contact.id, parentId: null },
                      });
                    }

                    const ext = (att.mimeType || '').split('/')[1]?.split(';')[0] || 'bin';
                    const filename = att.filename || `${att.type || 'file'}-${Date.now()}.${ext}`;
                    const doc = await prisma.document.create({
                      data: {
                        tenant: { connect: { id: tenantId } },
                        filename, mimeType: att.mimeType || 'application/octet-stream',
                        sizeBytes: cached.data.length, extracted: '', data: cached.data,
                      },
                    });
                    await prisma.$executeRawUnsafe(
                      `UPDATE "Document" SET "folderId" = $1, "contactId" = $2 WHERE id = $3`,
                      folder.id, contact.id, doc.id
                    );
                    const base = process.env.PUBLIC_API_URL || 'http://localhost:4000';
                    savedDocUrls.push({ filename, url: `${base}/api/documents/${doc.id}/file` });
                    logger.info({ filename, contactId: contact.id }, 'WA: media salvato nel cloud');
                  } catch (saveErr) {
                    logger.warn({ err: saveErr.message }, 'WA: salvataggio media fallito');
                  }
                }

                const fields = [];
                if (contact.firstName || contact.lastName) fields.push(`Nome: ${[contact.firstName, contact.lastName].filter(Boolean).join(' ')}`);
                if (contact.email)   fields.push(`Email: ${contact.email}`);
                if (contact.company) fields.push(`Azienda: ${contact.company}`);
                if (contact.city)    fields.push(`Città: ${contact.city}`);
                if (contact.customFields && typeof contact.customFields === 'object') {
                  for (const [k, v] of Object.entries(contact.customFields)) {
                    if (v) fields.push(`${k}: ${v}`);
                  }
                }
                if (contact.notes) fields.push(`Note: ${contact.notes}`);
                contactContext = `Stai parlando su WhatsApp con il numero ${phone}.\nContatto in rubrica (ID: ${contact.id}):\n${fields.length > 0 ? fields.join('\n') : '(nessun dato ancora)'}\n→ Aggiorna QUESTO contatto quando l'utente fornisce dati. Usa customFields per dati strutturati.`;

                if (savedDocUrls.length > 0) {
                  const fileList = savedDocUrls.map(d => `- ${d.filename}`).join('\n');
                  contactContext += `\n\n[FILE RICEVUTI E SALVATI NEL CLOUD DEL CONTATTO]\n${fileList}\nI file sono stati salvati automaticamente. Conferma all'utente e chiedi se vuole rinominarli o fare altro.`;
                }
              } catch { /* non blocca */ }

              // Carica l'agente attivo per questa chat
              const chatAgentRow = await prisma.externalChatAgent.findUnique({ where: { chatId: chat.id }, select: { agentId: true } }).catch(() => null);
              const activeAgentId = chatAgentRow?.agentId || null;
              await runChat({ tenantId, source: 'WHATSAPP', extraContext: contactContext, agentId: activeAgentId, externalChatId: chat.id, externalContactId: waContactId, history: enrichedHistory, onToken: (t) => { aiText += t; } });
            } catch (err) { logger.error({ err }, 'WA external: AI error'); }

            if (aiText) {
              const aiMsg = await prisma.externalMessage.create({
                data: { chatId: chat.id, role: 'ai', content: aiText },
              });
              emitToTenant(tenantId, 'external-chat:message', { chatId: chat.id, message: aiMsg });
              await prisma.externalChat.update({ where: { id: chat.id }, data: { lastMessageAt: new Date() } });
              if (cfg.accessToken && cfg.phoneNumberId) {
                await sendWAMessage(cfg.accessToken, cfg.phoneNumberId, phone, {
                  type: 'text', text: { body: aiText },
                }).catch((e) => logger.warn({ e }, 'WA: invio AI fallito'));
              }
            }

            // Flussi
            let flowTrigger = 'WA_MESSAGE_RECEIVED';
            const attType = attachments?.[0]?.type;
            if (attType === 'image' || attType === 'document' || attType === 'video') flowTrigger = 'WA_FILE_RECEIVED';
            else if (attType === 'audio') flowTrigger = 'WA_AUDIO_RECEIVED';

            await runFlows(tenantId, flowTrigger, {
              'numero_mittente': phone,
              'nome_contatto': contactName || 'sconosciuto',
              'tipo_messaggio': msg.type,
              'contenuto': content,
              'allegato_tipo': attType || 'nessuno',
              'allegato_url': attachments?.[0]?.url || 'nessuno',
              'allegato_nome': attachments?.[0]?.filename || 'nessuno',
            }, imageBuffers);

          } catch (err) {
            logger.error({ err, tenantId, phone }, 'WA: errore chat esterna');
          }
        })();

        // ── 2. Chat sincronizzata personale ─────────────────────────────
        (async () => {
          try {
            const sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await prisma.whatsAppContact.upsert({
              where: { tenantId_phone: { tenantId, phone } },
              update: { sessionExpiresAt, updatedAt: new Date() },
              create: { tenantId, phone, sessionExpiresAt },
            });
            const phoneNorm = phone.startsWith('+') ? phone : ('+' + phone);
            const sync = await prisma.whatsAppSyncedConversation.findFirst({
              where: { tenantId, phone: phoneNorm },
            });
            if (!sync) return;
            const { emitToTenant } = await import('../realtime/io.js');
            await prisma.message.create({
              data: { conversationId: sync.conversationId, role: 'user', content },
            });
            emitToTenant(tenantId, 'whatsapp:message', {
              conversationId: sync.conversationId, role: 'user', content, phone,
            });
          } catch (err) { logger.warn({ err }, 'WA sync personale: errore'); }
        })();
      }
    }
  }
}));

// ── Setup wizard ────────────────────────────────────────────────────────────

const setupRouter = Router();
setupRouter.use(authenticate, tenantScope, requireTenant);

setupRouter.get('/templates', asyncHandler(async (req, res) => {
  const cfg = await getWAConfig(req.tenantId);
  if (!cfg.accessToken || !cfg.businessAccountId)
    return res.status(400).json({ error: 'Credenziali WhatsApp non configurate.' });
  const r = await fetch(
    `https://graph.facebook.com/v25.0/${cfg.businessAccountId}/message_templates?limit=250`,
    { headers: { Authorization: `Bearer ${cfg.accessToken}` } },
  );
  const data = await r.json();
  if (!r.ok) return res.status(400).json({ error: humanizeWAError(data?.error) });
  const templates = Object.values(data?.data ?? {});
  const found = templates.find((t) => t.name === 'conversation_continue' && t.status === 'APPROVED');
  res.json({ templates, templateReady: !!found });
}));

setupRouter.post('/templates', asyncHandler(async (req, res) => {
  const cfg = await getWAConfig(req.tenantId);
  if (!cfg.accessToken || !cfg.businessAccountId)
    return res.status(400).json({ error: 'Credenziali WhatsApp non configurate.' });
  const lang = req.body?.language === 'en' ? 'en' : 'it';
  const tr = {
    it: { header: 'Benvenuto in Sophia', body: 'Ciao! Hai una notifica in attesa. Premi per riceverla.', button: 'Continua' },
    en: { header: 'Welcome to Sophia', body: 'Hi! You have a pending notification. Press to receive it.', button: 'Continue' },
  }[lang];
  const payload = {
    name: 'conversation_continue', language: lang, category: 'MARKETING',
    components: [
      { type: 'HEADER', format: 'TEXT', text: tr.header },
      { type: 'BODY', text: tr.body },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: tr.button }] },
    ],
  };
  const r = await fetch(`https://graph.facebook.com/v25.0/${cfg.businessAccountId}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) return res.status(400).json({ error: humanizeWAError(data?.error) });
  res.json({ ok: true, template: data });
}));

setupRouter.get('/webhook-info', asyncHandler(async (req, res) => {
  const cfg = await getWAConfig(req.tenantId);
  let verifyToken = cfg.webhookVerifyToken;
  if (!verifyToken) {
    verifyToken = 'sophia_' + req.tenantId.slice(-8) + '_' + Math.random().toString(36).slice(2, 10);
    await prisma.moduleInstance.updateMany({
      where: { tenantId: req.tenantId, moduleKey: 'whatsapp' },
      data: { config: { ...cfg, webhookVerifyToken: verifyToken } },
    });
  }
  const host  = req.headers['x-forwarded-host'] || req.headers.host || 'api.ai-sophia.it';
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  res.json({ webhookUrl: `${proto}://${host}/api/whatsapp/webhook`, verifyToken });
}));

export { router as whatsappWebhookRouter, setupRouter as whatsappSetupRouter };

function humanizeWAError(error) {
  if (!error) return 'Errore sconosciuto.';
  switch (error.code) {
    case 190: return 'Token di accesso non valido o scaduto.';
    case 200: return 'Permessi insufficienti sul token.';
    case 803: return 'Account WhatsApp Business non trovato.';
    case 2:   return 'Errore temporaneo Meta. Riprova.';
    default:  return `Errore Meta (${error.code}): ${error.message ?? ''}`;
  }
}
