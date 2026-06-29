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
