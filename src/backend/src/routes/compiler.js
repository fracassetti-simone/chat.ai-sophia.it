import { Router } from 'express';
import multer from 'multer';
import { Readable } from 'stream';
import jwt from 'jsonwebtoken';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, badRequest } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { logger } from '../config/logger.js';
import { emitToTenant } from '../realtime/io.js';
import { config } from '../config/index.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const API_BASE = 'https://compiler.ai-sophia.it';

// Secret dedicato per i PDF token (usa il JWT_ACCESS_SECRET, nessuna dipendenza extra)
const PDF_TOKEN_SECRET = config.JWT_ACCESS_SECRET + ':pdf';
const PDF_TOKEN_TTL    = '60s'; // valido solo 60 secondi

async function compilerApi(apiKey, method, path, body) {
  const opts = { method, headers: { Authorization: `Bearer ${apiKey}` } };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `PHI Compiler error ${res.status}`);
  }
  return res.json();
}

function canManage(req, instance) {
  if (req.user?.role === 'SUPER_ADMIN') return true;
  if (req.user?.role === 'ADMIN' && instance?.config?.allowAdminManage) return true;
  return false;
}

// ══════════════════════════════════════════════════════════════════════════
// WEBHOOK HANDLER — esportato e montato in index.js prima di qualsiasi auth
// ══════════════════════════════════════════════════════════════════════════
export async function compilerWebhookHandler(req, res) {
  const { tenantId } = req.params;
  const payload = req.body;

  logger.info({ tenantId, event: payload?.event, templateId: payload?.templateId }, 'PHI Compiler webhook ricevuto');

  // Risponde SUBITO 200 — PHI Compiler non deve aspettare
  res.json({ ok: true });

  try {
    if (payload.event === 'form.mapped') {
      const { templateId, name } = payload;

      let updated = await prisma.compilerForm.updateMany({
        where: { tenantId, templateId },
        data: { status: 'ready', ...(name ? { name } : {}) },
      });

      if (updated.count === 0) {
        logger.warn({ tenantId, templateId }, 'PHI Compiler: templateId non trovato, cerco per status processing');
        const oldest = await prisma.compilerForm.findFirst({
          where: { tenantId, status: 'processing' },
          orderBy: { createdAt: 'desc' },
        });
        if (oldest) {
          await prisma.compilerForm.update({
            where: { id: oldest.id },
            data: { templateId, status: 'ready', ...(name ? { name } : {}) },
          });
          logger.info({ tenantId, formId: oldest.id, templateId }, 'PHI Compiler: form aggiornato via fallback → ready');
        } else {
          logger.warn({ tenantId, templateId }, 'PHI Compiler: nessun form in processing trovato');
        }
      } else {
        logger.info({ tenantId, templateId, count: updated.count }, 'PHI Compiler: form.mapped → ready');
      }
    }

    if (payload.event === 'form.completed') {
      const form = await prisma.compilerForm.findFirst({ where: { tenantId, templateId: payload.templateId } });
      if (!form) { logger.warn({ tenantId, templateId: payload.templateId }, 'PHI Compiler: form non trovato per submission'); return; }

      let contactId = null;
      if (payload.email) {
        const contact = await prisma.contact.findFirst({ where: { tenantId, email: { equals: payload.email, mode: 'insensitive' } } });
        contactId = contact?.id || null;
      }

      const submission = await prisma.compilerSubmission.create({
        data: { tenantId, formId: form.id, submissionId: payload.submissionId, contactId, email: payload.email || null, fields: payload.fields || [], attachments: payload.attachments || [], pdfUrl: payload.downloadUrl || null },
      });

      // ── Notifica realtime a tutti i client del tenant ──────────────────
      emitToTenant(tenantId, 'compiler:form_completed', {
        submissionId: submission.id,
        externalId:   payload.submissionId,
        formId:       form.id,
        formName:     form.name,
        email:        payload.email || null,
        contactId,
        pdfAvailable: !!(payload.downloadUrl || payload.pdfBase64),
        completedAt:  new Date().toISOString(),
      });
      logger.info({ tenantId, submissionId: submission.id, formName: form.name }, 'PHI Compiler: form.completed → socket emesso');

      // ── Attiva i task in attesa per questo link specifico ──────────────
      // Il linkId è incluso nel payload del webhook se il compiler lo supporta,
      // oppure cerchiamo per templateId e status PAUSED con waitForFormLinkId nel payload.
      try {
        // Recupera tutti i task PAUSED di questo tenant che aspettano una compilazione di questo form
        const waitingTasks = await prisma.backgroundTask.findMany({
          where: {
            tenantId,
            status: 'PAUSED',
            kind: 'ONCE',
          },
        });

        const tasksToActivate = waitingTasks.filter(t => {
          const p = t.payload;
          if (!p || typeof p !== 'object') return false;
          // Se il payload ha waitForFormLinkId, controlla che corrisponda (se il compiler lo invia)
          // oppure attiva per qualsiasi form completato con questo templateId
          if (p.waitForFormLinkId) {
            // Il compiler invia linkId nel webhook solo se supportato; altrimenti attiva per formName
            return payload.linkId === p.waitForFormLinkId || p.formName === form.name;
          }
          return false;
        });

        for (const task of tasksToActivate) {
          // Arricchisci l'istruzione con i dati della compilazione
          const fieldsText = (payload.fields || [])
            .map(f => `${f.label}: ${f.value}`)
            .join(', ');
          const enrichedInstruction = task.instruction +
            (fieldsText ? `\n\nDati compilati: ${fieldsText}` : '') +
            (submission.pdfUrl ? `\n\nPDF disponibile: ${submission.pdfUrl}` : '');

          await prisma.backgroundTask.update({
            where: { id: task.id },
            data: {
              status: 'ACTIVE',
              runAt: new Date(), // esegui subito al prossimo tick dello scheduler
              instruction: enrichedInstruction.slice(0, 4000),
            },
          });
          logger.info({ tenantId, taskId: task.id, formName: form.name }, 'PHI Compiler: task follow-up attivato');
        }

        if (tasksToActivate.length > 0) {
          logger.info({ tenantId, count: tasksToActivate.length }, 'PHI Compiler: task follow-up attivati');
        }
      } catch (err) {
        logger.error({ err: err.message }, 'PHI Compiler: errore attivazione task follow-up');
      }

      if (contactId && payload.pdfBase64) {
        try {
          const pdfBuffer = Buffer.from(payload.pdfBase64, 'base64');
          const filename = `${form.name}-${new Date().toISOString().slice(0, 10)}.pdf`;
          let folder = await prisma.cloudFolder.findFirst({ where: { tenantId, contactId } });
          if (!folder) {
            const contact = await prisma.contact.findUnique({ where: { id: contactId } });
            const fname = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() || contact?.email || 'Contatto';
            folder = await prisma.cloudFolder.create({ data: { tenantId, name: fname, contactId, parentId: null } });
          }
          const doc = await prisma.document.create({ data: { tenant: { connect: { id: tenantId } }, filename, mimeType: 'application/pdf', sizeBytes: pdfBuffer.length, extracted: '', data: pdfBuffer } });
          await prisma.$executeRawUnsafe(`UPDATE "Document" SET "folderId" = $1, "contactId" = $2 WHERE id = $3`, folder.id, contactId, doc.id);
        } catch (err) { logger.error({ err: err.message }, 'PHI Compiler: salvataggio PDF fallito'); }
      }
    }
  } catch (err) {
    logger.error({ err: err.message, tenantId, event: payload?.event }, 'PHI Compiler webhook: errore');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ROUTE PUBBLICA — PDF via token one-time
// Deve stare PRIMA di router.use(authenticate) altrimenti il middleware
// blocca la richiesta del browser (che non può mandare Authorization header).
// ══════════════════════════════════════════════════════════════════════════

// GET /api/compiler/submissions/:id/pdf?token=<jwt>
// Il token (60 s) viene generato dalla route POST /submissions/:id/pdf-token (autenticata).
router.get('/submissions/:id/pdf', asyncHandler(async (req, res) => {
  // 1. Valida il token one-time
  const raw = req.query.token;
  if (!raw) {
    return res.status(401).json({ error: 'Token mancante' });
  }

  let claims;
  try {
    claims = jwt.verify(raw, PDF_TOKEN_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }

  // Il token deve riferirsi esattamente a questa submission
  if (claims.submissionId !== req.params.id) {
    return res.status(403).json({ error: 'Token non valido per questa submission' });
  }

  // 2. Carica submission e API key
  const sub = await prisma.compilerSubmission.findFirst({
    where: { id: req.params.id, tenantId: claims.tenantId },
  });
  if (!sub || !sub.pdfUrl) return res.status(404).json({ error: 'PDF non disponibile.' });

  const instance = await prisma.moduleInstance.findFirst({
    where: { tenantId: claims.tenantId, moduleKey: 'compiler', enabled: true },
  });
  const apiKey = instance?.config?.apiKey;
  if (!apiKey) return res.status(400).json({ error: 'API key PHI Compiler non configurata.' });

  // 3. Proxy verso PHI Compiler con la API key
  const upstream = await fetch(sub.pdfUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!upstream.ok) {
    logger.error({ status: upstream.status, pdfUrl: sub.pdfUrl }, 'PHI Compiler: PDF fetch fallito');
    return res.status(502).json({ error: `PHI Compiler error ${upstream.status}` });
  }

  const contentType   = upstream.headers.get('content-type') || 'application/pdf';
  const contentLength = upstream.headers.get('content-length');

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `inline; filename="modulo-${sub.id}.pdf"`);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (contentLength) res.setHeader('Content-Length', contentLength);

  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.pipe(res);
  nodeStream.on('error', (err) => {
    logger.error({ err: err.message }, 'PHI Compiler: errore stream PDF');
    if (!res.headersSent) res.status(500).end();
  });
}));

// ══════════════════════════════════════════════════════════════════════════
// ROUTE AUTENTICATE
// ══════════════════════════════════════════════════════════════════════════
router.use(authenticate, tenantScope, requireTenant);

async function getInstanceAndKey(tenantId) {
  const instance = await prisma.moduleInstance.findFirst({
    where: { tenantId, moduleKey: 'compiler', enabled: true },
  });
  const apiKey = instance?.config?.apiKey;
  return { instance, apiKey };
}

// GET /api/compiler/forms
router.get('/forms', asyncHandler(async (req, res) => {
  const forms = await prisma.compilerForm.findMany({
    where: { tenantId: req.tenantId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { submissions: true } } },
  });
  res.json({ forms: forms.map(f => ({ ...f, submissionCount: f._count.submissions })) });
}));

// POST /api/compiler/forms — carica PDF, risposta immediata con templateId
router.post('/forms', upload.single('file'), asyncHandler(async (req, res) => {
  const { instance, apiKey } = await getInstanceAndKey(req.tenantId);
  if (!apiKey) throw badRequest('API key PHI Compiler non configurata.');
  if (!req.file) throw badRequest('File PDF mancante.');

  const name = (req.body.name || req.file.originalname.replace(/\.pdf$/i, '')).trim();

  const form = new FormData();
  form.append('pdf', new Blob([req.file.buffer], { type: 'application/pdf' }), req.file.originalname);
  form.append('name', name);
  form.append('aiMapping', 'true');

  const result = await compilerApi(apiKey, 'POST', '/api/v1/forms', form);

  const cf = await prisma.compilerForm.create({
    data: {
      tenantId: req.tenantId,
      templateId: result.templateId,
      name,
      status: 'processing',
    },
  });

  logger.info({ tenantId: req.tenantId, templateId: result.templateId }, 'PHI Compiler: PDF caricato, in attesa del webhook form.mapped');

  res.json({ ok: true, form: cf });
}));

// POST /api/compiler/forms/:id/generate-link
router.post('/forms/:id/generate-link', asyncHandler(async (req, res) => {
  const cf = await prisma.compilerForm.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!cf) throw notFound('Modulo non trovato.');
  if (cf.status !== 'ready') throw badRequest('Il modulo è ancora in elaborazione.');
  const { instance, apiKey } = await getInstanceAndKey(req.tenantId);
  if (!apiKey) throw badRequest('API key PHI Compiler non configurata.');
  if (!canManage(req, instance)) throw badRequest('Non hai i permessi per generare link.');

  const { excludeAttachments = [] } = req.body || {};
  const result = await compilerApi(apiKey, 'POST', `/api/v1/forms/${cf.templateId}/link`, { excludeAttachments });
  res.json({ ok: true, url: result.url, linkId: result.linkId, requestedAttachments: result.requestedAttachments });
}));

// POST /api/compiler/forms/:id/edit-link
router.post('/forms/:id/edit-link', asyncHandler(async (req, res) => {
  const cf = await prisma.compilerForm.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!cf) throw notFound('Modulo non trovato.');
  if (cf.status !== 'ready') throw badRequest('Il modulo è ancora in elaborazione.')
  const { instance, apiKey } = await getInstanceAndKey(req.tenantId);
  if (!apiKey) throw badRequest('API key PHI Compiler non configurata.');
  if (!canManage(req, instance)) throw badRequest('Non hai i permessi per modificare i moduli.');

  const result = await compilerApi(apiKey, 'POST', `/api/v1/forms/${cf.templateId}/edit-link`);
  res.json({ ok: true, editUrl: result.editUrl, expiresAt: result.expiresAt });
}));

// DELETE /api/compiler/forms/:id
router.delete('/forms/:id', asyncHandler(async (req, res) => {
  const cf = await prisma.compilerForm.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!cf) throw notFound('Modulo non trovato.');
  const { instance, apiKey } = await getInstanceAndKey(req.tenantId);
  if (!canManage(req, instance)) throw badRequest('Non hai i permessi per eliminare moduli.');
  if (apiKey && cf.status === 'ready') {
    await compilerApi(apiKey, 'DELETE', `/api/v1/forms/${cf.templateId}`).catch(() => {});
  }
  await prisma.compilerForm.delete({ where: { id: cf.id } });
  res.json({ ok: true });
}));

// GET /api/compiler/submissions
router.get('/submissions', asyncHandler(async (req, res) => {
  const where = { tenantId: req.tenantId };
  if (req.query.formId) where.formId = req.query.formId;
  const subs = await prisma.compilerSubmission.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 100,
    include: { form: { select: { name: true } } },
  });
  res.json({ submissions: subs });
}));

// POST /api/compiler/submissions/:id/pdf-token
// Genera un JWT one-time (60 s) che autorizza il download del PDF.
// Il frontend chiama questa route (autenticata) e poi apre l'URL con il token in query.
router.post('/submissions/:id/pdf-token', asyncHandler(async (req, res) => {
  const sub = await prisma.compilerSubmission.findFirst({
    where: { id: req.params.id, tenantId: req.tenantId },
  });
  if (!sub || !sub.pdfUrl) throw notFound('PDF non disponibile.');

  const token = jwt.sign(
    { submissionId: sub.id, tenantId: req.tenantId },
    PDF_TOKEN_SECRET,
    { expiresIn: PDF_TOKEN_TTL },
  );

  res.json({ token });
}));

export default router;
