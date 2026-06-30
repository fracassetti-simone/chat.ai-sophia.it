import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { config } from '../config/index.js';
import { asyncHandler, badRequest, notFound, forbidden } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { extractText } from '../services/extract.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

// ── Modello di accesso multi-audience (allineato a routes/db.js) ──────────────
// 'contact' = l'utente del contatto a cui è collegata la cartella, autenticato
// dal proprio numero di telefono su un canale esterno (es. WhatsApp).
const AUDIENCES   = ['admin', 'users', 'selected', 'external', 'contact'];
const PERMISSIONS = ['read', 'write'];

// Default di sistema per le cartelle collegate a un contatto:
// admin + utenti completo, utenti esterni no, utente del contatto in lettura.
const CONTACT_FOLDER_DEFAULT = [
  { audience: 'admin',   permission: 'write' },
  { audience: 'users',   permission: 'write' },
  { audience: 'contact', permission: 'read'  },
];
// Default retro-compatibile per cartelle NON collegate a un contatto.
const GENERIC_FOLDER_DEFAULT = [
  { audience: 'admin', permission: 'write' },
  { audience: 'users', permission: 'write' },
];

function isSuperAdmin(req) { return req.user?.role === 'SUPER_ADMIN'; }
function isAdmin(req)      { return req.user?.role === 'ADMIN' || isSuperAdmin(req); }

/** Pulisce/normalizza un array di accesso ricevuto dal client.
 *  Forza sempre la presenza degli admin in scrittura (requisito: gli admin devono avere accesso). */
function normalizeAccess(raw) {
  const seen = new Set();
  const out = [];
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (!a || !AUDIENCES.includes(a.audience) || seen.has(a.audience)) continue;
      seen.add(a.audience);
      out.push({ audience: a.audience, permission: PERMISSIONS.includes(a.permission) ? a.permission : 'read' });
    }
  }
  // Gli admin hanno SEMPRE accesso completo.
  if (!seen.has('admin')) out.unshift({ audience: 'admin', permission: 'write' });
  else {
    const adm = out.find(a => a.audience === 'admin');
    adm.permission = 'write';
  }
  return out;
}

/** Restituisce il default per le cartelle-contatto, applicando l'override del tenant se presente. */
function contactFolderDefault(tenant) {
  const raw = tenant?.cloudFolderDefaults;
  if (Array.isArray(raw) && raw.length) {
    return normalizeAccess(raw);
  }
  return CONTACT_FOLDER_DEFAULT;
}

/** Array di accesso effettivo di una cartella.
 *  - access esplicito → usalo
 *  - cartella-contatto senza access → default contatto (con override tenant)
 *  - altrimenti → default generico (admin + utenti) */
function getAccess(folder, tenant = null) {
  if (Array.isArray(folder?.access) && folder.access.length) {
    return folder.access.filter(a => a && AUDIENCES.includes(a.audience));
  }
  if (folder?.contactId) return contactFolderDefault(tenant);
  return GENERIC_FOLDER_DEFAULT;
}

function userAudiences(req) {
  if (req.user?.role === 'ADMIN') return ['admin', 'users'];
  return ['users'];
}

/** Carica (e memoizza su req) i dati del tenant utili per gli accessi cloud. */
async function getTenant(req) {
  if (req._cloudTenant !== undefined) return req._cloudTenant;
  req._cloudTenant = await prisma.tenant.findUnique({
    where: { id: req.tenantId },
    select: { cloudFolderDefaults: true },
  }).catch(() => null);
  return req._cloudTenant;
}

/** Permesso dell'utente su una cartella: 'write' | 'read' | null. Super admin → 'write'. */
function permissionFor(req, folder, tenant = null) {
  if (isSuperAdmin(req)) return 'write';
  const access = getAccess(folder, tenant);
  const auds = userAudiences(req);
  const selUsers = Array.isArray(folder?.accessUsers) ? folder.accessUsers : [];
  let best = null;
  for (const a of access) {
    let match = false;
    if (a.audience === 'selected') match = selUsers.includes(req.user.id);
    // 'external' e 'contact' riguardano i canali esterni autenticati dal telefono,
    // non lo staff interno che usa la dashboard.
    else if (a.audience === 'external' || a.audience === 'contact') match = false;
    else match = auds.includes(a.audience);
    if (!match) continue;
    if (a.permission === 'write') return 'write';
    best = best || 'read';
  }
  return best;
}

function canSee(req, folder, tenant)   { return permissionFor(req, folder, tenant) != null; }
function canWrite(req, folder, tenant) { return permissionFor(req, folder, tenant) === 'write'; }

/** Carica una cartella e verifica l'accesso. Lancia 404/403 dove serve. */
async function loadFolder(req, id, { write = false } = {}) {
  const folder = await prisma.cloudFolder.findFirst({ where: { id, tenantId: req.tenantId } });
  if (!folder) throw notFound('Cartella non trovata');
  const tenant = await getTenant(req);
  if (!canSee(req, folder, tenant)) throw forbidden('Non hai accesso a questa cartella.');
  if (write && !canWrite(req, folder, tenant)) throw forbidden('Non hai il permesso di modificare questa cartella.');
  return folder;
}

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
    current = await loadFolder(req, folderId);
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
      select: { id: true, name: true, contactId: true, access: true, accessUsers: true, _count: { select: { documents: true, children: true } } },
    }),
    prisma.document.findMany({
      where: docWhere,
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const tenant = await getTenant(req);
  res.json({
    folder: current ? { id: current.id, name: current.name, contactId: current.contactId, isContact: !!current.contactId, access: getAccess(current, tenant), accessUsers: current.accessUsers || [], canWrite: canWrite(req, current, tenant) } : null,
    breadcrumb: folderId ? await breadcrumb(req.tenantId, folderId) : [],
    // Mostra solo le sottocartelle a cui l'utente ha accesso.
    folders: folders.filter((f) => canSee(req, f, tenant)).map((f) => ({
      id: f.id, name: f.name, isContact: !!f.contactId, contactId: f.contactId || null,
      itemCount: f._count.documents + f._count.children,
      access: getAccess(f, tenant), accessUsers: f.accessUsers || [], canWrite: canWrite(req, f, tenant),
    })),
    files: files.map((d) => fileView(req, d)),
  });
}));

// ── POST /api/cloud/folders ───────────────────────────────────────────────
const accessSchema = z.array(z.object({
  audience: z.enum(['admin', 'users', 'selected', 'external']),
  permission: z.enum(['read', 'write']).optional(),
})).optional();
const folderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().optional().nullable(),
  access: accessSchema,
  accessUsers: z.array(z.string()).optional(),
});
router.post('/folders', asyncHandler(async (req, res) => {
  const { name, parentId, access, accessUsers } = folderSchema.parse(req.body || {});
  if (parentId) {
    const parent = await loadFolder(req, parentId, { write: true });
    void parent;
  }
  const norm = normalizeAccess(access);
  const hasSelected = norm.some(a => a.audience === 'selected');
  const folder = await prisma.cloudFolder.create({
    data: {
      tenantId: req.tenantId, name, parentId: parentId || null,
      access: norm,
      accessUsers: hasSelected ? (accessUsers || []) : [],
    },
  });
  res.status(201).json({ folder: { id: folder.id, name: folder.name, isContact: false, itemCount: 0, access: getAccess(folder), accessUsers: folder.accessUsers || [], canWrite: true } });
}));

// ── PATCH /api/cloud/folders/:id ─────────────────────────────────────────
const folderPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  access: accessSchema,
  accessUsers: z.array(z.string()).optional(),
});
router.patch('/folders/:id', asyncHandler(async (req, res) => {
  await loadFolder(req, req.params.id, { write: true });
  const body = folderPatchSchema.parse(req.body || {});
  const data = {};
  if (typeof body.name === 'string') data.name = body.name;
  if (body.access !== undefined) {
    const norm = normalizeAccess(body.access);
    data.access = norm;
    data.accessUsers = norm.some(a => a.audience === 'selected') ? (body.accessUsers || []) : [];
  } else if (body.accessUsers !== undefined) {
    data.accessUsers = body.accessUsers;
  }
  await prisma.cloudFolder.update({ where: { id: req.params.id }, data });
  res.json({ ok: true });
}));

// ── DELETE /api/cloud/folders/:id ────────────────────────────────────────
router.delete('/folders/:id', asyncHandler(async (req, res) => {
  const root = await loadFolder(req, req.params.id, { write: true });

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
      const folder = await loadFolder(req, folderId, { write: true });
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
      await loadFolder(req, fid, { write: true });
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

  // Filtra i risultati: nascondi i file che si trovano in cartelle non accessibili.
  let visible = files;
  if (!isSuperAdmin(req)) {
    const tenant = await getTenant(req);
    const folderIds = [...new Set(files.map((d) => d.folderId).filter(Boolean))];
    const accessById = new Map();
    if (folderIds.length) {
      const folders = await prisma.cloudFolder.findMany({
        where: { tenantId: req.tenantId, id: { in: folderIds } },
        select: { id: true, access: true, accessUsers: true, contactId: true },
      });
      for (const f of folders) accessById.set(f.id, f);
    }
    visible = files.filter((d) => {
      if (!d.folderId) return true; // file nella root: visibile
      const f = accessById.get(d.folderId);
      return f ? canSee(req, f, tenant) : true;
    });
  }

  res.json({ files: visible.map((d) => fileView(req, d)) });
}));

// ── GET /api/cloud/users (lista utenti del tenant per audience "Utenti specifici") ──
router.get('/users', asyncHandler(async (req, res) => {
  if (!isAdmin(req)) throw forbidden('Permesso negato');
  const users = await prisma.user.findMany({
    where: { tenantId: req.tenantId },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: 'asc' },
  });
  res.json({ users });
}));

// ── GET /api/cloud/settings (accesso predefinito cartelle-contatto) ───────────
router.get('/settings', asyncHandler(async (req, res) => {
  if (!isAdmin(req)) throw forbidden('Permesso negato');
  const tenant = await getTenant(req);
  res.json({ contactFolderDefault: contactFolderDefault(tenant), systemDefault: CONTACT_FOLDER_DEFAULT });
}));

// ── PUT /api/cloud/settings (solo admin/super admin) ─────────────────────────
router.put('/settings', asyncHandler(async (req, res) => {
  if (!isAdmin(req)) throw forbidden('Solo gli amministratori possono modificare le impostazioni predefinite.');
  const access = accessSchema.parse(req.body?.contactFolderDefault);
  const norm = normalizeAccess(access);
  await prisma.tenant.update({ where: { id: req.tenantId }, data: { cloudFolderDefaults: norm } });
  req._cloudTenant = { cloudFolderDefaults: norm };
  res.json({ ok: true, contactFolderDefault: norm });
}));

// ── POST /api/cloud/contact/:contactId/folder ─────────────────────────────
router.post('/contact/:contactId/folder', asyncHandler(async (req, res) => {
  const contact = await prisma.contact.findFirst({ where: { id: req.params.contactId, tenantId: req.tenantId } });
  if (!contact) throw notFound('Contatto non trovato');

  let folder = await prisma.cloudFolder.findUnique({ where: { contactId: contact.id } }).catch(() => null)
    || await prisma.cloudFolder.findFirst({ where: { tenantId: req.tenantId, contactId: contact.id } });
  if (!folder) {
    // Applica l'accesso predefinito per le cartelle-contatto (admin+utenti, contatto in lettura).
    const tenant = await getTenant(req);
    folder = await prisma.cloudFolder.create({
      data: { tenantId: req.tenantId, name: displayName(contact), contactId: contact.id, parentId: null, access: contactFolderDefault(tenant) },
    });
  }
  res.json({ folderId: folder.id, name: folder.name });
}));

export default router;
