#!/bin/bash
# ============================================================
# Script di installazione patch Sophia
# Esegui da: /root/Sophia  (la root del progetto)
# Uso: bash apply_on_server.sh
# ============================================================

set -e
echo "=== Sophia Patch - Installazione ==="
echo "Cartella corrente: $(pwd)"

# Controlla che siamo nella root del progetto
if [ ! -d "backend" ] || [ ! -d "frontend" ]; then
  echo "ERRORE: Esegui questo script dalla root del progetto Sophia (/root/Sophia)"
  exit 1
fi

# Crea cartella modulo gemini se non esiste
mkdir -p backend/src/modules/gemini
echo "[1/6] Cartelle create"

# === File 1: backend/src/modules/gemini/index.js ===
cat > backend/src/modules/gemini/index.js << 'GEMINI_EOF'
import { z } from 'zod';
import { defineModule } from '../base.js';

const configSchema = z.object({}).optional();

export default defineModule({
  key: 'gemini',
  name: 'Gemini AI',
  description: 'Interroga i manuali e documenti caricati nella sezione Addestramento tramite Google Gemini. La API key viene configurata nella pagina del modulo.',
  defaultInstalled: false,
  notice: null,
  defaultConfig: {},
  configSchema,
  capabilities: [
    {
      name: 'query_manual',
      description:
        'Interroga i manuali e documenti caricati nella sezione Addestramento tramite Google Gemini. ' +
        'Usa questa capability quando l\'utente fa domande su manuali tecnici, guide o documentazione che è stata caricata. ' +
        'Restituisce la risposta estratta dal documento.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'La domanda da porre al documento' },
          documentId: { type: 'string', description: 'ID del documento specifico da interrogare (opzionale; se omesso usa tutti i documenti disponibili)' },
        },
        required: ['question'],
      },
      async handler(ctx, args) {
        const { tenantId, prisma } = ctx;

        const cfg = await prisma.geminiConfig.findUnique({ where: { tenantId } });
        if (!cfg?.apiKey) throw new Error('API key Gemini non configurata. Vai in Moduli → Gemini → Configura.');

        let doc = null;
        if (args.documentId) {
          doc = await prisma.trainingDocument.findFirst({
            where: { id: args.documentId, tenantId },
          });
        } else {
          // Usa il primo documento disponibile
          doc = await prisma.trainingDocument.findFirst({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
          });
        }

        if (!doc) throw new Error('Nessun manuale disponibile. Carica documenti nella sezione Addestramento.');

        const model = cfg.model || 'gemini-2.5-flash';
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.apiKey}`;

        const b64 = Buffer.isBuffer(doc.data) ? doc.data.toString('base64') : doc.data;
        const parts = [
          { inline_data: { mime_type: doc.mimeType || 'application/pdf', data: b64 } },
          { text: `Documento: ${doc.filename}\n\n${args.question}` },
        ];

        const r = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { maxOutputTokens: 2048 },
          }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error?.message || 'Errore Gemini');

        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Nessuna risposta.';
        return { answer, document: doc.filename };
      },
    },
  ],
});
GEMINI_EOF
echo "[2/6] Modulo Gemini creato"

# === File 2: backend/src/routes/phone.js ===
cat > backend/src/routes/phone.js << 'PHONE_EOF'
/**
 * Rotte collegamento numero di telefono utente tramite OTP ai-sophia.
 *
 * POST /api/phone/link       → Avvia il collegamento: invia OTP via WhatsApp al numero indicato
 * POST /api/phone/verify     → Verifica OTP e certifica il collegamento
 * GET  /api/phone/status     → Restituisce lo stato del collegamento dell'utente corrente
 * DELETE /api/phone/unlink   → Rimuove il collegamento
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, badRequest } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { logger } from '../config/logger.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

const OTP_BASE = 'https://otp.ai-sophia.it';

function otpHeaders() {
  const key = process.env.OTP_API_KEY;
  if (!key) throw new Error('OTP_API_KEY non configurata nel .env del backend.');
  return { 'Content-Type': 'application/json', 'X-API-Key': key };
}

// ── GET /api/phone/status ────────────────────────────────────────────────

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const link = await prisma.userPhoneLink.findUnique({
      where: { userId: req.user.id },
    });
    if (!link) return res.json({ linked: false });
    res.json({
      linked: true,
      verified: link.verified,
      phone: link.phone,
    });
  }),
);

// ── POST /api/phone/link ─────────────────────────────────────────────────

const linkSchema = z.object({
  phone: z.string().regex(/^\+\d{7,15}$/, 'Formato numero non valido (es. +393331234567)'),
});

router.post(
  '/link',
  asyncHandler(async (req, res) => {
    const { phone } = linkSchema.parse(req.body);

    // Manda OTP tramite ai-sophia
    let otpData;
    try {
      const r = await fetch(`${OTP_BASE}/v1/otp/send`, {
        method: 'POST',
        headers: otpHeaders(),
        body: JSON.stringify({
          to: phone,
          ttlMinutes: 10,
          metadata: { userId: req.user.id },
        }),
      });
      otpData = await r.json();
      if (!otpData.ok) {
        throw new Error(otpData.message || otpData.error || 'Invio OTP fallito');
      }
    } catch (err) {
      logger.error({ err }, 'OTP send failed');
      throw badRequest(err.message);
    }

    // Salva / aggiorna il link (non ancora verificato)
    await prisma.userPhoneLink.upsert({
      where: { userId: req.user.id },
      update: { phone, verified: false, pendingOtpId: otpData.otp.id },
      create: { userId: req.user.id, phone, verified: false, pendingOtpId: otpData.otp.id },
    });

    logger.info({ userId: req.user.id, phone, otpId: otpData.otp.id }, 'OTP inviato per collegamento');
    res.json({ ok: true, message: `OTP inviato via WhatsApp a ${phone}`, expiresAt: otpData.otp.expiresAt });
  }),
);

// ── POST /api/phone/verify ───────────────────────────────────────────────

const verifySchema = z.object({
  code: z.string().length(6, 'Il codice OTP deve essere di 6 cifre'),
});

router.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const { code } = verifySchema.parse(req.body);

    const link = await prisma.userPhoneLink.findUnique({ where: { userId: req.user.id } });
    if (!link || !link.pendingOtpId) throw badRequest('Nessuna richiesta OTP in attesa. Avvia prima il collegamento.');

    // Verifica tramite ai-sophia
    let verifyData;
    try {
      const r = await fetch(`${OTP_BASE}/v1/otp/verify`, {
        method: 'POST',
        headers: otpHeaders(),
        body: JSON.stringify({ otpId: link.pendingOtpId, code }),
      });
      verifyData = await r.json();
      if (!verifyData.ok) {
        const msg = {
          INVALID_OTP: 'Codice OTP errato.',
          OTP_EXPIRED: 'OTP scaduto. Richiedi un nuovo codice.',
          MAX_ATTEMPTS_REACHED: 'Troppi tentativi. Richiedi un nuovo codice.',
          OTP_REVOKED: 'OTP revocato. Richiedi un nuovo codice.',
        }[verifyData.error] || verifyData.message || 'Verifica fallita';
        throw badRequest(msg);
      }
    } catch (err) {
      if (err.status) throw err;
      throw badRequest(err.message);
    }

    // Segna come verificato
    await prisma.userPhoneLink.update({
      where: { userId: req.user.id },
      data: { verified: true, pendingOtpId: null },
    });

    logger.info({ userId: req.user.id, phone: link.phone }, 'Numero di telefono verificato e collegato');
    res.json({ ok: true, message: 'Numero verificato con successo!', phone: link.phone });
  }),
);

// ── DELETE /api/phone/unlink ─────────────────────────────────────────────

router.delete(
  '/unlink',
  asyncHandler(async (req, res) => {
    await prisma.userPhoneLink.deleteMany({ where: { userId: req.user.id } });
    // Rimuovi anche la chat sincronizzata se presente
    await prisma.whatsAppSyncedConversation.deleteMany({
      where: { userId: req.user.id, tenantId: req.tenantId },
    });
    res.json({ ok: true });
  }),
);

export default router;
PHONE_EOF
echo "[3/6] Route phone.js creata"

# === File 3: backend/src/routes/whatsapp-chat.js ===
cat > backend/src/routes/whatsapp-chat.js << 'WACHAT_EOF'
/**
 * Rotte per la chat sincronizzata WhatsApp.
 *
 * GET  /api/whatsapp-chat/status   → Verifica se l'utente ha una chat WA sincronizzata
 * POST /api/whatsapp-chat/init     → Crea/recupera la conversazione sincronizzata
 */

import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { asyncHandler, badRequest } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { logger } from '../config/logger.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

// GET /api/whatsapp-chat/status
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const link = await prisma.userPhoneLink.findUnique({ where: { userId: req.user.id } });
    if (!link?.verified) return res.json({ synced: false, reason: 'phone_not_linked' });

    const sync = await prisma.whatsAppSyncedConversation.findFirst({
      where: { userId: req.user.id, tenantId: req.tenantId },
    });
    res.json({ synced: !!sync, conversationId: sync?.conversationId || null, phone: link.phone });
  }),
);

// POST /api/whatsapp-chat/init
router.post(
  '/init',
  asyncHandler(async (req, res) => {
    const link = await prisma.userPhoneLink.findUnique({ where: { userId: req.user.id } });
    if (!link?.verified) throw badRequest('Numero di telefono non ancora verificato.');

    // Recupera o crea la conversazione sincronizzata
    let sync = await prisma.whatsAppSyncedConversation.findFirst({
      where: { userId: req.user.id, tenantId: req.tenantId },
      include: { conversation: true },
    });

    if (!sync) {
      const conversation = await prisma.conversation.create({
        data: {
          tenantId: req.tenantId,
          userId: req.user.id,
          title: `💬 WhatsApp — ${link.phone}`,
        },
      });
      sync = await prisma.whatsAppSyncedConversation.create({
        data: {
          tenantId: req.tenantId,
          userId: req.user.id,
          phone: link.phone,
          conversationId: conversation.id,
        },
        include: { conversation: true },
      });
      logger.info({ userId: req.user.id, phone: link.phone, conversationId: conversation.id }, 'Chat WA sincronizzata creata');
    }

    res.json({ ok: true, conversationId: sync.conversationId, phone: link.phone });
  }),
);

export default router;
WACHAT_EOF
echo "[4/6] Route whatsapp-chat.js creata"

# === File 4: backend/src/routes/gemini.js ===
cat > backend/src/routes/gemini.js << 'GEMROUTE_EOF'
/**
 * Rotte modulo Gemini.
 *
 * GET    /api/gemini/config                → Legge configurazione (solo admin)
 * PUT    /api/gemini/config                → Salva API key Gemini (solo admin)
 * POST   /api/gemini/query                 → Interroga Gemini con domanda + documento opzionale
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';
import { logger } from '../config/logger.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

// Verifica se il modulo Gemini è attivo per il tenant
async function requireGeminiEnabled(tenantId) {
  const inst = await prisma.moduleInstance.findUnique({
    where: { tenantId_moduleKey: { tenantId, moduleKey: 'gemini' } },
  });
  if (!inst?.enabled) throw badRequest('Il modulo Gemini non è attivo per questo tenant.');
  return inst;
}

// ── GET /api/gemini/config ────────────────────────────────────────────────

router.get(
  '/config',
  requirePermission(PERMISSIONS.TRAINING_MANAGE),
  asyncHandler(async (req, res) => {
    await requireGeminiEnabled(req.tenantId);
    const cfg = await prisma.geminiConfig.findUnique({ where: { tenantId: req.tenantId } });
    res.json({
      configured: !!cfg?.apiKey,
      model: cfg?.model || 'gemini-2.5-flash',
      // Non restituiamo mai la key in chiaro, solo un'indicazione
      hasKey: !!(cfg?.apiKey),
    });
  }),
);

// ── PUT /api/gemini/config ────────────────────────────────────────────────

const configSchema = z.object({
  apiKey: z.string().min(10, 'API key troppo corta'),
  model: z.string().default('gemini-2.5-flash'),
});

router.put(
  '/config',
  requirePermission(PERMISSIONS.TRAINING_MANAGE),
  asyncHandler(async (req, res) => {
    await requireGeminiEnabled(req.tenantId);
    const { apiKey, model } = configSchema.parse(req.body);

    await prisma.geminiConfig.upsert({
      where: { tenantId: req.tenantId },
      update: { apiKey, model },
      create: { tenantId: req.tenantId, apiKey, model },
    });

    logger.info({ tenantId: req.tenantId }, 'Gemini config aggiornata');
    res.json({ ok: true });
  }),
);

// ── POST /api/gemini/query ────────────────────────────────────────────────

const querySchema = z.object({
  question: z.string().min(1).max(2000),
  documentId: z.string().optional(), // ID di un TrainingDocument
});

router.post(
  '/query',
  asyncHandler(async (req, res) => {
    await requireGeminiEnabled(req.tenantId);

    const { question, documentId } = querySchema.parse(req.body);

    const cfg = await prisma.geminiConfig.findUnique({ where: { tenantId: req.tenantId } });
    if (!cfg?.apiKey) throw badRequest('API key Gemini non configurata. Vai in Moduli → Gemini → Configura.');

    let docBuffer = null;
    let docMimeType = null;
    let docFilename = null;

    if (documentId) {
      const doc = await prisma.trainingDocument.findFirst({
        where: { id: documentId, tenantId: req.tenantId },
      });
      if (!doc) throw notFound('Documento non trovato');
      docBuffer = doc.data;
      docMimeType = doc.mimeType;
      docFilename = doc.filename;
    }

    // Chiama Gemini REST API direttamente
    const model = cfg.model || 'gemini-2.5-flash';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.apiKey}`;

    const parts = [];

    if (docBuffer) {
      // Allega il documento come inline_data base64
      const b64 = Buffer.isBuffer(docBuffer) ? docBuffer.toString('base64') : docBuffer;
      parts.push({
        inline_data: {
          mime_type: docMimeType || 'application/pdf',
          data: b64,
        },
      });
      parts.push({ text: `Il documento allegato si chiama: ${docFilename}\n\n${question}` });
    } else {
      parts.push({ text: question });
    }

    let geminiRes;
    try {
      const r = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { maxOutputTokens: 2048 },
        }),
      });
      geminiRes = await r.json();
      if (!r.ok) {
        const errMsg = geminiRes?.error?.message || 'Errore Gemini';
        throw new Error(errMsg);
      }
    } catch (err) {
      logger.error({ err, tenantId: req.tenantId }, 'Errore query Gemini');
      throw badRequest(`Errore Gemini: ${err.message}`);
    }

    const answer = geminiRes.candidates?.[0]?.content?.parts?.[0]?.text || 'Nessuna risposta da Gemini.';
    res.json({ ok: true, answer });
  }),
);

export default router;
GEMROUTE_EOF

cat > backend/src/routes/training-docs.js << 'TDOCS_EOF'
/**
 * Rotte per i manuali di addestramento (interrogabili da Gemini).
 *
 * GET    /api/training-docs          → Lista documenti
 * POST   /api/training-docs          → Carica un nuovo manuale (PDF/DOCX/TXT)
 * DELETE /api/training-docs/:id      → Elimina un manuale
 */

import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../db/prisma.js';
import { asyncHandler, badRequest, notFound } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant, requirePermission(PERMISSIONS.TRAINING_MANAGE));

const ALLOWED_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const okExt = /\.(pdf|docx|txt|md)$/i.test(file.originalname);
    cb(null, ALLOWED_TYPES.has(file.mimetype) || okExt);
  },
});

// Verifica modulo Gemini attivo
async function requireGeminiEnabled(tenantId) {
  const inst = await prisma.moduleInstance.findUnique({
    where: { tenantId_moduleKey: { tenantId, moduleKey: 'gemini' } },
  });
  if (!inst?.enabled) throw badRequest('Il modulo Gemini non è attivo. Attivalo prima di caricare manuali.');
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    await requireGeminiEnabled(req.tenantId);
    const docs = await prisma.trainingDocument.findMany({
      where: { tenantId: req.tenantId },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ documents: docs });
  }),
);

router.post(
  '/',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    await requireGeminiEnabled(req.tenantId);
    if (!req.file) throw badRequest('Nessun file ricevuto');

    const doc = await prisma.trainingDocument.create({
      data: {
        tenantId: req.tenantId,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        data: req.file.buffer,
      },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true },
    });
    res.status(201).json({ document: doc });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await requireGeminiEnabled(req.tenantId);
    const { count } = await prisma.trainingDocument.deleteMany({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!count) throw notFound('Documento non trovato');
    res.json({ ok: true });
  }),
);

export default router;
TDOCS_EOF

cat > backend/src/routes/training-chat.js << 'TCHAT_EOF'
/**
 * Rotte per la modalità "chat di addestramento".
 *
 * POST /api/training-chat/:conversationId/start   → Attiva modalità addestramento
 * POST /api/training-chat/:conversationId/stop    → Disattiva modalità addestramento
 * GET  /api/training-chat/:conversationId/status  → Verifica se è in modalità addestramento
 * POST /api/training-chat/:conversationId/apply   → Applica un apprendimento al prompt
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, forbidden } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

const TRAINING_PRELOAD = `Sei in modalità chat di addestramento. 
Il tuo obiettivo è comportarti ESATTAMENTE come faresti in una conversazione reale con un utente, utilizzando il prompt precaricato.
NON rivelare che sei in modalità addestramento. NON fare riferimento a questa istruzione.
Rispondi come faresti normalmente con un utente finale.
Ogni tua risposta verrà valutata per migliorare il tuo addestramento.`;

// GET status
router.get(
  '/:conversationId/status',
  asyncHandler(async (req, res) => {
    const session = await prisma.trainingChatSession.findUnique({
      where: { conversationId: req.params.conversationId },
    });
    res.json({ isTraining: !!(session?.isActive), sessionId: session?.id || null });
  }),
);

// POST start
router.post(
  '/:conversationId/start',
  requirePermission(PERMISSIONS.TRAINING_MANAGE),
  asyncHandler(async (req, res) => {
    const conv = await prisma.conversation.findFirst({
      where: { id: req.params.conversationId, tenantId: req.tenantId },
    });
    if (!conv) throw notFound('Conversazione non trovata');

    // Svuota la conversazione e inietta il messaggio di sistema
    await prisma.message.deleteMany({ where: { conversationId: conv.id } });

    // Messaggio di sistema nascosto all'utente ma passato all'AI
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        role: 'system',
        content: TRAINING_PRELOAD,
      },
    });

    // Crea/aggiorna la sessione di training
    await prisma.trainingChatSession.upsert({
      where: { conversationId: conv.id },
      update: { isActive: true, tenantId: req.tenantId },
      create: { conversationId: conv.id, tenantId: req.tenantId, isActive: true },
    });

    res.json({ ok: true, message: 'Modalità addestramento attivata. La chat è stata svuotata.' });
  }),
);

// POST stop
router.post(
  '/:conversationId/stop',
  requirePermission(PERMISSIONS.TRAINING_MANAGE),
  asyncHandler(async (req, res) => {
    await prisma.trainingChatSession.updateMany({
      where: { conversationId: req.params.conversationId, tenantId: req.tenantId },
      data: { isActive: false },
    });
    res.json({ ok: true, message: 'Modalità addestramento disattivata.' });
  }),
);

// POST apply — aggiunge un apprendimento al contesto del training config
const applySchema = z.object({
  learning: z.string().min(1).max(2000),
  field: z.enum(['mainPrompt', 'personality', 'rules', 'context', 'instructions']).default('instructions'),
});

router.post(
  '/:conversationId/apply',
  requirePermission(PERMISSIONS.TRAINING_MANAGE),
  asyncHandler(async (req, res) => {
    const session = await prisma.trainingChatSession.findUnique({
      where: { conversationId: req.params.conversationId },
    });
    if (!session?.isActive) throw forbidden('La chat non è in modalità addestramento.');

    const { learning, field } = applySchema.parse(req.body);

    const current = await prisma.trainingConfig.upsert({
      where: { tenantId: req.tenantId },
      update: {},
      create: { tenantId: req.tenantId },
    });

    const existing = current[field] || '';
    const separator = existing ? '\n\n' : '';
    const updated = `${existing}${separator}${learning}`;

    await prisma.trainingConfig.update({
      where: { tenantId: req.tenantId },
      data: { [field]: updated },
    });

    res.json({ ok: true, message: `Apprendimento applicato al campo "${field}".` });
  }),
);

export default router;
TCHAT_EOF
echo "[5/6] Route nuove create"

cat > backend/src/routes/index.js << 'RINDEX_EOF'
import { Router } from 'express';
import auth from './auth.js';
import tenants from './tenants.js';
import users from './users.js';
import conversations from './conversations.js';
import training from './training.js';
import modules from './modules.js';
import endpoints from './endpoints.js';
import apikeys from './apikeys.js';
import embed from './embed.js';
import dashboard from './dashboard.js';
import documents from './documents.js';
import tasks from './tasks.js';
import phone from './phone.js';
import whatsappChat from './whatsapp-chat.js';
import gemini from './gemini.js';
import trainingDocs from './training-docs.js';
import trainingChat from './training-chat.js';
import { whatsappWebhookRouter, whatsappSetupRouter } from './whatsapp.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ ok: true, service: 'sophia', ts: Date.now() }));

router.use('/auth', auth);
router.use('/tenants', tenants);
router.use('/users', users);
router.use('/conversations', conversations);
router.use('/training', training);
router.use('/modules', modules);
router.use('/endpoints', endpoints);
router.use('/apikeys', apikeys);
router.use('/embed', embed);
router.use('/dashboard', dashboard);
router.use('/documents', documents);
router.use('/tasks', tasks);

// Nuove rotte
router.use('/phone', phone);
router.use('/whatsapp-chat', whatsappChat);
router.use('/gemini', gemini);
router.use('/training-docs', trainingDocs);
router.use('/training-chat', trainingChat);

// WhatsApp: webhook pubblico (nessuna auth) + setup wizard (autenticato)
router.use('/whatsapp', whatsappWebhookRouter);
router.use('/modules/whatsapp/setup', whatsappSetupRouter);

export default router;
RINDEX_EOF

cat > backend/src/routes/embed.js << 'EMBED_EOF'
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant, requirePermission(PERMISSIONS.EMBED_MANAGE));

const schema = z.object({
  title: z.string().optional(),
  primaryColor: z.string().optional(),
  logoUrl: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
  welcomeMessage: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  enabled: z.boolean().optional(),
  // Toggle delle funzionalità esposte al widget (Email, WhatsApp, API, Internet, Prompt, ...).
  enabledFeatures: z
    .object({
      modules: z.array(z.string()).optional(),
      internet: z.boolean().optional(),
      prompt: z.boolean().optional(),
      endpoints: z.array(z.string()).optional(),
    })
    .optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const embeds = await prisma.embedWidget.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ embeds });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = schema.parse(req.body);
    const embed = await prisma.embedWidget.create({ data: { ...data, tenantId: req.tenantId } });
    res.status(201).json({ embed, snippet: snippetFor(embed) });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = schema.parse(req.body);
    const embed = await prisma.embedWidget
      .update({ where: { id: req.params.id }, data })
      .catch(() => null);
    if (!embed || embed.tenantId !== req.tenantId) throw notFound('Embed non trovato');
    res.json({ embed, snippet: snippetFor(embed) });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.embedWidget.deleteMany({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!count) throw notFound('Embed non trovato');
    res.json({ ok: true });
  }),
);

// Snippet JavaScript da incollare in qualsiasi sito: una chat flottante in basso a destra.
function snippetFor(embed) {
  const apiBase = process.env.PUBLIC_API_URL || 'https://api.ai-sophia.it';
  return `<script>
  (function(){
    window.SophiaConfig = { id: "${embed.publicId}", api: "${apiBase}" };
    var s = document.createElement('script');
    s.src = "${apiBase}/widget.js";
    s.async = true;
    document.head.appendChild(s);
  })();
</script>`;
}

export default router;
EMBED_EOF

cat > backend/src/routes/conversations.js << 'CONV_EOF'
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

// Le conversazioni sono isolate per tenant E per utente.
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
});

// Invia un messaggio e riceve la risposta AI in streaming (Server-Sent Events).
router.post(
  '/:id/messages',
  requirePermission(PERMISSIONS.CHAT_USE),
  asyncHandler(async (req, res) => {
    const { content, attachments } = sendSchema.parse(req.body);

    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, ...ownScope(req) },
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 40 } },
    });
    if (!conversation) throw notFound('Conversazione non trovata');

    // Persiste il messaggio utente.
    await prisma.message.create({
      data: { conversationId: conversation.id, role: 'user', content, attachments: attachments ?? undefined },
    });

    // Rinomina automaticamente alla prima interazione.
    if (conversation.title === 'Nuova conversazione') {
      const title = content.slice(0, 48) + (content.length > 48 ? '…' : '');
      await prisma.conversation.update({ where: { id: conversation.id }, data: { title } });
    }

    const history = [
      ...conversation.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content },
    ];

    // Header SSE.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      const { content: answer, toolCalls } = await runChat({
        tenantId: req.tenantId,
        conversationId: conversation.id,
        history,
        onToken: (delta) => send('token', { delta }),
        onToolCall: (call) => send('tool', call),
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

      // Se questa è una chat sincronizzata WA, invia anche su WhatsApp
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
            const sessionOpen = contact?.sessionExpiresAt && contact.sessionExpiresAt > new Date();
            if (sessionOpen) {
              await fetch(`https://graph.facebook.com/v25.0/${cfg.phoneNumberId}/messages`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ messaging_product: 'whatsapp', to: sync.phone, type: 'text', text: { body: answer } }),
              }).catch(() => {});
            }
          }
        }
      } catch { /* Non blocca lo streaming */ }

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
CONV_EOF

cat > backend/src/routes/whatsapp.js << 'WA_EOF'
/**
 * Rotte WhatsApp
 *
 * GET  /api/whatsapp/webhook          Meta verification handshake
 * POST /api/whatsapp/webhook          Ricezione eventi da Meta
 *
 * (autenticate, per setup wizard)
 * GET  /api/modules/whatsapp/setup/templates      Lista template WABA
 * POST /api/modules/whatsapp/setup/templates      Crea template conversation_continue
 * GET  /api/modules/whatsapp/setup/webhook-info   Restituisce URL webhook + verify token
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
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body, to }),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`WhatsApp API: ${JSON.stringify(data)}`);
  return data;
}

// Consegna tutti i messaggi pendenti a un contatto e apre la sessione 24h
async function deliverPendingMessages(tenantId, phone) {
  const cfg = await getWAConfig(tenantId);
  if (!cfg.accessToken || !cfg.phoneNumberId) {
    logger.warn({ tenantId, phone }, 'WA deliverPending: config mancante');
    return;
  }

  const pending = await prisma.whatsAppPendingMessage.findMany({
    where: { tenantId, to: phone, deliveredAt: null },
    orderBy: { createdAt: 'asc' },
  });

  logger.info({ tenantId, phone, count: pending.length }, 'WA: consegna messaggi pendenti');

  for (const msg of pending) {
    try {
      let body;
      if (msg.type === 'text') {
        body = { type: 'text', text: { body: msg.content.text } };
      } else if (msg.type === 'image') {
        body = { type: 'image', image: { link: msg.content.url, caption: msg.content.caption } };
      } else if (msg.type === 'document') {
        body = {
          type: 'document',
          document: { link: msg.content.url, caption: msg.content.caption, filename: msg.content.filename },
        };
      }
      if (body) await sendWAMessage(cfg.accessToken, cfg.phoneNumberId, phone, body);
      await prisma.whatsAppPendingMessage.update({ where: { id: msg.id }, data: { deliveredAt: new Date() } });
      logger.info({ tenantId, phone, msgId: msg.id, type: msg.type }, 'WA: messaggio pendente consegnato');
    } catch (err) {
      logger.warn({ err, msgId: msg.id }, 'WA: errore consegna messaggio pendente');
    }
  }

  // Apri sessione 24h
  const sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.whatsAppContact.upsert({
    where: { tenantId_phone: { tenantId, phone } },
    update: { sessionExpiresAt, updatedAt: new Date() },
    create: { tenantId, phone, sessionExpiresAt },
  });
}

// ── Webhook pubblico (nessuna autenticazione Sophia) ─────────────────────

// GET: Meta verifica il webhook all'attivazione
router.get(
  '/webhook',
  asyncHandler(async (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    logger.info({ mode, token, challenge }, 'WA webhook: GET verifica Meta');

    if (mode === 'subscribe') {
      const instances = await prisma.moduleInstance.findMany({
        where: { moduleKey: 'whatsapp' },
      });
      const match = instances.find((i) => i.config?.webhookVerifyToken === token);
      if (match) {
        logger.info({ tenantId: match.tenantId }, 'WA webhook: verifica OK');
        return res.status(200).send(challenge);
      }
      logger.warn({ token }, 'WA webhook: verify_token non trovato');
    }
    res.sendStatus(403);
  }),
);

// POST: Meta invia eventi (messaggi, status, button press…)
// Log COMPLETO di tutto quello che arriva da Meta — niente viene omesso.
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    // Risponde subito a Meta (entro 200ms come richiesto)
    res.sendStatus(200);

    const body = req.body;

    // ── Log grezzo integrale di ogni POST da Meta ──────────────────────────
    logger.info({ webhook: JSON.stringify(body) }, 'WA webhook: payload ricevuto da Meta');

    if (body?.object !== 'whatsapp_business_account') {
      logger.warn({ object: body?.object }, 'WA webhook: object non riconosciuto, ignorato');
      return;
    }

    for (const entry of body.entry ?? []) {
      const wabaId = entry.id;
      logger.info({ wabaId }, 'WA webhook: entry elaborata');

      // Trova il tenant tramite businessAccountId
      const instances = await prisma.moduleInstance.findMany({
        where: { moduleKey: 'whatsapp' },
      });
      const inst = instances.find((i) => i.config?.businessAccountId === wabaId);
      if (!inst) {
        logger.warn({ wabaId, available: instances.map(i => i.config?.businessAccountId) }, 'WA webhook: tenant non trovato per questo wabaId');
        continue;
      }

      const tenantId = inst.tenantId;

      for (const change of entry.changes ?? []) {
        logger.info({ field: change.field }, 'WA webhook: change ricevuto');
        if (change.field !== 'messages') continue;

        const value = change.value;
        logger.info({ statuses: value?.statuses?.length, messages: value?.messages?.length }, 'WA webhook: value');

        for (const msg of value?.messages ?? []) {
          const phone = msg.from;
          logger.info({ tenantId, phone, type: msg.type, msg: JSON.stringify(msg) }, 'WA webhook: messaggio ricevuto');

          // ── Pulsante "Continua" / quick_reply ────────────────────────────
          // Meta può inviare il button come type='button' oppure come
          // interactive/button_reply a seconda della versione e del template.
          const isButtonContinue =
            msg.type === 'button' ||
            msg.type === 'interactive' ||
            (msg.type === 'text' && (
              msg.text?.body?.toLowerCase() === 'continua' ||
              msg.text?.body?.toLowerCase() === 'continue'
            ));

          if (isButtonContinue) {
            logger.info({ tenantId, phone, type: msg.type }, 'WA webhook: "Continua" rilevato — consegno messaggi pendenti');
            await deliverPendingMessages(tenantId, phone);
          } else if (msg.type === 'text') {
            // Messaggio testuale libero → apri/rinnova sessione 24h
            const sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await prisma.whatsAppContact.upsert({
              where: { tenantId_phone: { tenantId, phone } },
              update: { sessionExpiresAt, updatedAt: new Date() },
              create: { tenantId, phone, sessionExpiresAt },
            });
            logger.info({ tenantId, phone, sessionExpiresAt }, 'WA webhook: sessione aperta/rinnovata');

            // ── Chat sincronizzata: aggiungi messaggio e fai rispondere l'AI ──
            try {
              // Meta invia il numero senza +, il DB lo salva con +
              const phoneNorm = phone.startsWith('+') ? phone : \`+\${phone}\`;
              const sync = await prisma.whatsAppSyncedConversation.findFirst({
                where: { tenantId, phone: phoneNorm },
              });
              if (sync) {
                const messageText = msg.text?.body || '';

                // Salva messaggio utente
                await prisma.message.create({
                  data: { conversationId: sync.conversationId, role: 'user', content: messageText },
                });

                // Emetti evento realtime al frontend
                const { emitToTenant } = await import('../realtime/io.js');
                emitToTenant(tenantId, 'whatsapp:message', {
                  conversationId: sync.conversationId,
                  role: 'user',
                  content: messageText,
                  phone,
                });

                // Fai rispondere l'AI in background
                (async () => {
                  try {
                    const { runChat } = await import('../ai/engine.js');
                    const history = await prisma.message.findMany({
                      where: { conversationId: sync.conversationId, role: { not: 'system' } },
                      orderBy: { createdAt: 'asc' },
                      select: { role: true, content: true },
                    });

                    let aiText = '';
                    await runChat({
                      tenantId,
                      conversationId: sync.conversationId,
                      history: history.map((m) => ({ role: m.role, content: m.content })),
                      onToken: (t) => { aiText += t; },
                    });

                    if (aiText) {
                      // Salva risposta AI
                      await prisma.message.create({
                        data: { conversationId: sync.conversationId, role: 'assistant', content: aiText },
                      });

                      // Emetti al frontend
                      emitToTenant(tenantId, 'whatsapp:message', {
                        conversationId: sync.conversationId,
                        role: 'assistant',
                        content: aiText,
                        phone,
                      });

                      // Invia risposta su WhatsApp
                      const cfg = await getWAConfig(tenantId);
                      if (cfg.accessToken && cfg.phoneNumberId) {
                        await sendWAMessage(cfg.accessToken, cfg.phoneNumberId, phone, {
                          type: 'text',
                          text: { body: aiText },
                        });
                      }
                    }
                  } catch (err) {
                    logger.error({ err, tenantId, phone }, 'WA sync: errore risposta AI');
                  }
                })();
              }
            } catch (err) {
              logger.warn({ err }, 'WA sync chat: errore elaborazione');
            }
          }
        }
      }
    }
  }),
);

// ── Setup wizard (autenticato) ──────────────────────────────────────────

const setupRouter = Router();
setupRouter.use(authenticate, tenantScope, requireTenant);

// GET /api/modules/whatsapp/setup/templates
setupRouter.get(
  '/templates',
  asyncHandler(async (req, res) => {
    const cfg = await getWAConfig(req.tenantId);
    if (!cfg.accessToken || !cfg.businessAccountId) {
      return res.status(400).json({ error: 'Credenziali WhatsApp non configurate.' });
    }

    const r = await fetch(
      `https://graph.facebook.com/v25.0/${cfg.businessAccountId}/message_templates?limit=250`,
      { headers: { Authorization: `Bearer ${cfg.accessToken}` } },
    );
    const data = await r.json();

    if (!r.ok) {
      const errMsg = humanizeWAError(data?.error);
      return res.status(400).json({ error: errMsg });
    }

    const templates = Object.values(data?.data ?? {});
    const found = templates.find(
      (t) => t.name === 'conversation_continue' && t.status === 'APPROVED',
    );
    res.json({ templates, templateReady: !!found });
  }),
);

// POST /api/modules/whatsapp/setup/templates
setupRouter.post(
  '/templates',
  asyncHandler(async (req, res) => {
    const cfg = await getWAConfig(req.tenantId);
    if (!cfg.accessToken || !cfg.businessAccountId) {
      return res.status(400).json({ error: 'Credenziali WhatsApp non configurate.' });
    }

    const lang = req.body?.language === 'en' ? 'en' : 'it';

    const translations = {
      it: {
        header: 'Benvenuto in Sophia',
        body: 'Ciao! Hai una notifica in attesa. Premi il pulsante qui sotto per riceverla e continuare la conversazione su WhatsApp.',
        button: 'Continua',
      },
      en: {
        header: 'Welcome to Sophia',
        body: 'Hi! You have a pending notification. Press the button below to receive it and continue the conversation on WhatsApp.',
        button: 'Continue',
      },
    };
    const t = translations[lang];

    const payload = {
      name: 'conversation_continue',
      language: lang,
      category: 'MARKETING',
      components: [
        { type: 'HEADER', format: 'TEXT', text: t.header },
        { type: 'BODY', text: t.body },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'QUICK_REPLY', text: t.button }],
        },
      ],
    };

    const r = await fetch(
      `https://graph.facebook.com/v25.0/${cfg.businessAccountId}/message_templates`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    const data = await r.json();

    if (!r.ok) {
      return res.status(400).json({ error: humanizeWAError(data?.error) });
    }
    res.json({ ok: true, template: data });
  }),
);

// GET /api/modules/whatsapp/setup/webhook-info
setupRouter.get(
  '/webhook-info',
  asyncHandler(async (req, res) => {
    const cfg = await getWAConfig(req.tenantId);

    let verifyToken = cfg.webhookVerifyToken;
    if (!verifyToken) {
      verifyToken = `sophia_${req.tenantId.slice(-8)}_${Math.random().toString(36).slice(2, 10)}`;
      await prisma.moduleInstance.updateMany({
        where: { tenantId: req.tenantId, moduleKey: 'whatsapp' },
        data: { config: { ...cfg, webhookVerifyToken: verifyToken } },
      });
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'api.ai-sophia.it';
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const webhookUrl = `${proto}://${host}/api/whatsapp/webhook`;

    res.json({ webhookUrl, verifyToken });
  }),
);

export { router as whatsappWebhookRouter, setupRouter as whatsappSetupRouter };

function humanizeWAError(error) {
  if (!error) return 'Errore sconosciuto dalla WhatsApp API.';
  switch (error.code) {
    case 190: return `Token di accesso non valido o scaduto. Verifica il tuo Access Token.`;
    case 200: return `Permessi insufficienti. Assicurati che il token abbia le autorizzazioni whatsapp_business_management e whatsapp_business_messaging.`;
    case 803: return `Account WhatsApp Business non trovato. Controlla il Business Account ID.`;
    case 2:   return `Errore temporaneo Meta. Riprova tra qualche secondo.`;
    default:  return `Errore Meta (codice ${error.code}): ${error.message ?? 'nessun dettaglio'}`;
  }
}
WA_EOF

cat > backend/src/config/index.js << 'CFG_EOF'
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string(),
  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().default('simone@phi.it'),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(6).default('Ciao123!'),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-5.5'),
  MAX_UPLOAD_MB: z.coerce.number().default(20),
  // Chiave API per OTP via ai-sophia (otp.ai-sophia.it)
  OTP_API_KEY: z.string().optional().default(''),
  // URL pubblico del backend (usato per lo snippet embed)
  PUBLIC_API_URL: z.string().default('https://api.ai-sophia.it'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Errore di configurazione: fallisci subito con un messaggio chiaro.
  console.error('Configurazione non valida:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
CFG_EOF

cat > backend/prisma/schema.prisma << 'SCHEMA_EOF'
// Sophia (PH) — Schema dati multi-tenant
// Provider: PostgreSQL. Le migrazioni vengono applicate automaticamente all'avvio (vedi src/db/bootstrap.js).

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─────────────────────────────────────────────────────────────
// Tenancy & identità
// ─────────────────────────────────────────────────────────────

enum SystemRole {
  SUPER_ADMIN // opera trasversalmente a tutti i tenant
  ADMIN // gestisce esclusivamente il proprio tenant
  MEMBER // utente standard del tenant
}

model Tenant {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  users         User[]
  conversations Conversation[]
  training      TrainingConfig?
  moduleInstances ModuleInstance[]
  apiEndpoints  ApiEndpoint[]
  apiKeys       ApiKey[]
  embeds        EmbedWidget[]
  documents     Document[]
  auditLogs     AuditLog[]
  whatsAppSyncedConversations WhatsAppSyncedConversation[]
  geminiConfig  GeminiConfig?
  trainingDocuments TrainingDocument[]
  trainingChatSessions TrainingChatSession[]
  backgroundTasks BackgroundTask[]
}

model User {
  id           String     @id @default(cuid())
  email        String     @unique
  passwordHash String
  name         String?
  role         SystemRole @default(MEMBER)
  isActive     Boolean    @default(true)
  // Un SUPER_ADMIN può non appartenere ad alcun tenant (tenantId null).
  tenantId     String?
  tenant       Tenant?    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt

  permissions   UserPermission[]
  refreshTokens RefreshToken[]
  conversations Conversation[]
  auditLogs     AuditLog[]
  phoneLink     UserPhoneLink?
  whatsAppSyncedConversations WhatsAppSyncedConversation[]

  @@index([tenantId])
}

// RBAC granulare: ogni permesso è una stringa "risorsa:azione" (es. "users:create").
model UserPermission {
  id     String @id @default(cuid())
  userId String
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  key    String

  @@unique([userId, key])
  @@index([userId])
}

model RefreshToken {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String   @unique
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime @default(now())

  @@index([userId])
}

// ─────────────────────────────────────────────────────────────
// Chat AI
// ─────────────────────────────────────────────────────────────

enum MessageRole {
  user
  assistant
  system
  tool
}

model Conversation {
  id        String   @id @default(cuid())
  tenantId  String
  tenant    Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  title     String   @default("Nuova conversazione")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  messages Message[]
  backgroundTasks BackgroundTask[]
  whatsAppSync  WhatsAppSyncedConversation?
  trainingSession TrainingChatSession?

  @@index([tenantId, userId])
}

model Message {
  id             String       @id @default(cuid())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  role           MessageRole
  content        String
  // Eventuali chiamate a capability dei moduli effettuate dall'AI per questo messaggio.
  toolCalls      Json?
  attachments    Json?
  createdAt      DateTime     @default(now())

  @@index([conversationId])
}

// ─────────────────────────────────────────────────────────────
// Addestramento (system prompt persistente per tenant)
// ─────────────────────────────────────────────────────────────

model TrainingConfig {
  id           String  @id @default(cuid())
  tenantId     String  @unique
  tenant       Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  mainPrompt   String  @default("")
  personality  String  @default("")
  rules        String  @default("")
  context      String  @default("")
  instructions String  @default("")
  updatedAt    DateTime @updatedAt
}

// ─────────────────────────────────────────────────────────────
// Sistema moduli (plugin)
// ─────────────────────────────────────────────────────────────

// Stato per-tenant di un modulo. La definizione del modulo vive nel codice
// (cartella src/modules/*); qui memorizziamo installazione e configurazione.
model ModuleInstance {
  id          String   @id @default(cuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  moduleKey   String // es. "email", "whatsapp", "connect-api"
  installed   Boolean  @default(true)
  enabled     Boolean  @default(true)
  config      Json     @default("{}")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([tenantId, moduleKey])
  @@index([tenantId])
}

// ─────────────────────────────────────────────────────────────
// Modulo "Connetti API": registro endpoint utilizzabili dall'AI
// ─────────────────────────────────────────────────────────────

enum HttpMethod {
  GET
  POST
  PUT
  PATCH
  DELETE
}

model ApiEndpoint {
  id          String     @id @default(cuid())
  tenantId    String
  tenant      Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name        String
  description String     @default("")
  url         String
  method      HttpMethod @default(GET)
  category    String     @default("Generale")
  // Strutture flessibili: { "Authorization": "Bearer {{token}}" }, ecc.
  headers     Json       @default("{}")
  query       Json       @default("{}")
  params      Json       @default("{}")
  body        Json       @default("{}")
  variables   Json       @default("{}")
  bearerToken String?
  enabled     Boolean    @default(true)
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt

  @@index([tenantId])
}

// ─────────────────────────────────────────────────────────────
// Task in background: retry intelligenti su chiamate API fallite
// (es. 429 / "riprova più tardi") e azioni ricorrenti per chat
// (es. "ogni ora invia questo messaggio su WhatsApp").
// Eseguiti lato server da un piccolo scheduler in-process, quindi
// continuano a girare anche se l'utente chiude il browser.
// ─────────────────────────────────────────────────────────────

enum BackgroundTaskKind {
  RETRY // one-shot: riprova una chiamata endpoint dopo un certo ritardo
  RECURRING // si ripete ogni intervalSeconds, riesegue "instruction" in chat
}

enum BackgroundTaskStatus {
  ACTIVE
  PAUSED
  DONE
  FAILED
}

model BackgroundTask {
  id              String              @id @default(cuid())
  tenantId        String
  tenant          Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  conversationId  String?
  conversation    Conversation?       @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  kind            BackgroundTaskKind
  // Per RECURRING: istruzione in linguaggio naturale da rieseguire come messaggio utente.
  // Per RETRY: descrizione leggibile (es. "Riprova chiamata a 'Verifica template'").
  instruction     String              @default("")
  // Dati aggiuntivi: per RETRY { endpointId, variables }; per RECURRING eventuale contesto extra.
  payload         Json                @default("{}")
  // null per RETRY (one-shot); valore in secondi per RECURRING.
  intervalSeconds Int?
  runAt           DateTime
  attempts        Int                 @default(0)
  maxAttempts     Int?
  status          BackgroundTaskStatus @default(ACTIVE)
  lastResult      Json?
  lastRunAt       DateTime?
  createdAt       DateTime            @default(now())
  updatedAt       DateTime            @updatedAt

  @@index([tenantId, status, runAt])
  @@index([conversationId])
}



model ApiKey {
  id          String    @id @default(cuid())
  tenantId    String
  tenant      Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name        String
  description String    @default("")
  // Mostrato una sola volta in chiaro alla creazione; in DB solo l'hash.
  keyHash     String    @unique
  prefix      String // primi caratteri, per riconoscimento in lista
  permissions Json      @default("[]")
  enabled     Boolean   @default(true)
  lastUsedAt  DateTime?
  createdAt   DateTime  @default(now())

  @@index([tenantId])
}

// ─────────────────────────────────────────────────────────────
// Embed (widget chat per siti esterni)
// ─────────────────────────────────────────────────────────────

model EmbedWidget {
  id              String   @id @default(cuid())
  tenantId        String
  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  publicId        String   @unique @default(cuid())
  title           String   @default("Assistente")
  primaryColor    String   @default("#2563eb")
  logoUrl         String?
  iconUrl         String?
  welcomeMessage  String   @default("Ciao! Come posso aiutarti?")
  width           Int      @default(380)
  height          Int      @default(600)
  // Toggle delle capability esposte al widget pubblico.
  enabledFeatures Json     @default("{}")
  enabled         Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([tenantId])
}

// ─────────────────────────────────────────────────────────────
// Documenti caricati (sorgente per RAG / documentazione API)
// ─────────────────────────────────────────────────────────────

model Document {
  id          String   @id @default(cuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  filename    String
  mimeType    String
  sizeBytes   Int
  // Testo estratto (pdf/docx/txt/md) per uso da parte dell'AI.
  extracted   String   @default("")
  createdAt   DateTime @default(now())

  @@index([tenantId])
}

// ─────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────

model AuditLog {
  id        String   @id @default(cuid())
  tenantId  String?
  tenant    Tenant?  @relation(fields: [tenantId], references: [id], onDelete: SetNull)
  userId    String?
  user      User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  action    String
  target    String?
  metadata  Json?
  ip        String?
  createdAt DateTime @default(now())

  @@index([tenantId])
  @@index([userId])
}

// ─────────────────────────────────────────────────────────────
// WhatsApp: messaggi in coda e sessioni contatti
// ─────────────────────────────────────────────────────────────

model WhatsAppPendingMessage {
  id              String    @id @default(cuid())
  tenantId        String
  to              String    // numero E.164 / wa_id
  type            String    @default("text") // text | image | document
  content         Json      // { text } | { url, caption } | { url, filename, caption }
  deliveredAt     DateTime?
  createdAt       DateTime  @default(now())

  @@index([tenantId, to, deliveredAt])
}

model WhatsAppContact {
  id               String    @id @default(cuid())
  tenantId         String
  phone            String    // wa_id del contatto
  sessionExpiresAt DateTime? // sessione 24h aperta dopo l'ultima risposta
  templateSentAt   DateTime? // ultima volta che abbiamo inviato il template
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  @@unique([tenantId, phone])
  @@index([tenantId])
}

// ─────────────────────────────────────────────────────────────
// Collegamento numero di telefono utente (OTP via ai-sophia)
// ─────────────────────────────────────────────────────────────

model UserPhoneLink {
  id          String   @id @default(cuid())
  userId      String   @unique
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  phone       String   // E.164, es. +393331234567
  verified    Boolean  @default(false)
  pendingOtpId String?  // otp_... restituito da ai-sophia
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([userId])
}

// ─────────────────────────────────────────────────────────────
// Chat sincronizzata WhatsApp per tenant
// ─────────────────────────────────────────────────────────────

model WhatsAppSyncedConversation {
  id             String       @id @default(cuid())
  tenantId       String
  tenant         Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  userId         String
  user           User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  phone          String       // numero WA certificato
  conversationId String       @unique
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  createdAt      DateTime     @default(now())

  @@index([tenantId, phone])
}

// ─────────────────────────────────────────────────────────────
// Modulo Gemini: API key per tenant (gestita nel DB, non nel .env)
// ─────────────────────────────────────────────────────────────

model GeminiConfig {
  id         String   @id @default(cuid())
  tenantId   String   @unique
  tenant     Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  apiKey     String   // chiave Google Gemini per questo tenant
  model      String   @default("gemini-2.5-flash")
  updatedAt  DateTime @updatedAt
}

// ─────────────────────────────────────────────────────────────
// Documenti training (manuali interrogabili da Gemini)
// ─────────────────────────────────────────────────────────────

model TrainingDocument {
  id        String   @id @default(cuid())
  tenantId  String
  tenant    Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  filename  String
  mimeType  String
  sizeBytes Int
  data      Bytes    // file binario memorizzato (max ~5 MB consigliato)
  createdAt DateTime @default(now())

  @@index([tenantId])
}

// ─────────────────────────────────────────────────────────────
// Chat di addestramento (flag + snapshot prompt)
// ─────────────────────────────────────────────────────────────

model TrainingChatSession {
  id             String       @id @default(cuid())
  conversationId String       @unique
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  tenantId       String
  tenant         Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  isActive       Boolean      @default(true)
  createdAt      DateTime     @default(now())

  @@index([tenantId])
}
SCHEMA_EOF

cat > frontend/src/pages/Chat.jsx << 'CHAT_EOF'
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Plus, Search, Send, Paperclip, Mic, MoreVertical, Trash2, Pencil, X,
  Activity, Clock, CheckCircle2, Pause, Play, ChevronDown, ChevronUp,
  MessageCircle, Phone, FlaskConical,
} from 'lucide-react';
import { api, streamMessage, upload } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import Markdown from '../components/Markdown.jsx';

function formatDateTime(dt) {
  if (!dt) return '';
  return new Date(dt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formatInterval(s) {
  if (!s) return '';
  if (s >= 3600) return `ogni ${Math.round(s / 3600)} ora/e`;
  if (s >= 60) return `ogni ${Math.round(s / 60)} minuti`;
  return `ogni ${s} secondi`;
}
function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ── Pannello attività ──────────────────────────────────────────────────────

function ActivityPanel({ conversationId, refreshKey }) {
  const [tasks, setTasks] = useState([]);
  const [actionLog, setActionLog] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('sophia.actionLog') || '[]'); } catch { return []; }
  });
  const [open, setOpen] = useState(true);
  const toast = useToast();

  const load = useCallback(async () => {
    if (!conversationId) return;
    try { const { tasks } = await api(`/tasks?conversationId=${conversationId}`); setTasks(tasks); } catch {}
  }, [conversationId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  useEffect(() => {
    const handler = (e) => {
      const entry = e.detail;
      setActionLog((prev) => { const next = [entry, ...prev].slice(0, 50); sessionStorage.setItem('sophia.actionLog', JSON.stringify(next)); return next; });
    };
    window.addEventListener('sophia:action', handler);
    return () => window.removeEventListener('sophia:action', handler);
  }, []);

  const toggleTask = async (task) => {
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: task.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' } });
      load();
    } catch (err) { toast.error(err.message); }
  };
  const deleteTask = async (task) => {
    try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); load(); } catch (err) { toast.error(err.message); }
  };
  const clearLog = () => { setActionLog([]); sessionStorage.removeItem('sophia.actionLog'); };

  const activeTasks = tasks.filter((t) => t.kind === 'RECURRING');
  return (
    <aside className="activity-panel">
      <div className="activity-header" onClick={() => setOpen((o) => !o)}>
        <span><Activity size={15} /> Attività</span>
        {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </div>
      {open && (
        <div className="activity-body">
          <div className="activity-section-title">Attività programmate</div>
          {activeTasks.length === 0 && <p className="activity-empty">Nessuna attività attiva.</p>}
          {activeTasks.map((t) => (
            <div key={t.id} className={`activity-item ${t.status === 'PAUSED' ? 'paused' : ''}`}>
              <div className="activity-item-top"><span className="activity-item-label">{t.instruction}</span></div>
              <div className="activity-item-meta">
                <Clock size={11} />{t.intervalSeconds ? formatInterval(t.intervalSeconds) : 'una volta'}
                {t.lastRunAt && <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>· ultima: {formatDateTime(t.lastRunAt)}</span>}
              </div>
              <div className="activity-item-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => toggleTask(t)}>
                  {t.status === 'ACTIVE' ? <Pause size={12} /> : <Play size={12} />}
                  {t.status === 'ACTIVE' ? 'Pausa' : 'Riattiva'}
                </button>
                <button className="btn btn-danger icon-btn" onClick={() => deleteTask(t)}><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
          <div className="activity-section-title" style={{ marginTop: 16 }}>
            Azioni eseguite
            {actionLog.length > 0 && <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', fontSize: 11 }} onClick={clearLog}>Cancella</button>}
          </div>
          {actionLog.length === 0 && <p className="activity-empty">Nessuna azione registrata.</p>}
          {actionLog.map((entry, i) => (
            <div key={i} className="action-log-item">
              <CheckCircle2 size={12} className="action-log-icon" />
              <div><div className="action-log-name">{entry.label}</div><div className="action-log-time">{entry.time}</div></div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

// ── Modal collegamento telefono ────────────────────────────────────────────

function PhoneLinkModal({ onClose, onLinked }) {
  const toast = useToast();
  const [step, setStep] = useState('phone'); // phone | otp | done
  const [phone, setPhone] = useState('+39');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [expiresAt, setExpiresAt] = useState(null);
  const inputRefs = useRef([]);

  const sendOtp = async () => {
    if (!phone.match(/^\+\d{7,15}$/)) return toast.error('Formato numero non valido (es. +393331234567)');
    setLoading(true);
    try {
      const { expiresAt } = await api('/phone/link', { method: 'POST', body: { phone } });
      setExpiresAt(expiresAt);
      setStep('otp');
      toast.info('OTP inviato via WhatsApp!');
    } catch (err) { toast.error(err.message); } finally { setLoading(false); }
  };

  const verifyOtp = async () => {
    const code = otp.join('');
    if (code.length !== 6) return toast.error('Inserisci tutte le 6 cifre');
    setLoading(true);
    try {
      await api('/phone/verify', { method: 'POST', body: { code } });
      setStep('done');
      onLinked(phone);
    } catch (err) { toast.error(err.message); } finally { setLoading(false); }
  };

  const handleOtpChange = (i, val) => {
    const d = val.replace(/\D/g, '').slice(-1);
    const next = [...otp]; next[i] = d; setOtp(next);
    if (d && i < 5) inputRefs.current[i + 1]?.focus();
  };
  const handleOtpKey = (i, e) => {
    if (e.key === 'Backspace' && !otp[i] && i > 0) { inputRefs.current[i - 1]?.focus(); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Phone size={18} /> Collega numero WhatsApp</h2>
        {step === 'phone' && (
          <div className="phone-link-box">
            <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Inserisci il tuo numero di telefono. Riceverai un codice OTP via WhatsApp per verificarlo.</p>
            <div className="field">
              <label>Numero (formato internazionale)</label>
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+393331234567" />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
              <button className="btn btn-primary" onClick={sendOtp} disabled={loading}>{loading ? 'Invio…' : 'Invia OTP'}</button>
            </div>
          </div>
        )}
        {step === 'otp' && (
          <div className="phone-link-box">
            <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Inserisci il codice a 6 cifre ricevuto su WhatsApp al numero <strong>{phone}</strong>.</p>
            {expiresAt && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Valido fino alle {new Date(expiresAt).toLocaleTimeString('it-IT')}</p>}
            <div className="otp-inputs">
              {otp.map((d, i) => (
                <input key={i} ref={(el) => inputRefs.current[i] = el} className="otp-digit" maxLength={1} value={d}
                  onChange={(e) => handleOtpChange(i, e.target.value)}
                  onKeyDown={(e) => handleOtpKey(i, e)}
                  inputMode="numeric" />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setStep('phone')}>← Indietro</button>
              <button className="btn btn-primary" onClick={verifyOtp} disabled={loading || otp.join('').length < 6}>{loading ? 'Verifica…' : 'Verifica'}</button>
            </div>
          </div>
        )}
        {step === 'done' && (
          <div className="phone-link-box" style={{ alignItems: 'center', textAlign: 'center' }}>
            <div style={{ fontSize: 48 }}>✅</div>
            <p style={{ fontWeight: 700, fontSize: 16 }}>Numero verificato!</p>
            <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>{phone} è ora collegato al tuo account.</p>
            <button className="btn btn-primary" onClick={onClose}>Chiudi</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Chat principale ────────────────────────────────────────────────────────

export default function Chat() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();

  const [conversations, setConversations] = useState([]);
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]); // [{file, name, type}]
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [menuFor, setMenuFor] = useState(null);
  const [activityKey, setActivityKey] = useState(0);
  const [waSyncId, setWaSyncId] = useState(null); // conversationId sincronizzata WA
  const [waPhone, setWaPhone] = useState(null);
  const [phoneLinked, setPhoneLinked] = useState(false);
  const [showPhoneModal, setShowPhoneModal] = useState(false);
  const [isTrainingChat, setIsTrainingChat] = useState(false);
  const [trainingLoading, setTrainingLoading] = useState(false);
  const [pendingLearning, setPendingLearning] = useState(null);
  const scrollRef = useRef(null);
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';

  const loadConversations = useCallback(async (q = '') => {
    try {
      const { conversations } = await api(`/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      setConversations(conversations);
    } catch {}
  }, []);

  // Carica stato phone link e WA sync
  const loadPhoneStatus = useCallback(async () => {
    try {
      const { linked, verified, phone } = await api('/phone/status');
      setPhoneLinked(!!(linked && verified));
      if (linked && verified) {
        const { synced, conversationId, phone: waPh } = await api('/whatsapp-chat/status');
        if (synced) { setWaSyncId(conversationId); setWaPhone(waPh); }
        else setWaPhone(phone);
      }
    } catch {}
  }, []);

  useEffect(() => { loadConversations(); loadPhoneStatus(); }, [loadConversations, loadPhoneStatus]);

  useEffect(() => {
    if (!id) { setMessages([]); setIsTrainingChat(false); return; }
    api(`/conversations/${id}`)
      .then(({ conversation }) => setMessages(conversation.messages.filter(m => m.role !== 'system')))
      .catch(() => navigate('/chat'));
    // Controlla se è una chat di training
    if (isAdmin) {
      api(`/training-chat/${id}/status`).then(({ isTraining }) => setIsTrainingChat(isTraining)).catch(() => {});
    }
  }, [id, navigate, isAdmin]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamText]);

  // Ascolta messaggi WA in realtime
  useEffect(() => {
    const handler = (e) => {
      const { conversationId, role, content } = e.detail || {};
      if (conversationId === id) {
        setMessages((m) => [...m, { id: `wa-${Date.now()}`, role, content }]);
      }
    };
    window.addEventListener('sophia:wa:message', handler);
    return () => window.removeEventListener('sophia:wa:message', handler);
  }, [id]);

  const newConversation = async () => {
    const { conversation } = await api('/conversations', { method: 'POST' });
    await loadConversations();
    navigate(`/chat/${conversation.id}`);
  };

  const initWaSync = async () => {
    try {
      const { conversationId, phone } = await api('/whatsapp-chat/init', { method: 'POST' });
      setWaSyncId(conversationId);
      setWaPhone(phone);
      await loadConversations();
      navigate(`/chat/${conversationId}`);
      toast.info('Chat WhatsApp sincronizzata creata!');
    } catch (err) { toast.error(err.message); }
  };

  // Allega file vero (non inserisce testo nella textarea)
  const onAttach = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachments((a) => [...a, { file, name: file.name, type: file.type, size: file.size }]);
    e.target.value = '';
  };

  const removeAttachment = (i) => setAttachments((a) => a.filter((_, idx) => idx !== i));

  const send = async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || streaming) return;

    let convId = id;
    if (!convId) {
      const { conversation } = await api('/conversations', { method: 'POST' });
      convId = conversation.id;
      navigate(`/chat/${convId}`);
    }

    // Upload allegati se presenti
    const uploadedDocs = [];
    for (const att of attachments) {
      try {
        const { document } = await upload('/documents', att.file);
        uploadedDocs.push({ id: document?.id, name: att.name, type: att.type });
      } catch (err) { toast.error(`Errore upload ${att.name}: ${err.message}`); }
    }

    const messageText = text || (uploadedDocs.length ? `[Allegati: ${uploadedDocs.map(d => d.name).join(', ')}]` : '');
    // Se l'utente dice "inviami su whatsapp" con allegati, li nomina nel testo
    const finalText = uploadedDocs.length && text ? `${text}\n\n[Allegati: ${uploadedDocs.map(d => d.name).join(', ')}]` : messageText;

    setInput('');
    setAttachments([]);
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: 'user', content: finalText }]);
    setStreaming(true);
    setStreamText('');

    let acc = '';
    await streamMessage(convId, finalText, {
      onToken: (delta) => { acc += delta; setStreamText(acc); },
      onTool: (call) => {
        const label = friendlyToolLabel(call.name);
        window.dispatchEvent(new CustomEvent('sophia:action', {
          detail: { label, time: new Date().toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) },
        }));
        if (call.name === 'schedule_recurring_action' || call.name === 'cancel_recurring_action') setActivityKey((k) => k + 1);
      },
      onDone: async (payload) => {
        const aiMsg = { id: `a-${Date.now()}`, role: 'assistant', content: acc, toolCalls: payload?.toolCalls || [] };
        setMessages((m) => [...m, aiMsg]);
        setStreamText('');
        setStreaming(false);
        loadConversations(query);
        setActivityKey((k) => k + 1);

        // Training: rileva se la risposta può essere utile per l'apprendimento
        if (isTrainingChat && acc.length > 100) {
          setPendingLearning(acc);
        }
      },
      onError: (err) => { setStreaming(false); setStreamText(''); toast.error(err.message || 'Errore durante la risposta'); },
    });
  };

  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast.error('Riconoscimento vocale non supportato');
    const rec = new SR(); rec.lang = 'it-IT'; rec.interimResults = false;
    rec.onresult = (ev) => setInput((v) => `${v} ${ev.results[0][0].transcript}`.trim());
    rec.onerror = () => toast.error('Errore microfono');
    rec.start(); toast.info('In ascolto…');
  };

  const rename = async (conv) => {
    const title = prompt('Nuovo nome', conv.title); if (!title) return;
    await api(`/conversations/${conv.id}`, { method: 'PATCH', body: { title } });
    loadConversations(query); setMenuFor(null);
  };
  const remove = async (conv) => {
    await api(`/conversations/${conv.id}`, { method: 'DELETE' });
    loadConversations(query); setMenuFor(null);
    if (conv.id === id) navigate('/chat');
  };

  const toggleTrainingMode = async () => {
    if (!id) return toast.error('Seleziona prima una conversazione');
    setTrainingLoading(true);
    try {
      if (isTrainingChat) {
        await api(`/training-chat/${id}/stop`, { method: 'POST' });
        setIsTrainingChat(false);
        toast.info('Modalità addestramento disattivata');
      } else {
        await api(`/training-chat/${id}/start`, { method: 'POST' });
        setIsTrainingChat(true);
        setMessages([]);
        toast.info('Modalità addestramento attivata. La chat è stata svuotata.');
      }
    } catch (err) { toast.error(err.message); } finally { setTrainingLoading(false); }
  };

  const applyLearning = async () => {
    try {
      await api(`/training-chat/${id}/apply`, { method: 'POST', body: { learning: pendingLearning, field: 'instructions' } });
      setPendingLearning(null);
      toast.info('Apprendimento applicato al prompt di addestramento!');
    } catch (err) { toast.error(err.message); }
  };

  return (
    <div className="chat-layout">
      {showPhoneModal && (
        <PhoneLinkModal
          onClose={() => setShowPhoneModal(false)}
          onLinked={async (ph) => { setPhoneLinked(true); setWaPhone(ph); setShowPhoneModal(false); await loadPhoneStatus(); }}
        />
      )}

      <aside className="chat-list">
        <button className="btn btn-primary new-chat" onClick={newConversation}><Plus size={16} /> Nuova conversazione</button>
        <div className="chat-search">
          <Search size={15} className="search-icon" />
          <input className="input" placeholder="Cerca chat" value={query} onChange={(e) => { setQuery(e.target.value); loadConversations(e.target.value); }} />
        </div>

        {/* Sezione WA sync */}
        <div style={{ padding: '8px 4px', borderBottom: '1px solid var(--border)', marginBottom: 8 }}>
          {!phoneLinked ? (
            <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'flex-start', gap: 8, fontSize: 12 }}
              onClick={() => setShowPhoneModal(true)}>
              <Phone size={14} /> Collega WhatsApp
            </button>
          ) : !waSyncId ? (
            <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'flex-start', gap: 8, fontSize: 12, color: '#25D366' }}
              onClick={initWaSync}>
              <MessageCircle size={14} /> Apri chat WA sincronizzata
            </button>
          ) : null}
        </div>

        <div className="chat-history">
          {/* Chat WA sincronizzata in cima evidenziata */}
          {waSyncId && conversations.find(c => c.id === waSyncId) && (
            <div className={`chat-item wa-synced ${waSyncId === id ? 'active' : ''}`}>
              <button className="chat-item-main" onClick={() => navigate(`/chat/${waSyncId}`)}>
                <MessageCircle size={14} style={{ color: '#25D366' }} />
                {' '}💬 WhatsApp — {waPhone}
              </button>
            </div>
          )}
          {conversations.filter(c => c.id !== waSyncId).map((c) => (
            <div key={c.id} className={`chat-item ${c.id === id ? 'active' : ''}`}>
              <button className="chat-item-main" onClick={() => navigate(`/chat/${c.id}`)}>{c.title}</button>
              <button className="chat-item-menu" onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}><MoreVertical size={16} /></button>
              {menuFor === c.id && (
                <div className="dropdown">
                  <button onClick={() => rename(c)}><Pencil size={14} /> Rinomina</button>
                  <button className="danger" onClick={() => remove(c)}><Trash2 size={14} /> Elimina</button>
                </div>
              )}
            </div>
          ))}
          {conversations.length === 0 && <p className="empty small">Nessuna conversazione.</p>}
        </div>

        {/* Toggle addestramento nella sidebar — solo admin, solo quando c'è una chat aperta */}
        {isAdmin && id && (
          <div className="sidebar-training-toggle">
            <label className="sidebar-training-label">
              <FlaskConical size={13} />
              <span>Chat di addestramento</span>
              <input
                type="checkbox"
                checked={isTrainingChat}
                onChange={toggleTrainingMode}
                disabled={trainingLoading}
              />
            </label>
            {isTrainingChat && (
              <span className="sidebar-training-badge">attiva</span>
            )}
          </div>
        )}
      </aside>

      <section className="chat-main">
        <div className="chat-messages" ref={scrollRef}>
          {messages.length === 0 && !streaming && (
            <div className="chat-empty">
              <h2>Come posso aiutarti oggi?</h2>
              <p>Fai una domanda, allega un documento o usa la voce.</p>
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} role={m.role} content={m.content} toolCalls={m.toolCalls}
              conversationId={id} toast={toast}
              pendingLearning={m.role === 'assistant' && pendingLearning === m.content ? pendingLearning : null}
              onApplyLearning={applyLearning}
              onDismissLearning={() => setPendingLearning(null)}
            />
          ))}
          {streaming && <Message role="assistant" content={streamText} typing={!streamText} />}
        </div>

        {/* Anteprima allegati */}
        {attachments.length > 0 && (
          <div className="attachments-preview">
            {attachments.map((att, i) => (
              <div key={i} className="attachment-chip">
                <Paperclip size={12} />
                <span>{att.name}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({fmtBytes(att.size)})</span>
                <button onClick={() => removeAttachment(i)}><X size={12} /></button>
              </div>
            ))}
          </div>
        )}

        <div className="composer">
          <div className="composer-box">
            <textarea className="composer-input" placeholder={attachments.length ? 'Aggiungi un messaggio agli allegati (opzionale)…' : 'Scrivi un messaggio…'}
              value={input} rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <div className="composer-actions">
              <label className="icon-btn" title="Allega file">
                <Paperclip size={18} strokeWidth={1.75} />
                <input type="file" hidden onChange={onAttach} accept=".pdf,.docx,.txt,.md,.json,.yaml,.yml,image/*" />
              </label>
              <button className="icon-btn" title="Microfono" onClick={startVoice}><Mic size={18} strokeWidth={1.75} /></button>
              <button className="icon-btn send" title="Invia" onClick={send} disabled={streaming || (!input.trim() && attachments.length === 0)}>
                <Send size={18} strokeWidth={1.75} />
              </button>
            </div>
          </div>
        </div>
      </section>

      <ActivityPanel conversationId={id} refreshKey={activityKey} />
    </div>
  );
}

function friendlyToolLabel(name) {
  const map = { call_endpoint: 'Chiamata API', list_endpoints: 'Elenco endpoint', send_email: 'Invio email', send_whatsapp: 'Invio WhatsApp', schedule_recurring_action: 'Attività programmata', cancel_recurring_action: 'Attività annullata', list_recurring_actions: 'Controllo attività', 'gemini__query_manual': 'Interrogazione manuale Gemini' };
  return map[name] || name.replace(/_/g, ' ');
}

function Message({ role, content, typing, toolCalls, conversationId, toast, pendingLearning, onApplyLearning, onDismissLearning }) {
  const isUser = role === 'user';
  const [scheduled, setScheduled] = useState(false);

  const suggestion = (toolCalls || []).map((t) => t.result?.suggestAction).find((s) => s?.type === 'schedule_retry');

  const scheduleRetry = async () => {
    try {
      await api('/tasks', { method: 'POST', body: { kind: 'RETRY', conversationId, endpointId: suggestion.endpointId, endpointName: suggestion.endpointName, variables: suggestion.variables, delaySeconds: suggestion.delaySeconds } });
      setScheduled(true);
      toast?.info('Riproverò automaticamente in background.');
    } catch (err) { toast?.error(err.message || 'Impossibile impostare il task'); }
  };

  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-ai'}`}>
      <div className="msg-avatar">{isUser ? 'TU' : 'S'}</div>
      <div className="msg-body">
        {typing ? <div className="typing"><span /><span /><span /></div>
          : isUser ? <p className="msg-text">{content}</p>
          : <Markdown content={content} />}
        {suggestion && !scheduled && (
          <div className="msg-action" style={{ marginTop: 8 }}>
            <button className="btn btn-ghost" onClick={scheduleRetry}>{suggestion.message}</button>
          </div>
        )}
        {scheduled && <p className="empty small" style={{ marginTop: 6 }}>✅ Riproverò automaticamente.</p>}
        {/* Suggerimento apprendimento */}
        {pendingLearning && (
          <div className="learning-suggestion">
            <div className="ls-label">💡 Questa risposta potrebbe essere utile per l'addestramento. Applicarla al prompt?</div>
            <div className="ls-actions">
              <button className="btn btn-primary btn-sm" onClick={onApplyLearning}>✓ Applica apprendimento</button>
              <button className="btn btn-ghost btn-sm" onClick={onDismissLearning}>Ignora</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
CHAT_EOF

cat > frontend/src/pages/Modules.jsx << 'MOD_EOF'
import { useEffect, useState } from 'react';
import {
  Power, Settings2, Plus, Trash2, AlertTriangle, Check, Loader2,
  ChevronRight, ChevronLeft, Link, Globe, MessageSquare, Copy, ExternalLink,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';

export default function Modules() {
  const toast = useToast();
  const [modules, setModules] = useState(null);
  const [configFor, setConfigFor] = useState(null);

  const load = () =>
    api('/modules').then(({ modules }) => setModules(modules)).catch(() => setModules([]));
  useEffect(() => { load(); }, []);

  const act = async (key, action) => {
    await api(`/modules/${key}/action`, { method: 'POST', body: { action } });
    load();
    toast.info('Modulo aggiornato');
  };

  if (!modules) return <div className="skeleton" style={{ height: 300 }} />;

  return (
    <div>
      <h1 className="page-title">Moduli</h1>
      <p className="page-subtitle">Estendi le capacità dell'assistente attivando i moduli.</p>

      <div className="module-grid">
        {modules.map((m) => (
          <div key={m.key} className="card module-card">
            <div className="module-head">
              <div>
                <h3 className="module-name">{m.name}</h3>
                <span className={`badge ${m.enabled && m.installed ? 'badge-on' : 'badge-off'}`}>
                  {m.installed ? (m.enabled ? 'Attivo' : 'Disattivato') : 'Non installato'}
                </span>
              </div>
            </div>
            <p className="module-desc">{m.description}</p>
            {m.notice && (
              <div className="notice"><AlertTriangle size={16} /> {m.notice}</div>
            )}
            <div className="module-caps">
              {m.capabilities.map((c) => (
                <span key={c.name} className="cap-chip">{c.name}</span>
              ))}
            </div>
            <div className="module-actions">
              {m.installed ? (
                <>
                  <button className="btn btn-outline" onClick={() => act(m.key, m.enabled ? 'disable' : 'enable')}>
                    <Power size={15} /> {m.enabled ? 'Disattiva' : 'Attiva'}
                  </button>
                  {(m.key === 'email' || m.key === 'whatsapp' || m.key === 'gemini') && m.installed && (
                    <button className="btn btn-ghost" onClick={() => setConfigFor(m)}>
                      <Settings2 size={15} /> Configura
                    </button>
                  )}
                </>
              ) : (
                <button className="btn btn-primary" onClick={() => act(m.key, 'install')}>
                  Installa
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {configFor?.key === 'email' && (
        <EmailConfig module={configFor} onClose={() => { setConfigFor(null); load(); }} />
      )}
      {configFor?.key === 'whatsapp' && (
        <WhatsAppWizard module={configFor} onClose={() => { setConfigFor(null); load(); }} />
      )}
      {configFor?.key === 'gemini' && (
        <GeminiConfig module={configFor} onClose={() => { setConfigFor(null); load(); }} />
      )}
    </div>
  );
}

// ── Modal wrapper ──────────────────────────────────────────────────────────

function Modal({ title, children, onClose, wide }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal card"
        style={wide ? { maxWidth: 640 } : {}}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ── WhatsApp Wizard (3 step) ───────────────────────────────────────────────

function WhatsAppWizard({ module, onClose }) {
  const toast = useToast();
  const [step, setStep] = useState(1);

  // Step 1 state
  const [cfg, setCfg] = useState({
    accessToken: '', phoneNumberId: '', businessAccountId: '',
    templateLanguage: 'it', ...module.config,
  });
  const [saving, setSaving] = useState(false);

  // Step 2 state
  const [checking, setChecking] = useState(false);
  const [templateStatus, setTemplateStatus] = useState(null); // null | 'found' | 'missing'
  const [creating, setCreating] = useState(false);

  // Step 3 state
  const [webhookInfo, setWebhookInfo] = useState(null);
  const [loadingWebhook, setLoadingWebhook] = useState(false);

  const STEPS = [
    { label: 'Credenziali' },
    { label: 'Template' },
    { label: 'Webhook' },
  ];

  // ── Step 1: save credentials ────────────────────────────────────────────
  const saveCredentials = async () => {
    if (!cfg.accessToken || !cfg.phoneNumberId || !cfg.businessAccountId) {
      toast.error('Compila tutti i campi per procedere.');
      return;
    }
    setSaving(true);
    try {
      await api('/modules/whatsapp/config', { method: 'PUT', body: { config: cfg } });
      toast.info('Credenziali salvate');
      setStep(2);
      checkTemplate();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Step 2: check/create template ──────────────────────────────────────
  const checkTemplate = async () => {
    setChecking(true);
    setTemplateStatus(null);
    try {
      const { templateReady } = await api('/modules/whatsapp/setup/templates');
      setTemplateStatus(templateReady ? 'found' : 'missing');
    } catch (err) {
      toast.error(err.message);
      setTemplateStatus('missing');
    } finally {
      setChecking(false);
    }
  };

  const createTemplate = async () => {
    setCreating(true);
    try {
      await api('/modules/whatsapp/setup/templates', {
        method: 'POST',
        body: { language: cfg.templateLanguage },
      });
      toast.info('Template creato — in attesa di approvazione Meta (di solito pochi minuti)');
      setTemplateStatus('pending');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setCreating(false);
    }
  };

  // ── Step 3: webhook ─────────────────────────────────────────────────────
  const loadWebhookInfo = async () => {
    setLoadingWebhook(true);
    try {
      const info = await api('/modules/whatsapp/setup/webhook-info');
      setWebhookInfo(info);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoadingWebhook(false);
    }
  };

  const goToStep3 = () => {
    setStep(3);
    loadWebhookInfo();
  };

  const copyText = (text) => {
    navigator.clipboard.writeText(text).then(() => toast.info('Copiato!'));
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <Modal title="Configurazione WhatsApp" onClose={onClose} wide>
      {/* Step indicators */}
      <div className="wa-steps">
        {STEPS.map((s, i) => (
          <div key={i} className={`wa-step ${step === i + 1 ? 'active' : ''} ${step > i + 1 ? 'done' : ''}`}>
            <div className="wa-step-dot">
              {step > i + 1 ? <Check size={13} /> : i + 1}
            </div>
            <span>{s.label}</span>
            {i < STEPS.length - 1 && <div className="wa-step-line" />}
          </div>
        ))}
      </div>

      {/* ── Step 1: Credenziali ── */}
      {step === 1 && (
        <div>
          <p className="wa-step-desc">
            Inserisci le credenziali della tua app WhatsApp Business (Meta Cloud API).
          </p>
          <Input
            label="Access Token"
            type="password"
            value={cfg.accessToken}
            onChange={(v) => setCfg({ ...cfg, accessToken: v })}
            hint="Token di sistema o permanente dall'App Dashboard di Meta"
          />
          <Input
            label="Phone Number ID"
            value={cfg.phoneNumberId}
            onChange={(v) => setCfg({ ...cfg, phoneNumberId: v })}
            hint="ID del numero di telefono WhatsApp (non il numero in sé)"
          />
          <Input
            label="Business Account ID (WABA ID)"
            value={cfg.businessAccountId}
            onChange={(v) => setCfg({ ...cfg, businessAccountId: v })}
            hint="ID dell'account WhatsApp Business (WABA)"
          />
          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
            <button className="btn btn-primary" onClick={saveCredentials} disabled={saving}>
              {saving ? <Loader2 size={15} className="spin" /> : <ChevronRight size={15} />}
              {saving ? 'Salvataggio…' : 'Avanti'}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Template ── */}
      {step === 2 && (
        <div>
          <p className="wa-step-desc">
            WhatsApp richiede un template approvato per avviare nuove conversazioni.
            Verifichiamo l'esistenza del template <code>conversation_continue</code>.
          </p>

          {checking && (
            <div className="wa-status-box">
              <Loader2 size={18} className="spin" />
              <span>Verifica template in corso…</span>
            </div>
          )}

          {!checking && templateStatus === 'found' && (
            <div className="wa-status-box success">
              <Check size={18} />
              <span>Template <strong>conversation_continue</strong> trovato e approvato. Puoi procedere.</span>
            </div>
          )}

          {!checking && templateStatus === 'pending' && (
            <div className="wa-status-box warning">
              <AlertTriangle size={18} />
              <span>
                Template inviato a Meta per approvazione. Di solito viene approvato in pochi minuti.
                Torna qui per verificare o procedi al passo successivo.
              </span>
            </div>
          )}

          {!checking && templateStatus === 'missing' && (
            <div>
              <div className="wa-status-box warning">
                <AlertTriangle size={18} />
                <span>Template non trovato. Lo creiamo adesso.</span>
              </div>

              <div className="field" style={{ marginTop: 16 }}>
                <label>Lingua del template</label>
                <select
                  className="input"
                  value={cfg.templateLanguage}
                  onChange={(e) => setCfg({ ...cfg, templateLanguage: e.target.value })}
                >
                  <option value="it">Italiano</option>
                  <option value="en">English</option>
                </select>
              </div>

              <div className="wa-template-preview">
                <div className="wa-bubble-header">
                  {cfg.templateLanguage === 'it' ? 'Benvenuto in Sophia' : 'Welcome to Sophia'}
                </div>
                <div className="wa-bubble-body">
                  {cfg.templateLanguage === 'it'
                    ? 'Ciao! Hai una notifica in attesa. Premi il pulsante qui sotto per riceverla e continuare la conversazione su WhatsApp.'
                    : 'Hi! You have a pending notification. Press the button below to receive it and continue the conversation on WhatsApp.'}
                </div>
                <button className="wa-bubble-btn" disabled>
                  {cfg.templateLanguage === 'it' ? '✓ Continua' : '✓ Continue'}
                </button>
              </div>

              <button className="btn btn-primary" onClick={createTemplate} disabled={creating} style={{ marginTop: 12 }}>
                {creating ? <Loader2 size={15} className="spin" /> : <MessageSquare size={15} />}
                {creating ? 'Creazione in corso…' : 'Crea template'}
              </button>
            </div>
          )}

          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={() => setStep(1)}>
              <ChevronLeft size={15} /> Indietro
            </button>
            {templateStatus === 'found' || templateStatus === 'pending' ? (
              <button className="btn btn-primary" onClick={goToStep3}>
                <ChevronRight size={15} /> Avanti
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={goToStep3}>
                Salta →
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Step 3: Webhook ── */}
      {step === 3 && (
        <div>
          <p className="wa-step-desc">
            Configura il webhook su Meta per ricevere i messaggi in arrivo.
            Copia i valori qui sotto e incollali nella sezione <strong>WhatsApp → Configurazione</strong> del tuo App Dashboard Meta.
          </p>

          {loadingWebhook && (
            <div className="wa-status-box">
              <Loader2 size={18} className="spin" />
              <span>Generazione URL webhook…</span>
            </div>
          )}

          {webhookInfo && (
            <div>
              <div className="wa-webhook-field">
                <label><Globe size={14} /> URL callback</label>
                <div className="wa-webhook-value">
                  <code>{webhookInfo.webhookUrl}</code>
                  <button className="btn btn-ghost btn-sm" onClick={() => copyText(webhookInfo.webhookUrl)}>
                    <Copy size={14} /> Copia
                  </button>
                </div>
              </div>

              <div className="wa-webhook-field">
                <label><Link size={14} /> Token di verifica</label>
                <div className="wa-webhook-value">
                  <code>{webhookInfo.verifyToken}</code>
                  <button className="btn btn-ghost btn-sm" onClick={() => copyText(webhookInfo.verifyToken)}>
                    <Copy size={14} /> Copia
                  </button>
                </div>
              </div>

              <div className="wa-info-box">
                <strong>Come configurare in Meta:</strong>
                <ol style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.8 }}>
                  <li>Apri <a href="https://developers.facebook.com" target="_blank" rel="noreferrer">Meta for Developers <ExternalLink size={12} /></a> → la tua app</li>
                  <li>Vai su <strong>WhatsApp → Configurazione</strong></li>
                  <li>Clicca <strong>Modifica</strong> accanto a "Webhook"</li>
                  <li>Incolla l'URL callback e il token di verifica</li>
                  <li>Clicca <strong>Verifica e salva</strong></li>
                  <li>Iscriviti al campo <strong>messages</strong></li>
                </ol>
              </div>
            </div>
          )}

          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={() => setStep(2)}>
              <ChevronLeft size={15} /> Indietro
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              <Check size={15} /> Chiudi
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Email Config ──────────────────────────────────────────────────────────

function EmailConfig({ module, onClose }) {
  const toast = useToast();
  const [smtps, setSmtps] = useState(module.config?.smtps || []);

  const add = () => setSmtps([...smtps, {
    name: '', host: '', port: 587, secure: false, username: '', password: '', fromEmail: '', fromName: '',
  }]);
  const update = (i, patch) => setSmtps(smtps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const removeAt = (i) => setSmtps(smtps.filter((_, idx) => idx !== i));

  const save = async () => {
    try {
      await api('/modules/email/config', { method: 'PUT', body: { config: { smtps } } });
      toast.info('Configurazione email salvata');
      onClose();
    } catch (err) { toast.error(err.message); }
  };

  return (
    <Modal title="Configurazione Email (SMTP)" onClose={onClose}>
      <p className="page-subtitle" style={{ marginBottom: 16 }}>
        Aggiungi un numero illimitato di server. L'assistente sceglie automaticamente quale usare.
      </p>
      {smtps.map((s, i) => (
        <div key={i} className="smtp-row card">
          <div className="smtp-grid">
            <Input label="Nome" value={s.name} onChange={(v) => update(i, { name: v })} />
            <Input label="Host" value={s.host} onChange={(v) => update(i, { host: v })} />
            <Input label="Porta" type="number" value={s.port} onChange={(v) => update(i, { port: Number(v) })} />
            <Input label="Username" value={s.username} onChange={(v) => update(i, { username: v })} />
            <Input label="Password" type="password" value={s.password} onChange={(v) => update(i, { password: v })} />
            <Input label="Email mittente" value={s.fromEmail} onChange={(v) => update(i, { fromEmail: v })} />
            <Input label="Nome mittente" value={s.fromName} onChange={(v) => update(i, { fromName: v })} />
            <label className="checkbox">
              <input type="checkbox" checked={s.secure} onChange={(e) => update(i, { secure: e.target.checked })} />
              SSL/TLS
            </label>
          </div>
          <button className="btn btn-danger" onClick={() => removeAt(i)}><Trash2 size={14} /> Rimuovi</button>
        </div>
      ))}
      <button className="btn btn-outline" onClick={add}><Plus size={15} /> Aggiungi server</button>
      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
        <button className="btn btn-primary" onClick={save}>Salva</button>
      </div>
    </Modal>
  );
}

// ── Input helper ─────────────────────────────────────────────────────────

function Input({ label, value, onChange, type = 'text', hint }) {
  return (
    <div className="field" style={{ marginBottom: 14 }}>
      <label>{label}</label>
      <input
        className="input"
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

// ── Gemini Config ─────────────────────────────────────────────────────────

function GeminiConfig({ module, onClose }) {
  const toast = useToast();
  const [apiKey, setApiKey] = useState('');
  const [geminiModel, setGeminiModel] = useState('gemini-2.5-flash');
  const [saving, setSaving] = useState(false);
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    api('/gemini/config').then((data) => {
      setHasKey(data.hasKey);
      setGeminiModel(data.model || 'gemini-2.5-flash');
    }).catch(() => {});
  }, []);

  const save = async () => {
    if (!apiKey && !hasKey) return toast.error('Inserisci una API key');
    if (!apiKey && hasKey) { onClose(); return; }
    setSaving(true);
    try {
      await api('/gemini/config', { method: 'PUT', body: { apiKey, model: geminiModel } });
      toast.info('Configurazione Gemini salvata');
      onClose();
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  return (
    <Modal title="Configura Gemini AI" onClose={onClose}>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
        La API key di Google Gemini viene salvata nel database in modo sicuro e non nel file .env.
        Ogni tenant ha la propria chiave.
      </p>
      {hasKey && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 13 }}>
          ✅ API key già configurata. Inserisci una nuova chiave solo se vuoi cambiarla.
        </div>
      )}
      <Input label="API Key Google Gemini" value={apiKey} onChange={setApiKey} type="password"
        hint="Ottenila da https://aistudio.google.com/apikey" />
      <Input label="Modello Gemini" value={geminiModel} onChange={setGeminiModel}
        hint="Es. gemini-2.5-flash, gemini-1.5-pro" />
      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Salvataggio…' : 'Salva'}</button>
      </div>
    </Modal>
  );
}
MOD_EOF

cat > frontend/src/pages/Training.jsx << 'TRAIN_EOF'
import { useEffect, useRef, useState } from 'react';
import { Save, Upload, Trash2, FileText, Loader2, Search } from 'lucide-react';
import { api, upload } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const FIELDS = [
  { key: 'mainPrompt', label: 'Prompt principale', hint: 'Il ruolo e lo scopo dell\'assistente.' },
  { key: 'personality', label: 'Personalità AI', hint: 'Tono e stile delle risposte.' },
  { key: 'rules', label: 'Regole', hint: 'Vincoli da rispettare sempre.' },
  { key: 'context', label: 'Contesto', hint: 'Informazioni di base sull\'azienda o sul dominio.' },
  { key: 'instructions', label: 'Istruzioni permanenti', hint: 'Indicazioni sempre attive.' },
];

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default function Training() {
  const toast = useToast();
  const { user } = useAuth();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  // Gemini module
  const [geminiEnabled, setGeminiEnabled] = useState(false);
  const [trainingDocs, setTrainingDocs] = useState([]);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [geminiQuery, setGeminiQuery] = useState('');
  const [geminiLoading, setGeminiLoading] = useState(false);
  const [geminiAnswer, setGeminiAnswer] = useState(null);
  const [selectedDoc, setSelectedDoc] = useState('');
  const fileRef = useRef();

  useEffect(() => {
    api('/training').then(({ training }) => setForm(training)).catch(() => setForm({ mainPrompt: '', personality: '', rules: '', context: '', instructions: '' }));
    // Controlla se Gemini è attivo
    api('/modules').then(({ modules }) => {
      const gem = modules.find(m => m.key === 'gemini');
      setGeminiEnabled(!!(gem?.enabled && gem?.installed));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!geminiEnabled) return;
    api('/training-docs').then(({ documents }) => setTrainingDocs(documents)).catch(() => {});
  }, [geminiEnabled]);

  const save = async () => {
    setSaving(true);
    try {
      const { mainPrompt, personality, rules, context, instructions } = form;
      await api('/training', { method: 'PUT', body: { mainPrompt, personality, rules, context, instructions } });
      toast.info('Impostazioni salvate');
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  const uploadDoc = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingDoc(true);
    try {
      const { document } = await upload('/training-docs', file);
      setTrainingDocs(d => [document, ...d]);
      toast.info(`"${file.name}" caricato`);
    } catch (err) { toast.error(err.message); } finally { setUploadingDoc(false); e.target.value = ''; }
  };

  const deleteDoc = async (id) => {
    try {
      await api(`/training-docs/${id}`, { method: 'DELETE' });
      setTrainingDocs(d => d.filter(doc => doc.id !== id));
      if (selectedDoc === id) setSelectedDoc('');
      toast.info('Documento eliminato');
    } catch (err) { toast.error(err.message); }
  };

  const askGemini = async () => {
    if (!geminiQuery.trim()) return;
    setGeminiLoading(true);
    setGeminiAnswer(null);
    try {
      const { answer } = await api('/gemini/query', {
        method: 'POST',
        body: { question: geminiQuery, documentId: selectedDoc || undefined },
      });
      setGeminiAnswer(answer);
    } catch (err) { toast.error(err.message); } finally { setGeminiLoading(false); }
  };

  if (!form) return <div className="skeleton" style={{ height: 400 }} />;

  return (
    <div className="narrow">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">Addestramento</h1>
          <p className="page-subtitle">Queste impostazioni guidano sempre il comportamento dell'assistente.</p>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          <Save size={16} /> {saving ? 'Salvataggio…' : 'Salva'}
        </button>
      </div>

      <div className="card panel">
        {FIELDS.map((f) => (
          <div className="field" key={f.key}>
            <label>{f.label}</label>
            <span className="field-hint">{f.hint}</span>
            <textarea className="input" value={form[f.key] || ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
          </div>
        ))}
      </div>

      {/* Sezione Manuali Gemini — visibile solo se modulo attivo */}
      {geminiEnabled && (
        <div className="card panel" style={{ marginTop: 24 }}>
          <h2 className="panel-title" style={{ marginBottom: 4 }}>📚 Manuali e documenti</h2>
          <p className="page-subtitle">Carica manuali tecnici che l'AI interrogherà tramite Google Gemini.</p>

          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <label className={`btn btn-outline ${uploadingDoc ? 'disabled' : ''}`} style={{ cursor: 'pointer' }}>
              {uploadingDoc ? <><Loader2 size={15} className="spin" /> Caricamento…</> : <><Upload size={15} /> Carica documento</>}
              <input ref={fileRef} type="file" hidden accept=".pdf,.docx,.txt,.md" onChange={uploadDoc} disabled={uploadingDoc} />
            </label>
          </div>

          <div className="training-docs-list">
            {trainingDocs.length === 0 && <p className="empty small">Nessun documento caricato.</p>}
            {trainingDocs.map((doc) => (
              <div key={doc.id} className="training-doc-item">
                <FileText size={16} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                <span className="training-doc-name">{doc.filename}</span>
                <span className="training-doc-size">{fmtBytes(doc.sizeBytes)}</span>
                <button className="btn btn-danger icon-btn" onClick={() => deleteDoc(doc.id)} title="Elimina"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>

          {/* Test interrogazione Gemini */}
          {trainingDocs.length > 0 && (
            <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 20 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>🔍 Testa un'interrogazione Gemini</h3>

              <div className="field" style={{ marginBottom: 10 }}>
                <label>Documento (opzionale — usa il più recente se non selezionato)</label>
                <select className="input" value={selectedDoc} onChange={e => setSelectedDoc(e.target.value)}>
                  <option value="">— Usa il più recente —</option>
                  {trainingDocs.map(d => <option key={d.id} value={d.id}>{d.filename}</option>)}
                </select>
              </div>

              <div className="field">
                <label>Domanda</label>
                <textarea className="input" rows={3} value={geminiQuery} onChange={e => setGeminiQuery(e.target.value)}
                  placeholder="Es. Qual è la procedura per…" />
              </div>

              <button className="btn btn-primary" onClick={askGemini} disabled={geminiLoading || !geminiQuery.trim()}>
                {geminiLoading ? <><Loader2 size={15} className="spin" /> Gemini sta elaborando…</> : <><Search size={15} /> Interroga Gemini</>}
              </button>

              {geminiLoading && (
                <div className="gemini-loading">
                  <div className="gemini-spinner" />
                  <p>Gemini sta analizzando il documento.<br />Potrebbe richiedere fino a qualche minuto…</p>
                </div>
              )}

              {geminiAnswer && !geminiLoading && (
                <div className="card" style={{ marginTop: 16, padding: 16, background: '#f0fdf4', border: '1px solid #86efac' }}>
                  <p style={{ fontWeight: 600, marginBottom: 8, color: '#166534' }}>Risposta Gemini:</p>
                  <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14 }}>{geminiAnswer}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!geminiEnabled && (
        <div className="card panel" style={{ marginTop: 16, opacity: 0.6 }}>
          <p style={{ fontSize: 14 }}>📚 <strong>Caricamento manuali</strong> — Disponibile attivando il modulo <strong>Gemini AI</strong> nella sezione Moduli.</p>
        </div>
      )}
    </div>
  );
}
TRAIN_EOF

cat > frontend/src/styles/app.css << 'CSS_EOF'
/* ─── Brand ─── */
.brand-mark {
  display: inline-grid; place-items: center;
  width: 30px; height: 30px;
  background: var(--primary); color: #fff;
  border-radius: 8px; font-weight: 700; font-size: 16px;
}
.brand-name { font-weight: 600; font-size: 17px; letter-spacing: -0.02em; }

/* ─── Login ─── */
.login-screen {
  min-height: 100vh; display: grid; place-items: center;
  background: radial-gradient(1200px 600px at 50% -10%, var(--blue-50), var(--bg));
  padding: 24px;
}
.login-card { width: 100%; max-width: 400px; padding: 36px 32px; }
.login-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
.login-title { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.login-sub { color: var(--text-muted); margin: 6px 0 24px; }
.login-foot { margin-top: 20px; color: var(--gray-400); font-size: 12px; }

/* ─── Shell ─── */
.shell { display: flex; height: 100vh; overflow: hidden; }
.sidebar {
  width: var(--sidebar-w); flex-shrink: 0;
  background: var(--surface); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; padding: 16px 12px;
}
.sidebar-brand { display: flex; align-items: center; gap: 10px; padding: 8px 8px 20px; }
.sidebar-nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.sidebar-foot { border-top: 1px solid var(--border); padding-top: 8px; }
.nav-item {
  display: flex; align-items: center; gap: 11px;
  padding: 9px 12px; border-radius: var(--radius-sm);
  color: var(--gray-600); font-weight: 500; font-size: 14px;
  transition: background 0.12s ease, color 0.12s ease;
}
.nav-item:hover { background: var(--gray-100); color: var(--gray-900); }
.nav-item.active { background: var(--blue-50); color: var(--primary); }

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.topbar {
  height: 60px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 24px; border-bottom: 1px solid var(--border); background: var(--surface);
}
.topbar-user { display: flex; align-items: center; gap: 12px; }
.avatar {
  width: 34px; height: 34px; border-radius: 8px;
  background: var(--gray-800); color: #fff;
  display: grid; place-items: center; font-size: 12px; font-weight: 600;
}
.user-meta { line-height: 1.3; }
.user-name { font-weight: 600; font-size: 13px; }
.user-email { color: var(--text-muted); font-size: 12px; }
.icon-btn { display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: var(--radius-sm); color: var(--gray-500); }
.icon-btn:hover { background: var(--gray-100); color: var(--gray-800); }

.role-pill { font-size: 11px; font-weight: 600; padding: 4px 9px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.03em; }
.role-super_admin { background: #ede9fe; color: #6d28d9; }
.role-admin { background: var(--blue-50); color: var(--blue-700); }
.role-member { background: var(--gray-100); color: var(--gray-600); }

.content { flex: 1; overflow-y: auto; padding: 28px 32px; }
.narrow { max-width: 720px; }

/* ─── Headings / panels ─── */
.page-head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.head-actions { display: flex; gap: 10px; }
.panel { padding: 20px; margin-bottom: 20px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.panel-title { font-size: 15px; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; }
.panel-link { color: var(--primary); font-size: 13px; font-weight: 500; }
.section-label { display: block; font-size: 13px; font-weight: 600; color: var(--gray-700); margin: 18px 0 10px; }
.field-hint { font-size: 12px; color: var(--text-muted); margin-top: -2px; }
.empty { color: var(--text-muted); padding: 18px 0; text-align: center; }
.empty.small { font-size: 13px; padding: 12px; }

/* ─── Dashboard ─── */
.stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; margin: 20px 0; }
.stat-card { padding: 18px; }
.stat-icon { display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: var(--blue-50); color: var(--primary); margin-bottom: 14px; }
.stat-value { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
.stat-label { color: var(--text-muted); font-size: 13px; margin-top: 2px; }
.dash-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.list-row { display: flex; align-items: center; gap: 10px; padding: 9px 8px; border-radius: var(--radius-sm); }
.list-row:hover { background: var(--gray-50); }
.list-icon { color: var(--gray-400); flex-shrink: 0; }
.list-main { flex: 1; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-meta { color: var(--text-muted); font-size: 12px; }

/* ─── Tables ─── */
.table-card { overflow: hidden; }
.data-table { width: 100%; border-collapse: collapse; }
.data-table th {
  text-align: left; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
  color: var(--text-muted); padding: 13px 18px; border-bottom: 1px solid var(--border); background: var(--gray-50);
}
.data-table td { padding: 13px 18px; border-bottom: 1px solid var(--border); font-size: 14px; }
.data-table tr:last-child td { border-bottom: none; }
.cell-strong { display: inline-flex; align-items: center; gap: 8px; font-weight: 500; }
.cell-strong svg { color: var(--gray-400); }
.cell-sub { color: var(--text-muted); font-size: 12px; margin-top: 2px; }
.row-actions { display: flex; gap: 4px; justify-content: flex-end; }
.btn-sm { padding: 5px 11px; font-size: 13px; }
.url-cell { font-family: var(--mono); font-size: 12px; color: var(--gray-600); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.method { font-family: var(--mono); font-size: 11px; font-weight: 700; padding: 3px 7px; border-radius: 5px; }
.method-get { background: #ecfdf5; color: #047857; }
.method-post { background: var(--blue-50); color: var(--blue-700); }
.method-put, .method-patch { background: #fffbeb; color: #b45309; }
.method-delete { background: #fef2f2; color: #b91c1c; }

.inline-create { display: flex; gap: 10px; }
.inline-create .input { flex: 1; }

/* ─── Modules ─── */
.module-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 18px; margin-top: 20px; }
.module-card { padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.module-name { font-size: 16px; font-weight: 600; margin: 0 0 6px; }
.module-desc { color: var(--text-muted); font-size: 13px; flex: 1; margin: 0; }
.module-caps { display: flex; flex-wrap: wrap; gap: 6px; }
.cap-chip { font-family: var(--mono); font-size: 11px; padding: 3px 8px; border-radius: 5px; background: var(--gray-100); color: var(--gray-600); }
.module-actions { display: flex; gap: 8px; margin-top: 4px; }

/* ─── Modal ─── */
.modal-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.4); display: grid; place-items: center; z-index: 50; padding: 24px; }
.modal { width: 100%; max-width: 540px; max-height: 86vh; overflow-y: auto; padding: 26px; }
.modal-title { font-size: 18px; font-weight: 600; margin: 0 0 20px; display: flex; align-items: center; gap: 8px; }
.modal-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
.row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.checkbox { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--gray-700); }
.smtp-row { padding: 16px; margin-bottom: 12px; }
.smtp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }

/* ─── API keys ─── */
.apikey-form { display: flex; gap: 10px; }
.apikey-form .input { flex: 1; }
.secret-banner { display: flex; align-items: center; gap: 16px; background: var(--blue-50); border-color: var(--blue-100); }
.secret-code { display: block; font-family: var(--mono); font-size: 13px; margin-top: 6px; word-break: break-all; }

/* ─── Chat ─── */
.chat-layout { display: flex; height: calc(100vh - 60px); margin: -28px -32px; }
.chat-list { width: 280px; flex-shrink: 0; border-right: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; padding: 16px 12px; }
.new-chat { justify-content: center; margin-bottom: 14px; }
.chat-search { position: relative; margin-bottom: 12px; }
.chat-search .input { padding-left: 34px; }
.search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--gray-400); }
.chat-history { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.chat-item { position: relative; display: flex; align-items: center; border-radius: var(--radius-sm); }
.chat-item:hover { background: var(--gray-100); }
.chat-item.active { background: var(--blue-50); }
.chat-item-main { flex: 1; text-align: left; padding: 9px 10px; font-size: 13.5px; color: var(--gray-700); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-item.active .chat-item-main { color: var(--primary); font-weight: 500; }
.chat-item-menu { padding: 6px; color: var(--gray-400); border-radius: 6px; }
.chat-item-menu:hover { color: var(--gray-700); }
.dropdown { position: absolute; right: 6px; top: 36px; z-index: 10; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: var(--shadow); padding: 4px; min-width: 150px; }
.dropdown button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border-radius: 6px; font-size: 13px; color: var(--gray-700); }
.dropdown button:hover { background: var(--gray-100); }
.dropdown button.danger { color: var(--red-600); }

.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.chat-messages { flex: 1; overflow-y: auto; padding: 28px 0; }
.chat-empty { text-align: center; margin-top: 14vh; color: var(--gray-500); }
.chat-empty h2 { font-size: 22px; color: var(--gray-800); font-weight: 600; }
.msg { display: flex; gap: 14px; padding: 14px 32px; max-width: 820px; margin: 0 auto; width: 100%; }
.msg-avatar { width: 30px; height: 30px; flex-shrink: 0; border-radius: 7px; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
.msg-user .msg-avatar { background: var(--gray-800); color: #fff; }
.msg-ai .msg-avatar { background: var(--primary); color: #fff; }
.msg-body { flex: 1; min-width: 0; padding-top: 3px; }
.msg-text { margin: 0; white-space: pre-wrap; line-height: 1.65; }
.typing { display: flex; gap: 4px; padding: 6px 0; }
.typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--gray-300); animation: bounce 1.2s infinite; }
.typing span:nth-child(2) { animation-delay: 0.15s; }
.typing span:nth-child(3) { animation-delay: 0.3s; }
@keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-5px); opacity: 1; } }

.composer { padding: 16px 32px 24px; }
.composer-box { max-width: 820px; margin: 0 auto; display: flex; align-items: flex-end; gap: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 8px 8px 8px 16px; box-shadow: var(--shadow-sm); }
.composer-box:focus-within { border-color: var(--blue-500); box-shadow: 0 0 0 3px var(--blue-100); }
.composer-input { flex: 1; border: none; outline: none; resize: none; background: transparent; padding: 8px 0; max-height: 160px; line-height: 1.6; }
.composer-actions { display: flex; align-items: center; gap: 2px; }
.composer-actions .icon-btn { width: 38px; height: 38px; }
.composer-actions .send { background: var(--primary); color: #fff; }
.composer-actions .send:hover { background: var(--primary-hover); }
.composer-actions .send:disabled { background: var(--gray-300); cursor: not-allowed; }

/* ─── Markdown ─── */
.markdown { line-height: 1.7; }
.markdown p { margin: 0 0 12px; }
.markdown h1, .markdown h2, .markdown h3 { margin: 18px 0 10px; font-weight: 600; }
.markdown ul, .markdown ol { margin: 0 0 12px; padding-left: 22px; }
.markdown li { margin: 4px 0; }
.markdown :not(pre) > code { font-family: var(--mono); font-size: 0.88em; background: var(--gray-100); padding: 2px 6px; border-radius: 5px; color: var(--blue-700); }
.markdown a { color: var(--primary); text-decoration: underline; }
.code-block { margin: 12px 0; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.code-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: var(--gray-50); border-bottom: 1px solid var(--border); }
.code-lang { font-family: var(--mono); font-size: 11px; color: var(--gray-500); text-transform: uppercase; }
.code-copy { font-size: 12px; color: var(--gray-500); padding: 3px 8px; border-radius: 5px; }
.code-copy:hover { background: var(--gray-200); color: var(--gray-800); }
.code-block pre { margin: 0; padding: 14px 16px; overflow-x: auto; }
.code-block code { font-family: var(--mono); font-size: 13px; line-height: 1.6; }

/* ─── Embed ─── */
.embed-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.feature-toggles { display: flex; flex-direction: column; gap: 4px; }
.toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; }
.snippet-box { background: var(--gray-900); color: #e2e8f0; padding: 14px; border-radius: var(--radius-sm); font-family: var(--mono); font-size: 12px; overflow-x: auto; margin: 12px 0; }
.widget-preview { margin-top: 20px; display: flex; justify-content: flex-end; }
.widget-bubble { width: 240px; border-radius: 14px; overflow: hidden; box-shadow: var(--shadow); }
.widget-header { color: #fff; padding: 12px 14px; font-weight: 600; font-size: 14px; }
.widget-body { background: var(--surface); padding: 14px; min-height: 90px; }
.widget-msg { background: var(--gray-100); padding: 9px 12px; border-radius: 10px; font-size: 13px; display: inline-block; }
.widget-input { background: var(--surface); border-top: 1px solid var(--border); padding: 12px 14px; color: var(--gray-400); font-size: 13px; }

.info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
.info-row:last-child { border-bottom: none; }
.info-row span { color: var(--text-muted); }

/* ─── Responsive ─── */
@media (max-width: 980px) {
  .dash-cols, .embed-cols, .row-2, .smtp-grid { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .sidebar { width: 64px; }
  .sidebar .brand-name, .nav-item span { display: none; }
  .chat-list { display: none; }
  .content { padding: 20px; }
}

/* ─── Topbar: selettore azienda ─── */
.topbar-left { display: flex; align-items: center; }
.tenant-switch { display: flex; align-items: center; gap: 8px; background: var(--gray-50); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 10px; }
.tenant-switch .ts-icon { color: var(--gray-400); flex-shrink: 0; }
.tenant-switch .ts-select { border: none; background: transparent; font-weight: 500; color: var(--gray-800); font-size: 14px; outline: none; cursor: pointer; padding-right: 4px; max-width: 220px; }
.tenant-switch .ts-check { color: var(--green-600); }
.tenant-switch.empty { color: var(--primary); font-weight: 500; font-size: 14px; cursor: pointer; }
.tenant-switch.empty:hover { background: var(--blue-50); border-color: var(--blue-100); }

/* ─── Barra di creazione ─── */
.create-bar { display: flex; gap: 12px; padding: 12px; margin-bottom: 24px; align-items: center; }
.create-bar-field { flex: 1; display: flex; align-items: center; gap: 10px; padding: 0 12px; }
.create-bar-icon { color: var(--gray-400); flex-shrink: 0; }
.create-bar-input { flex: 1; border: none; outline: none; background: transparent; font-size: 15px; padding: 10px 0; }

/* ─── Stato vuoto ─── */
.empty-state { padding: 48px 24px; text-align: center; }
.empty-state .empty-icon { display: inline-grid; place-items: center; width: 56px; height: 56px; border-radius: 14px; background: var(--blue-50); color: var(--primary); margin-bottom: 16px; }
.empty-state h3 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
.empty-state p { color: var(--text-muted); margin: 0; max-width: 360px; margin-inline: auto; }

/* ─── Griglia aziende ─── */
.tenant-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
.tenant-card { padding: 20px; display: flex; flex-direction: column; gap: 16px; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.tenant-card.active { border-color: var(--blue-500); box-shadow: 0 0 0 3px var(--blue-100); }
.tenant-card-head { display: flex; align-items: center; gap: 12px; }
.tenant-avatar { width: 42px; height: 42px; border-radius: 10px; background: var(--primary); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 15px; flex-shrink: 0; }
.tenant-info { flex: 1; min-width: 0; }
.tenant-name { font-weight: 600; font-size: 15px; }
.tenant-slug { color: var(--text-muted); font-size: 12px; font-family: var(--mono); }
.tenant-metrics { display: flex; gap: 18px; color: var(--gray-600); font-size: 13px; }
.tenant-metrics span { display: inline-flex; align-items: center; gap: 6px; }
.tenant-metrics svg { color: var(--gray-400); }
.tenant-card-foot { display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--border); padding-top: 14px; }
.active-tag { display: inline-flex; align-items: center; gap: 6px; color: var(--green-600); font-weight: 500; font-size: 13px; }

/* ─── API key ─── */
.secret-banner { display: flex; align-items: center; gap: 14px; padding: 16px 18px; margin-bottom: 20px; background: var(--blue-50); border-color: var(--blue-100); }
.secret-icon { color: var(--primary); flex-shrink: 0; }
.secret-body { flex: 1; min-width: 0; }
.secret-code { display: block; font-family: var(--mono); font-size: 13px; margin-top: 6px; word-break: break-all; color: var(--gray-800); }
.key-prefix { font-family: var(--mono); font-size: 12px; background: var(--gray-100); padding: 2px 7px; border-radius: 5px; color: var(--gray-700); }

/* ─── WhatsApp Wizard ─── */
.wa-steps {
  display: flex; align-items: center; gap: 0;
  margin-bottom: 24px; padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.wa-step {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 500; color: var(--gray-400);
  flex-shrink: 0;
}
.wa-step.active { color: var(--primary); }
.wa-step.done { color: var(--gray-500); }
.wa-step-dot {
  width: 26px; height: 26px; border-radius: 50%;
  display: grid; place-items: center; font-size: 12px; font-weight: 700;
  background: var(--gray-100); color: var(--gray-400); flex-shrink: 0;
}
.wa-step.active .wa-step-dot { background: var(--primary); color: #fff; }
.wa-step.done .wa-step-dot { background: #ecfdf5; color: #047857; }
.wa-step-line {
  flex: 1; height: 1px; background: var(--border);
  margin: 0 12px; min-width: 32px;
}
.wa-step-desc { color: var(--text-muted); font-size: 14px; margin: 0 0 20px; line-height: 1.6; }
.wa-status-box {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; border-radius: var(--radius-sm);
  background: var(--gray-50); border: 1px solid var(--border);
  font-size: 14px; margin-bottom: 16px;
}
.wa-status-box.success { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
.wa-status-box.warning { background: #fffbeb; border-color: #fde68a; color: #b45309; }
.wa-template-preview {
  border: 1px solid var(--border); border-radius: 12px;
  overflow: hidden; max-width: 320px; margin: 16px 0;
  background: #e8f0fe;
}
.wa-bubble-header {
  background: #128c7e; color: #fff; padding: 10px 14px;
  font-weight: 600; font-size: 14px;
}
.wa-bubble-body {
  padding: 12px 14px; font-size: 13px; color: var(--gray-800); line-height: 1.55;
  background: #fff;
}
.wa-bubble-btn {
  display: block; width: 100%; padding: 10px;
  border-top: 1px solid var(--border); background: #fff;
  color: #128c7e; font-weight: 600; font-size: 13px; text-align: center;
  cursor: default;
}
.wa-webhook-field { margin-bottom: 16px; }
.wa-webhook-field label {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 600; color: var(--gray-600);
  text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px;
}
.wa-webhook-value {
  display: flex; align-items: center; gap: 8px;
  background: var(--gray-50); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 10px 12px;
}
.wa-webhook-value code {
  flex: 1; font-family: var(--mono); font-size: 12px;
  color: var(--gray-700); word-break: break-all;
}
.wa-info-box {
  background: var(--blue-50); border: 1px solid var(--blue-100);
  border-radius: var(--radius-sm); padding: 14px 16px;
  font-size: 13px; color: var(--gray-700); margin-top: 16px;
}
.wa-info-box a { color: var(--primary); }
.notice {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 10px 14px; border-radius: var(--radius-sm);
  background: #fffbeb; border: 1px solid #fde68a;
  color: #92400e; font-size: 13px; line-height: 1.5;
}

/* ─── Endpoints improvements ─── */
.import-banner {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; margin-bottom: 16px;
  background: var(--blue-50); border: 1px solid var(--blue-100);
  border-radius: var(--radius-sm); font-size: 14px; color: var(--blue-700);
}
.verify-result {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 14px; border-radius: var(--radius-sm);
  font-size: 13px;
}
.verify-result.verify-ok { background: #ecfdf5; border: 1px solid #a7f3d0; color: #047857; }
.verify-result.verify-fail { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; }
.verify-elapsed { font-size: 11px; opacity: 0.7; margin-left: 10px; display: inline-flex; align-items: center; gap: 3px; }
.verify-error { font-family: var(--mono); font-size: 12px; margin-top: 4px; opacity: 0.8; }
.verify-payload {
  margin: 6px 0 0; font-family: var(--mono); font-size: 11px;
  background: rgba(0,0,0,.06); border-radius: 6px; padding: 8px;
  max-height: 120px; overflow: auto; white-space: pre-wrap; word-break: break-all;
}
.ep-details {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 0;
}
.ep-detail-empty { color: var(--text-muted); font-size: 13px; padding: 8px 0; }
.ep-detail-row { display: flex; align-items: flex-start; gap: 14px; }
.ep-detail-label {
  flex-shrink: 0; min-width: 110px; display: flex; align-items: center; gap: 5px;
  font-size: 12px; font-weight: 600; color: var(--gray-500); padding-top: 2px;
  text-transform: uppercase; letter-spacing: 0.03em;
}
.ep-detail-json {
  margin: 0; font-family: var(--mono); font-size: 11px;
  background: var(--gray-50); border: 1px solid var(--border);
  border-radius: 6px; padding: 6px 10px; max-height: 80px;
  overflow: auto; white-space: pre-wrap; flex: 1;
}
.ep-detail-value { font-family: var(--mono); font-size: 12px; color: var(--gray-600); }

/* ─── Spinner ─── */
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* ─── Info row (settings) ─── */
.info-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 14px;
  color: var(--gray-600);
}
.info-row:last-child { border-bottom: none; }
.info-row strong { color: var(--gray-900); }

/* ── Pannello Attività (destra in chat) ────────────────────────────────── */
.chat-layout {
  display: flex;
  height: calc(100vh - 60px);
  margin: -28px -32px;
}

.activity-panel {
  width: 280px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.activity-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  user-select: none;
}

.activity-header:hover { background: var(--surface-hover, rgba(0,0,0,.03)); }

.activity-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.activity-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .05em;
  color: var(--text-muted);
  margin: 6px 0 8px;
  display: flex;
  align-items: center;
}

.activity-empty {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 8px;
  line-height: 1.5;
}

.activity-item {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 6px;
  transition: opacity .2s;
}

.activity-item.paused { opacity: .5; }

.activity-item-top { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 4px; }

.activity-item-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  line-height: 1.4;
  flex: 1;
}

.activity-item-meta {
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}

.activity-item-actions { display: flex; gap: 6px; }

/* Log azioni */
.action-log-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
}

.action-log-item:last-child { border-bottom: none; }

.action-log-icon { color: var(--green-600, #16a34a); margin-top: 2px; flex-shrink: 0; }

.action-log-name { font-size: 12px; font-weight: 500; color: var(--text); line-height: 1.4; }

.action-log-time { font-size: 11px; color: var(--text-muted); margin-top: 1px; }

@media (max-width: 900px) {
  .activity-panel { display: none; }
}

/* ── Allegati in chat ── */
.attachment-chip { display: inline-flex; align-items: center; gap: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 4px 10px; font-size: 12px; margin: 4px 4px 0 0; }
.attachment-chip button { background: none; border: none; cursor: pointer; color: var(--text-muted); padding: 0; line-height: 1; }
.attachments-preview { display: flex; flex-wrap: wrap; padding: 6px 16px 0; max-width: 820px; margin: 0 auto; }

/* ── Chat WA sincronizzata ── */
.chat-item.wa-synced { border-left: 3px solid #25D366; }
.chat-item.wa-synced .chat-item-main { color: #25D366; font-weight: 600; }
.wa-synced-badge { display: inline-flex; align-items: center; gap: 4px; background: #25D366; color: #fff; border-radius: 10px; padding: 2px 8px; font-size: 11px; font-weight: 600; }

/* ── Phone link modal ── */
.phone-link-box { display: flex; flex-direction: column; gap: 14px; }
.otp-inputs { display: flex; gap: 8px; justify-content: center; }
.otp-digit { width: 44px; height: 52px; text-align: center; font-size: 22px; font-weight: 700; border: 2px solid var(--border); border-radius: 10px; outline: none; background: var(--surface); }
.otp-digit:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--blue-100); }

/* ── Training chat toggle (sidebar, discreto) ── */
.sidebar-training-toggle { border-top: 1px solid var(--border); padding: 10px 12px; margin-top: auto; }
.sidebar-training-label { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-muted); cursor: pointer; user-select: none; }
.sidebar-training-label input[type=checkbox] { margin-left: auto; cursor: pointer; }
.sidebar-training-label span { flex: 1; }
.sidebar-training-badge { display: inline-block; margin-top: 4px; margin-left: 20px; font-size: 10px; font-weight: 600; color: var(--primary); text-transform: uppercase; letter-spacing: 0.05em; }
.learning-suggestion { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin-top: 10px; font-size: 13px; }
.learning-suggestion .ls-label { font-weight: 600; color: var(--text); margin-bottom: 6px; }
.learning-suggestion .ls-actions { display: flex; gap: 8px; margin-top: 8px; }

/* ── Gemini loader ── */
.gemini-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 48px 24px; }
.gemini-spinner { width: 56px; height: 56px; border: 5px solid var(--border); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.gemini-loading p { font-size: 15px; color: var(--text-muted); text-align: center; }

/* ── Training docs ── */
.training-docs-list { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
.training-doc-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.training-doc-name { flex: 1; font-size: 13px; font-weight: 500; }
.training-doc-size { font-size: 12px; color: var(--text-muted); }
CSS_EOF

cat > frontend/src/lib/api.js << 'API_EOF'
// Client API: gestione token, refresh automatico, streaming SSE.

const ACCESS = 'sophia.access';
const REFRESH = 'sophia.refresh';
const TENANT = 'sophia.tenant';

export const tokens = {
  get access() { return localStorage.getItem(ACCESS); },
  get refresh() { return localStorage.getItem(REFRESH); },
  get tenant() { return localStorage.getItem(TENANT); },
  set({ accessToken, refreshToken }) {
    if (accessToken) localStorage.setItem(ACCESS, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH, refreshToken);
  },
  setTenant(id) { id ? localStorage.setItem(TENANT, id) : localStorage.removeItem(TENANT); },
  clear() { [ACCESS, REFRESH, TENANT].forEach((k) => localStorage.removeItem(k)); },
};

function authHeaders(extra = {}) {
  const h = { ...extra };
  if (tokens.access) h.Authorization = `Bearer ${tokens.access}`;
  if (tokens.tenant) h['X-Tenant-Id'] = tokens.tenant;
  return h;
}

async function refreshAccess() {
  if (!tokens.refresh) return false;
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refresh }),
  });
  if (!res.ok) { tokens.clear(); return false; }
  tokens.set(await res.json());
  return true;
}

// Richiesta JSON con retry trasparente in caso di token scaduto (401).
export async function api(path, { method = 'GET', body, headers, retry = true } = {}) {
  const opts = {
    method,
    headers: authHeaders({ 'Content-Type': 'application/json', ...headers }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  let res = await fetch(`/api${path}`, opts);

  if (res.status === 401 && retry && (await refreshAccess())) {
    opts.headers = authHeaders({ 'Content-Type': 'application/json', ...headers });
    res = await fetch(`/api${path}`, opts);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Errore', res.status, data.details);
  return data;
}

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Upload multipart.
export async function upload(path, file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api${path}`, { method: 'POST', headers: authHeaders(), body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Upload fallito', res.status);
  return data;
}

// Streaming della risposta AI via Server-Sent Events su una POST.
export async function streamMessage(conversationId, content, { onToken, onTool, onDone, onError }) {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content }),
  });
  if (!res.ok || !res.body) { onError?.(new Error('Streaming non disponibile')); return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const block of events) {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
      const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
      if (!dataLine) continue;
      const payload = JSON.parse(dataLine);
      if (event === 'token') onToken?.(payload.delta);
      else if (event === 'tool') onTool?.(payload);
      else if (event === 'done') onDone?.(payload);
      else if (event === 'error') onError?.(new Error(payload.message));
    }
  }
}

// ── Socket.io: ascolta eventi realtime ─────────────────────────────────────
// Avvia la connessione e propaga gli eventi come CustomEvent del DOM.
let _socket = null;

export function connectRealtime() {
  if (_socket || typeof window === 'undefined') return;
  // socket.io-client dev proxy o produzione
  import('socket.io-client').then(({ io }) => {
    _socket = io({ auth: { token: tokens.access } });

    // Azione ricorrente eseguita dallo scheduler
    _socket.on('task:executed', (payload) => {
      const dt = payload.executedAt
        ? new Date(payload.executedAt).toLocaleString('it-IT', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
          })
        : new Date().toLocaleString('it-IT');
      window.dispatchEvent(new CustomEvent('sophia:action', {
        detail: { label: payload.label || 'Azione eseguita', time: dt },
      }));
      window.dispatchEvent(new CustomEvent('sophia:task:executed', { detail: payload }));
    });

    // Messaggi WhatsApp sincronizzati in realtime
    _socket.on('whatsapp:message', (payload) => {
      window.dispatchEvent(new CustomEvent('sophia:wa:message', { detail: payload }));
    });

    _socket.on('disconnect', () => { _socket = null; });
  }).catch(() => {});
}
API_EOF

echo '[6/6] File copiati'

# Controlla se OTP_API_KEY è nel .env
if ! grep -q "OTP_API_KEY" backend/.env 2>/dev/null; then
  echo "" >> backend/.env
  echo "# Chiave OTP ai-sophia" >> backend/.env
  echo "OTP_API_KEY=" >> backend/.env
  echo "PUBLIC_API_URL=https://api.ai-sophia.it" >> backend/.env
  echo ">>> Aggiunte OTP_API_KEY e PUBLIC_API_URL a backend/.env — ricordati di inserire la chiave!"
fi

echo ""
echo "=== Patch applicata! ==="
echo ""
echo "Passo successivo obbligatorio — migra il database:"
echo "  cd backend && npx prisma migrate dev --name add_phone_gemini_training"
echo ""
echo "Poi riavvia backend e frontend."
