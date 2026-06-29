import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { config } from '../config/index.js';
import { asyncHandler, badRequest, notFound } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { extractText } from '../services/extract.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 },
});

function fileUrl(req, id, download = false) {
  const base = process.env.PUBLIC_API_URL ||
    (req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')) +
    '://' + (req.headers['x-forwarded-host'] || req.headers.host);
  return `${base}/api/documents/${id}/file${download ? '?download=1' : ''}`;
}

function fileView(req, d) {
  return {
    id: d.id,
    filename: d.filename,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    tags: d.tags || [],
    contactId: d.contactId || null,
    createdAt: d.createdAt,
    url: fileUrl(req, d.id),
    downloadUrl: fileUrl(req, d.id, true),
  };
}

function displayName(c) {
  const n = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return n || c.company || c.phone || c.email || 'Contatto';
}

async function breadcrumb(tenantId, folderId) {
  const path = [];
  let current = folderId;
  let guard = 0;
  while (current && guard < 50) {
    const f = await prisma.cloudFolder.findFirst({ where: { id: current, tenantId }, select: { id: true, name: true, parentId: true } });
    if (!f) break;
    path.unshift({ id: f.id, name: f.name });
    current = f.parentId;
    guard += 1;
  }
  return path;
}

// ── GET /api/cloud?folderId= ──────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const folderId = (req.query.folderId || '').toString().trim() || null;

  let current = null;
  if (folderId) {
    current = await prisma.cloudFolder.findFirst({ where: { id: folderId, tenantId: req.tenantId } });
    if (!current) throw notFound('Cartella non trovata');
  }

  // Determina la where clause per i documenti.
  // Il client Prisma sul server conosce "folder" come relazione (non "folderId" scalare)
  // per il filtro, MA per i documenti senza cartella usa la negazione.
  let docWhere;
  if (folderId) {
    docWhere = { tenantId: req.tenantId, folder: { id: folderId } };
  } else {
    // Documenti senza cartella: "folder is null" si ottiene con NOT has folder
    docWhere = { tenantId: req.tenantId, folder: null };
  }

  const [folders, files] = await Promise.all([
    prisma.cloudFolder.findMany({
      where: { tenantId: req.tenantId, parentId: folderId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, contactId: true, _count: { select: { documents: true, children: true } } },
    }),
    prisma.document.findMany({
      where: docWhere,
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  res.json({
    folder: current ? { id: current.id, name: current.name, contactId: current.contactId } : null,
    breadcrumb: folderId ? await breadcrumb(req.tenantId, folderId) : [],
    folders: folders.map((f) => ({
      id: f.id, name: f.name, isContact: !!f.contactId,
      itemCount: f._count.documents + f._count.children,
    })),
    files: files.map((d) => fileView(req, d)),
  });
}));

// ── POST /api/cloud/folders ───────────────────────────────────────────────
const folderSchema = z.object({ name: z.string().trim().min(1).max(120), parentId: z.string().optional().nullable() });
router.post('/folders', asyncHandler(async (req, res) => {
  const { name, parentId } = folderSchema.parse(req.body || {});
  if (parentId) {
    const parent = await prisma.cloudFolder.findFirst({ where: { id: parentId, tenantId: req.tenantId } });
    if (!parent) throw badRequest('Cartella superiore non valida.');
  }
  const folder = await prisma.cloudFolder.create({
    data: { tenantId: req.tenantId, name, parentId: parentId || null },
  });
  res.status(201).json({ folder: { id: folder.id, name: folder.name, isContact: false, itemCount: 0 } });
}));

// ── PATCH /api/cloud/folders/:id ─────────────────────────────────────────
router.patch('/folders/:id', asyncHandler(async (req, res) => {
  const name = z.string().trim().min(1).max(120).parse(req.body?.name);
  const { count } = await prisma.cloudFolder.updateMany({
    where: { id: req.params.id, tenantId: req.tenantId },
    data: { name },
  });
  if (!count) throw notFound('Cartella non trovata');
  res.json({ ok: true });
}));

// ── DELETE /api/cloud/folders/:id ────────────────────────────────────────
router.delete('/folders/:id', asyncHandler(async (req, res) => {
  const root = await prisma.cloudFolder.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!root) throw notFound('Cartella non trovata');

  const ids = [];
  let frontier = [root.id];
  let guard = 0;
  while (frontier.length && guard < 1000) {
    ids.push(...frontier);
    const children = await prisma.cloudFolder.findMany({
      where: { tenantId: req.tenantId, parentId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((c) => c.id);
    guard += 1;
  }

  // Elimina documenti nelle cartelle usando la relazione folder
  await prisma.document.deleteMany({
    where: { tenantId: req.tenantId, folder: { id: { in: ids } } },
  });
  await prisma.cloudFolder.delete({ where: { id: root.id } });
  res.json({ ok: true });
}));

// ── POST /api/cloud/files ─────────────────────────────────────────────────
router.post(
  '/files',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Nessun file ricevuto.');
    const folderId  = (req.body.folderId  || '').toString().trim() || null;
    let   contactId = (req.body.contactId || '').toString().trim() || null;
    let tags = [];
    try { if (req.body.tags) tags = JSON.parse(req.body.tags); } catch { tags = []; }
    if (!Array.isArray(tags)) tags = [];

    if (folderId) {
      const folder = await prisma.cloudFolder.findFirst({ where: { id: folderId, tenantId: req.tenantId }, select: { id: true, contactId: true } });
      if (!folder) throw badRequest('Cartella non valida.');
      if (!contactId && folder.contactId) contactId = folder.contactId;
    }

    let extracted = '';
    try {
      const raw = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);
      if (raw != null) extracted = String(raw).replace(/\u0000/g, '');
    } catch { extracted = ''; }
    const safeExtracted = String(extracted || '');

    // ── STRATEGIA: prima crea il documento senza relazioni opzionali,
    //    poi collega cartella e contatto con update separati.
    //    Questo aggira qualsiasi problema di versione del client Prisma:
    //    tenant è l'unico campo obbligatorio da passare alla create.
    const doc = await prisma.document.create({
      data: {
        tenant:    { connect: { id: req.tenantId } },
        filename:  req.file.originalname,
        mimeType:  req.file.mimetype,
        sizeBytes: req.file.size,
        extracted: safeExtracted,
        data:      req.file.buffer,
        tags:      [...new Set(tags.filter(Boolean))],
      },
    });

    // Collega cartella e contatto con update separati (funziona con qualsiasi versione client)
    if (folderId || contactId) {
      const updateData = {};
      if (folderId)  updateData.folder  = { connect: { id: folderId } };
      if (contactId) updateData.contact = { connect: { id: contactId } };
      // Usa updateMany per evitare errori se i campi non esistono nel client
      await prisma.$executeRawUnsafe(
        `UPDATE "Document" SET ${[
          folderId  ? `"folderId" = '${folderId}'`   : null,
          contactId ? `"contactId" = '${contactId}'` : null,
        ].filter(Boolean).join(', ')} WHERE id = '${doc.id}'`
      );
    }

    const updated = await prisma.document.findUnique({ where: { id: doc.id } });
    res.status(201).json({ file: fileView(req, updated || doc) });
  }),
);

// ── PATCH /api/cloud/files/:id ────────────────────────────────────────────
router.patch('/files/:id', asyncHandler(async (req, res) => {
  const doc = await prisma.document.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!doc) throw notFound('File non trovato');

  const setClauses = [];
  if (typeof req.body.filename === 'string' && req.body.filename.trim()) {
    await prisma.document.update({ where: { id: doc.id }, data: { filename: req.body.filename.trim() } });
  }
  if (Array.isArray(req.body.tags)) {
    await prisma.document.update({ where: { id: doc.id }, data: { tags: [...new Set(req.body.tags.filter(Boolean))] } });
  }
  if ('folderId' in req.body) {
    const fid = (req.body.folderId || '').toString().trim() || null;
    if (fid) {
      const folder = await prisma.cloudFolder.findFirst({ where: { id: fid, tenantId: req.tenantId } });
      if (!folder) throw badRequest('Cartella di destinazione non valida.');
    }
    // Raw SQL per bypassare il problema di versione client
    await prisma.$executeRawUnsafe(
      `UPDATE "Document" SET "folderId" = ${fid ? `'${fid}'` : 'NULL'} WHERE id = '${doc.id}'`
    );
  }

  const updated = await prisma.document.findUnique({ where: { id: doc.id } });
  res.json({ file: fileView(req, updated || doc) });
}));

// ── DELETE /api/cloud/files/:id ───────────────────────────────────────────
router.delete('/files/:id', asyncHandler(async (req, res) => {
  const { count } = await prisma.document.deleteMany({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!count) throw notFound('File non trovato');
  res.json({ ok: true });
}));

// ── GET /api/cloud/search?q= ──────────────────────────────────────────────
router.get('/search', asyncHandler(async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json({ files: [] });
  const files = await prisma.document.findMany({
    where: {
      tenantId: req.tenantId,
      OR: [
        { filename: { contains: q, mode: 'insensitive' } },
        { tags: { has: q } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json({ files: files.map((d) => fileView(req, d)) });
}));

// ── POST /api/cloud/contact/:contactId/folder ─────────────────────────────
router.post('/contact/:contactId/folder', asyncHandler(async (req, res) => {
  const contact = await prisma.contact.findFirst({ where: { id: req.params.contactId, tenantId: req.tenantId } });
  if (!contact) throw notFound('Contatto non trovato');

  let folder = await prisma.cloudFolder.findUnique({ where: { contactId: contact.id } }).catch(() => null)
    || await prisma.cloudFolder.findFirst({ where: { tenantId: req.tenantId, contactId: contact.id } });
  if (!folder) {
    folder = await prisma.cloudFolder.create({
      data: { tenantId: req.tenantId, name: displayName(contact), contactId: contact.id, parentId: null },
    });
  }
  res.json({ folderId: folder.id, name: folder.name });
}));

export default router;
