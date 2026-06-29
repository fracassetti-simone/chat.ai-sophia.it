import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../db/prisma.js';
import { config } from '../config/index.js';
import { asyncHandler, badRequest, notFound } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { extractText } from '../services/extract.js';

const router = Router();

const ALLOWED = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown',
  'application/json', 'application/x-yaml', 'text/yaml',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const okExt = /\.(pdf|docx|txt|md|markdown|json|ya?ml|jpg|jpeg|png|webp|gif)$/i.test(file.originalname);
    cb(null, ALLOWED.has(file.mimetype) || okExt);
  },
});

// ── POST /api/documents — carica e salva il file (testo estratto + binario) ──
router.post(
  '/',
  authenticate, tenantScope, requireTenant,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Nessun file ricevuto');
    let extracted = '';
    try {
      const raw = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);
      if (raw != null && typeof raw === 'string') extracted = raw.replace(/\u0000/g, '');
    } catch { extracted = ''; }
    const doc = await prisma.document.create({
      data: {
        tenant: { connect: { id: req.tenantId } },
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        extracted: extracted || '',
        data: req.file.buffer,
      },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true },
    });

    // Costruisce l'URL pubblico del documento
    const publicUrl = buildDocUrl(req, doc.id);

    res.status(201).json({ document: { ...doc, publicUrl }, text: extracted, publicUrl });
  }),
);

// ── GET /api/documents — lista documenti ──
router.get(
  '/',
  authenticate, tenantScope, requireTenant,
  asyncHandler(async (req, res) => {
    const documents = await prisma.document.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true },
    });
    res.json({ documents: documents.map(d => ({ ...d, publicUrl: buildDocUrl(req, d.id) })) });
  }),
);

// ── GET /api/documents/:id/file — scarica il file (URL pubblico per AI/WA) ──
// Questa rotta è pubblica (no auth) così Meta può scaricare il documento.
router.get(
  '/:id/file',
  asyncHandler(async (req, res) => {
    const doc = await prisma.document.findUnique({
      where: { id: req.params.id },
      select: { filename: true, mimeType: true, data: true },
    });
    if (!doc || !doc.data) throw notFound('File non trovato');
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.set({
      'Content-Type': doc.mimeType || 'application/octet-stream',
      'Content-Disposition': `${disposition}; filename="${encodeURIComponent(doc.filename)}"`,
      'Cache-Control': 'public, max-age=86400',
    });
    res.send(doc.data);
  }),
);

// ── DELETE /api/documents/:id ──
router.delete(
  '/:id',
  authenticate, tenantScope, requireTenant,
  asyncHandler(async (req, res) => {
    const { count } = await prisma.document.deleteMany({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!count) throw notFound('Documento non trovato');
    res.json({ ok: true });
  }),
);

function buildDocUrl(req, docId) {
  const base = process.env.PUBLIC_API_URL ||
    (req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')) +
    '://' + (req.headers['x-forwarded-host'] || req.headers.host);
  return `${base}/api/documents/${docId}/file`;
}

export default router;
