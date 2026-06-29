import { z } from 'zod';
import { defineModule } from '../base.js';
import { logger } from '../../config/logger.js';

// Sanitizza filename per Meta API: rimuove caratteri accentati e speciali
function sanitizeFilename(name) {
  if (!name) return 'documento';
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.\-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'documento';
}

const configSchema = z.object({
  accessToken:         z.string().default(''),
  phoneNumberId:       z.string().default(''),
  businessAccountId:   z.string().default(''),
  webhookVerifyToken:  z.string().optional(),
  templateReady:       z.boolean().default(false),
  templateLanguage:    z.string().default('it'),
});


// Risolve un URL relativo (/api/...) in URL assoluto usando PUBLIC_API_URL
function resolvePublicUrl(url) {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  const base = process.env.PUBLIC_API_URL || 'https://api.ai-sophia.it';
  return base + (url.startsWith('/') ? url : '/' + url);
}

// ── Helper per inviare via Graph API ────────────────────────────────────────
async function sendWA(accessToken, phoneNumberId, to, messageBody) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...messageBody }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`WhatsApp API: ${JSON.stringify(data)}`);
  return data;
}

// Carica un buffer immagine sui server Meta e restituisce il media_id.
// Questo approccio garantisce che il destinatario riceva una vera immagine
// e non un semplice link testuale.
async function uploadMediaToWA(accessToken, phoneNumberId, buffer, mimeType, filename) {
  const { FormData, Blob } = await import('node:buffer').catch(() => ({ FormData: global.FormData, Blob: global.Blob })).catch(() => ({}));
  const nodeFetch = fetch; // Node 18+ ha fetch nativo
  const form = new global.FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new global.Blob([buffer], { type: mimeType }), filename || 'image.png');
  const res = await nodeFetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`WA upload media: ${JSON.stringify(data)}`);
  return data.id;
}

// ── Controlla se la sessione è aperta (utente ha risposto entro 24h) ────────
async function hasOpenSession(prisma, tenantId, phone) {
  const contact = await prisma.whatsAppContact.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
  });
  return !!(contact?.sessionExpiresAt && contact.sessionExpiresAt > new Date());
}

// ── Accoda messaggio e invia template se necessario ─────────────────────────
async function queueAndNotify(ctx, to, type, content) {
  const { tenantId, config, prisma } = ctx;
  const { accessToken, phoneNumberId, templateLanguage = 'it' } = config;

  // Salva il messaggio in coda
  await prisma.whatsAppPendingMessage.create({ data: { tenantId, to, type, content } });

  // Invia il template solo se non ne abbiamo già inviato uno recente (< 1h)
  const contact = await prisma.whatsAppContact.findUnique({
    where: { tenantId_phone: { tenantId, phone: to } },
  });
  const templateRecentlySent =
    contact?.templateSentAt && Date.now() - contact.templateSentAt.getTime() < 6 * 60 * 60 * 1000;

  if (!templateRecentlySent) {
    try {
      const buttonText = templateLanguage === 'en' ? 'Continue' : 'Continua';
      await sendWA(accessToken, phoneNumberId, to, {
        type: 'template',
        template: {
          name: 'conversation_continue',
          language: { code: templateLanguage },
          components: [
            {
              type: 'button',
              sub_type: 'quick_reply',
              index: 0,
              parameters: [{ type: 'payload', payload: buttonText }],
            },
          ],
        },
      });

      await prisma.whatsAppContact.upsert({
        where: { tenantId_phone: { tenantId, phone: to } },
        update: { templateSentAt: new Date(), updatedAt: new Date() },
        create: { tenantId, phone: to, templateSentAt: new Date() },
      });
    } catch (err) {
      // Non bloccare il flusso se il template fallisce
      console.warn('Impossibile inviare template WA:', err.message);
    }
  }

  const count = await prisma.whatsAppPendingMessage.count({ where: { tenantId, to, deliveredAt: null } });
  return {
    queued: true,
    pendingCount: count,
    note: `Messaggio in attesa: l'utente riceverà tutti i ${count} messaggi in coda quando premerà "Continua" sul template.`,
  };
}

export default defineModule({
  key: 'whatsapp',
  name: 'WhatsApp',
  description: 'Invia messaggi WhatsApp tramite la Cloud API di Meta. Supporta testo, immagini e documenti.',
  defaultInstalled: true,
  notice: null,
  defaultConfig: {
    accessToken: '', phoneNumberId: '', businessAccountId: '',
    webhookVerifyToken: '', templateReady: false, templateLanguage: 'it',
  },
  configSchema,
  capabilities: [
    {
      name: 'send',
      description:
        'Invia un messaggio di testo WhatsApp a un numero (formato internazionale, es. 393331234567). ' +
        'Se il contatto non ha ancora confermato la conversazione, il messaggio viene messo in coda ' +
        'e recapitato non appena preme il pulsante Continua. Più messaggi in coda vengono inviati tutti insieme.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Numero in formato E.164 senza +, es. 393331234567' },
          message: { type: 'string', description: 'Testo del messaggio' },
        },
        required: ['to', 'message'],
      },
      async handler(ctx, args) {
        const { accessToken, phoneNumberId } = ctx.config;
        if (!accessToken || !phoneNumberId) {
          throw new Error('WhatsApp non configurato (accessToken / phoneNumberId mancanti).');
        }

        if (await hasOpenSession(ctx.prisma, ctx.tenantId, args.to)) {
          const data = await sendWA(accessToken, phoneNumberId, args.to, {
            type: 'text', text: { body: args.message },
          });
          return { ok: true, id: data.messages?.[0]?.id, note: 'Messaggio inviato direttamente.' };
        }

        return queueAndNotify(ctx, args.to, 'text', { text: args.message });
      },
    },
    {
      name: 'send_image',
      description:
        'Invia un\'immagine WhatsApp tramite URL pubblico, con didascalia opzionale. ' +
        'Se il contatto non ha la sessione aperta, l\'immagine viene messa in coda.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Numero in formato E.164 senza +' },
          url: { type: 'string', description: 'URL pubblico dell\'immagine (JPEG, PNG, …)' },
          caption: { type: 'string', description: 'Didascalia facoltativa' },
        },
        required: ['to', 'url'],
      },
      async handler(ctx, args) {
        const { accessToken, phoneNumberId } = ctx.config;
        if (!accessToken || !phoneNumberId) throw new Error('WhatsApp non configurato.');

        const imageUrl = resolvePublicUrl(args.url);

        if (await hasOpenSession(ctx.prisma, ctx.tenantId, args.to)) {
          // Scarica il buffer dell'immagine dal nostro server e caricalo su Meta
          // così il destinatario riceve una vera immagine, non un link.
          try {
            const imgRes = await fetch(imageUrl);
            if (imgRes.ok) {
              const buffer = Buffer.from(await imgRes.arrayBuffer());
              const mimeType = imgRes.headers.get('content-type') || 'image/png';
              const mediaId = await uploadMediaToWA(accessToken, phoneNumberId, buffer, mimeType, 'image.png');
              const data = await sendWA(accessToken, phoneNumberId, args.to, {
                type: 'image', image: { id: mediaId, caption: args.caption ?? '' },
              });
              return { ok: true, id: data.messages?.[0]?.id };
            }
          } catch { /* fallback al link */ }
          // fallback: invia come link se l'upload fallisce
          const data = await sendWA(accessToken, phoneNumberId, args.to, {
            type: 'image', image: { link: imageUrl, caption: args.caption ?? '' },
          });
          return { ok: true, id: data.messages?.[0]?.id };
        }

        return queueAndNotify(ctx, args.to, 'image', { url: imageUrl, caption: args.caption ?? '' });
      },
    },
    {
      name: 'send_document',
      description:
        'Invia un documento su WhatsApp. Usa documentId (ID dal cloud) — più affidabile degli URL con caratteri speciali. ' +
        'Se la sessione WA non è aperta, il file viene messo in coda e l\'utente riceve un template per sbloccarla.',
      parameters: {
        type: 'object',
        properties: {
          to:         { type: 'string', description: 'Numero E.164 senza +' },
          documentId: { type: 'string', description: 'ID documento cloud (da cloud__find_documents). Preferito rispetto a url.' },
          url:        { type: 'string', description: 'URL pubblico (fallback se non hai documentId).' },
          filename:   { type: 'string', description: 'Nome file mostrato all\'utente.' },
          caption:    { type: 'string', description: 'Didascalia facoltativa.' },
        },
        required: ['to'],
      },
      async handler(ctx, args) {
        const { accessToken, phoneNumberId } = ctx.config;
        if (!accessToken || !phoneNumberId) throw new Error('WhatsApp non configurato.');
        if (!args.documentId && !args.url) return { ok: false, message: 'Specifica documentId o url.' };

        let buffer = null;
        let mimeType = 'application/octet-stream';
        let cleanFilename = sanitizeFilename(args.filename);

        // Priorità 1: carica dal DB tramite documentId
        if (args.documentId) {
          try {
            const doc = await ctx.prisma.document.findFirst({
              where: { id: args.documentId, tenantId: ctx.tenantId },
            });
            if (doc?.data) {
              buffer = doc.data;
              mimeType = doc.mimeType || 'application/octet-stream';
              if (!cleanFilename || cleanFilename === 'documento') {
                cleanFilename = sanitizeFilename(doc.filename);
              }
            }
          } catch (dbErr) {
            logger.warn({ err: dbErr.message }, 'WA doc: lettura DB fallita');
          }
        }

        // Priorità 2: scarica dall'URL
        if (!buffer && args.url) {
          try {
            const res = await fetch(resolvePublicUrl(args.url));
            if (res.ok) {
              buffer = Buffer.from(await res.arrayBuffer());
              mimeType = res.headers.get('content-type') || 'application/octet-stream';
            }
          } catch (e) { logger.warn({ err: e.message }, 'WA doc: fetch fallita'); }
        }

        if (!buffer) return { ok: false, message: 'Impossibile recuperare il documento dal cloud.' };

        if (await hasOpenSession(ctx.prisma, ctx.tenantId, args.to)) {
          try {
            const mediaId = await uploadMediaToWA(accessToken, phoneNumberId, buffer, mimeType, cleanFilename);
            const data = await sendWA(accessToken, phoneNumberId, args.to, {
              type: 'document',
              document: { id: mediaId, caption: args.caption ?? '', filename: cleanFilename },
            });
            return { ok: true, sent: true, id: data.messages?.[0]?.id };
          } catch (err) {
            logger.error({ err: err.message }, 'WA doc: invio fallito');
            return { ok: false, message: `Invio fallito: ${err.message}` };
          }
        }

        // Sessione non aperta: mette in coda e invia template
        await queueAndNotify(ctx, args.to, 'document', {
          url: args.url || '', caption: args.caption ?? '', filename: cleanFilename,
        });
        return {
          ok: true, sent: false, queued: true,
          message: `Sessione WA non attiva con ${args.to}. Ho inviato un template per sbloccarla. Il documento verrà consegnato quando l'utente preme "Continua". Dì all'utente di aspettare il messaggio e premere il pulsante.`,
        };
      },
    },

  ],
});
