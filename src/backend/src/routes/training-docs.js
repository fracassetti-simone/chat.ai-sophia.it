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
