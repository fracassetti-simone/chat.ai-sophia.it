/**
 * API Database personalizzati — v3 con modello di accesso multi-audience.
 *
 * Modello "access": array di { audience, permission }
 *   audience:   'admin' | 'users' | 'selected' | 'external'
 *   permission: 'read'  | 'write'
 *
 * Esempi:
 *   [{ audience:'admin', permission:'write' }]                              → solo admin, in scrittura
 *   [{ audience:'admin', permission:'write' }, { audience:'external', permission:'read' }]
 *        → admin tutto, utenti esterni sola lettura
 *
 * 'selected' usa la lista accessUsers (userId).
 * Super Admin: accesso completo sempre.
 *
 * Compatibilità: i vecchi campi accessLevel ('admin'|'admin_users'|'admin_selected')
 * vengono convertiti automaticamente nel nuovo formato.
 *
 * GET    /api/db/schemas                       → lista schemi visibili all'utente
 * POST   /api/db/schemas                       → crea schema (adminCanCreate)
 * GET    /api/db/schemas/:id                   → dettaglio schema
 * PATCH  /api/db/schemas/:id                   → modifica schema
 * DELETE /api/db/schemas/:id                   → elimina schema
 *
 * GET    /api/db/schemas/:id/records           → lista record (filtrata per access)
 * POST   /api/db/schemas/:id/records           → crea record
 * GET    /api/db/schemas/:id/records/:rid      → dettaglio record
 * PATCH  /api/db/schemas/:id/records/:rid      → aggiorna record
 * DELETE /api/db/schemas/:id/records/:rid      → elimina record
 */

import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, forbidden, badRequest } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { emitToTenant } from '../realtime/io.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

// ── Costanti modello di accesso ───────────────────────────────────────────────
const AUDIENCES   = ['admin', 'users', 'selected', 'external'];
const PERMISSIONS = ['read', 'write'];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getModuleConfig(tenantId) {
  try {
    const inst = await prisma.moduleInstance.findUnique({
      where: { tenantId_moduleKey: { tenantId, moduleKey: 'database' } },
    });
    if (!inst?.installed || !inst.enabled) return null; // null = modulo non attivo
    return inst.config || {};
  } catch { return null; }
}

function isSuperAdmin(req) { return req.user?.role === 'SUPER_ADMIN'; }
function isAdmin(req)      { return req.user?.role === 'ADMIN' || isSuperAdmin(req); }

async function assertModuleActive(req) {
  if (isSuperAdmin(req)) return {}; // super admin bypassa
  const cfg = await getModuleConfig(req.tenantId);
  if (cfg === null) throw forbidden('Il modulo Database non è attivo per questo tenant.');
  return cfg;
}

async function canManageSchemas(req, cfg) {
  if (isSuperAdmin(req)) return true;
  return !!(cfg?.adminCanCreate);
}

// ── Normalizzazione / conversione del modello di accesso ──────────────────────

/** Converte il vecchio accessLevel (stringa) nel nuovo formato array. */
function legacyToAccess(level) {
  switch (level) {
    case 'admin_users':
      return [{ audience: 'admin', permission: 'write' }, { audience: 'users', permission: 'read' }];
    case 'admin_selected':
      return [{ audience: 'admin', permission: 'write' }, { audience: 'selected', permission: 'read' }];
    case 'admin':
    default:
      return [{ audience: 'admin', permission: 'write' }];
  }
}

/** Pulisce/normalizza un array di accesso ricevuto dal client. */
function normalizeAccess(raw, fallbackLevel) {
  if (Array.isArray(raw)) {
    const seen = new Set();
    const out = [];
    for (const a of raw) {
      if (!a || !AUDIENCES.includes(a.audience) || seen.has(a.audience)) continue;
      seen.add(a.audience);
      out.push({ audience: a.audience, permission: PERMISSIONS.includes(a.permission) ? a.permission : 'read' });
    }
    if (out.length) return out;
  }
  return legacyToAccess(fallbackLevel);
}

/** Restituisce l'array di accesso effettivo di un oggetto (schema o record). */
function getAccess(obj) {
  if (Array.isArray(obj?.access) && obj.access.length) {
    return obj.access.filter(a => a && AUDIENCES.includes(a.audience));
  }
  return legacyToAccess(obj?.accessLevel);
}

/** Deriva un accessLevel legacy rappresentativo (per retro-compatibilità di UI/AI). */
function accessToLegacy(access) {
  const has = aud => access.some(a => a.audience === aud);
  if (has('selected')) return 'admin_selected';
  if (has('users') || has('external')) return 'admin_users';
  return 'admin';
}

/** Le audience a cui appartiene l'utente autenticato (admin è anche "users"). */
function userAudiences(req) {
  if (req.user?.role === 'ADMIN') return ['admin', 'users'];
  return ['users']; // MEMBER / utente tenant
}

/**
 * Permesso dell'utente su un oggetto: 'write' | 'read' | null (nessun accesso).
 * Super admin → sempre 'write'.
 */
function permissionFor(req, obj) {
  if (isSuperAdmin(req)) return 'write';
  const access = getAccess(obj);
  const auds = userAudiences(req);
  const selUsers = Array.isArray(obj?.accessUsers) ? obj.accessUsers : [];
  let best = null;
  for (const a of access) {
    let match = false;
    if (a.audience === 'selected') match = selUsers.includes(req.user.id);
    else if (a.audience === 'external') match = false; // gli utenti autenticati non sono "esterni"
    else match = auds.includes(a.audience);
    if (!match) continue;
    if (a.permission === 'write') return 'write';
    best = best || 'read';
  }
  return best;
}

function canSee(req, obj)   { return permissionFor(req, obj) != null; }
function canWrite(req, obj) { return permissionFor(req, obj) === 'write'; }

// ── Field validation ──────────────────────────────────────────────────────────

function normalizeFields(rawFields) {
  return (rawFields || []).map((f, i) => ({
    id:       f.id || `f_${Date.now()}_${i}`,
    name:     (f.name || '').trim(),
    label:    (f.label || f.name || '').trim(),
    type:     f.type || 'string',
    required: !!f.required,
    // inTable: visibile nell'anteprima della tabella (default true se non specificato)
    inTable:  f.inTable === undefined ? true : !!f.inTable,
    ...(f.regex !== undefined && f.regex !== null && f.regex !== '' ? { regex: f.regex } : {}),
    ...(f.min !== undefined && f.min !== null ? { min: Number(f.min) } : {}),
    ...(f.max !== undefined && f.max !== null ? { max: Number(f.max) } : {}),
    ...(Array.isArray(f.options) && f.options.length ? { options: f.options } : {}),
  }));
}

function validateRecordData(fields, data) {
  const errors = [];
  for (const field of fields) {
    const key = field.id || field.name;
    const value = data?.[key];
    const empty = value === undefined || value === null || value === '';
    if (empty) {
      if (field.required) errors.push(`"${field.label}" è obbligatorio`);
      continue;
    }
    const strVal = String(value);
    if ((field.type === 'string' || field.type === 'text') && field.regex) {
      try { if (!new RegExp(field.regex).test(strVal)) errors.push(`"${field.label}": formato non valido (regex: ${field.regex})`); }
      catch { /* regex malformata — ignora */ }
    }
    if (field.type === 'integer' || field.type === 'decimal') {
      const n = Number(value);
      if (isNaN(n)) { errors.push(`"${field.label}" deve essere un numero`); continue; }
      if (field.type === 'integer' && !Number.isInteger(n)) errors.push(`"${field.label}" deve essere intero`);
      if (field.min !== undefined && field.min !== null && n < field.min) errors.push(`"${field.label}" minimo: ${field.min}`);
      if (field.max !== undefined && field.max !== null && n > field.max) errors.push(`"${field.label}" massimo: ${field.max}`);
    }
    if (field.type === 'select' && Array.isArray(field.options) && field.options.length) {
      if (!field.options.includes(strVal)) errors.push(`"${field.label}" deve essere: ${field.options.join(', ')}`);
    }
  }
  return errors;
}

/** Aggiunge i campi derivati di accesso a uno schema/record per il client. */
function withAccess(obj) {
  const access = getAccess(obj);
  return { ...obj, access, accessLevel: obj.accessLevel || accessToLegacy(access) };
}

// ═════════════════════════════════════════════════════════════
// SCHEMI
// ═════════════════════════════════════════════════════════════

router.get('/schemas', asyncHandler(async (req, res) => {
  await assertModuleActive(req);
  const schemas = await prisma.dbSchema.findMany({
    where: { tenantId: req.tenantId },
    orderBy: { name: 'asc' },
  });
  const visible = schemas.filter(s => canSee(req, s)).map(withAccess);
  res.json({ schemas: visible });
}));

router.post('/schemas', asyncHandler(async (req, res) => {
  const cfg = await assertModuleActive(req);
  if (!await canManageSchemas(req, cfg)) throw forbidden('Non hai il permesso di creare database.');

  const { name, description, icon, showInSidebar, fields: rawFields, access, defaultRecordAccessList, accessUsers, accessLevel, defaultRecordAccess } = req.body;
  if (!name?.trim()) throw badRequest('Nome obbligatorio');

  const accessList = normalizeAccess(access, accessLevel);
  const defaultList = normalizeAccess(defaultRecordAccessList, defaultRecordAccess);

  const schema = await prisma.dbSchema.create({
    data: {
      tenantId: req.tenantId,
      name: name.trim(),
      description: description?.trim() || '',
      icon: icon?.trim() || 'server-outline',
      showInSidebar: !!showInSidebar,
      access: accessList,
      defaultRecordAccessList: defaultList,
      accessUsers: Array.isArray(accessUsers) ? accessUsers : [],
      accessLevel: accessToLegacy(accessList),
      defaultRecordAccess: accessToLegacy(defaultList),
      fields: normalizeFields(rawFields),
    },
  });

  emitToTenant(req.tenantId, 'db:schema:created', { schema });
  res.status(201).json({ schema: withAccess(schema) });
}));

router.get('/schemas/:id', asyncHandler(async (req, res) => {
  await assertModuleActive(req);
  const schema = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!schema) throw notFound('Database non trovato');
  if (!canSee(req, schema)) throw forbidden('Accesso negato');
  res.json({ schema: withAccess(schema) });
}));

router.patch('/schemas/:id', asyncHandler(async (req, res) => {
  const cfg = await assertModuleActive(req);
  if (!await canManageSchemas(req, cfg)) throw forbidden('Non hai il permesso di modificare database.');

  const existing = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!existing) throw notFound('Database non trovato');

  const { name, description, icon, showInSidebar, fields: rawFields, access, defaultRecordAccessList, accessUsers, accessLevel, defaultRecordAccess } = req.body;
  const update = { updatedAt: new Date() };
  if (name?.trim())                update.name          = name.trim();
  if (description !== undefined)   update.description   = description?.trim() || '';
  if (icon?.trim())                update.icon          = icon.trim();
  if (showInSidebar !== undefined) update.showInSidebar = !!showInSidebar;
  if (Array.isArray(accessUsers))  update.accessUsers   = accessUsers;

  if (access !== undefined || accessLevel !== undefined) {
    const accessList = normalizeAccess(access, accessLevel);
    update.access = accessList;
    update.accessLevel = accessToLegacy(accessList);
  }
  if (defaultRecordAccessList !== undefined || defaultRecordAccess !== undefined) {
    const defaultList = normalizeAccess(defaultRecordAccessList, defaultRecordAccess);
    update.defaultRecordAccessList = defaultList;
    update.defaultRecordAccess = accessToLegacy(defaultList);
  }

  if (Array.isArray(rawFields)) {
    const existingFields = existing.fields || [];
    update.fields = normalizeFields(rawFields).map(nf => {
      const exF = existingFields.find(ef => ef.name === nf.name || ef.id === nf.id);
      return exF ? { ...nf, id: exF.id } : nf;
    });
  }

  const schema = await prisma.dbSchema.update({ where: { id: req.params.id }, data: update });
  emitToTenant(req.tenantId, 'db:schema:updated', { schema });
  res.json({ schema: withAccess(schema) });
}));

router.delete('/schemas/:id', asyncHandler(async (req, res) => {
  const cfg = await assertModuleActive(req);
  if (!await canManageSchemas(req, cfg)) throw forbidden('Non hai il permesso di eliminare database.');

  const existing = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!existing) throw notFound('Database non trovato');

  await prisma.dbSchema.delete({ where: { id: req.params.id } });
  emitToTenant(req.tenantId, 'db:schema:deleted', { id: req.params.id });
  res.json({ ok: true });
}));

// ═════════════════════════════════════════════════════════════
// RECORD
// ═════════════════════════════════════════════════════════════

/** Accesso predefinito da usare per un nuovo record di uno schema. */
function schemaDefaultRecordAccess(schema) {
  if (Array.isArray(schema.defaultRecordAccessList) && schema.defaultRecordAccessList.length) {
    return schema.defaultRecordAccessList;
  }
  return legacyToAccess(schema.defaultRecordAccess);
}

router.get('/schemas/:id/records', asyncHandler(async (req, res) => {
  await assertModuleActive(req);
  const schema = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!schema) throw notFound('Database non trovato');
  if (!canSee(req, schema)) throw forbidden('Accesso negato');

  const q = (req.query.q || '').toString().trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  let records = await prisma.dbRecord.findMany({
    where: { schemaId: schema.id, tenantId: req.tenantId },
    orderBy: { updatedAt: 'desc' },
    take: 2000,
  });

  // Filtra per accesso del singolo record
  records = records.filter(r => canSee(req, r)).map(withAccess);

  // Ricerca full-text
  if (q) records = records.filter(r => JSON.stringify(r.data || {}).toLowerCase().includes(q));

  const total = records.length;
  records = records.slice((page - 1) * limit, page * limit);

  res.json({
    schema: {
      id: schema.id, name: schema.name, fields: schema.fields,
      access: getAccess(schema),
      accessUsers: Array.isArray(schema.accessUsers) ? schema.accessUsers : [],
      defaultRecordAccess: schemaDefaultRecordAccess(schema),
      canWrite: canWrite(req, schema),
    },
    records, total, page, limit,
  });
}));

router.post('/schemas/:id/records', asyncHandler(async (req, res) => {
  await assertModuleActive(req);

  const schema = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!schema) throw notFound('Database non trovato');
  if (!canSee(req, schema)) throw forbidden('Accesso negato');
  if (!canWrite(req, schema)) throw forbidden('Non hai il permesso di creare record in questo database.');

  const fields = schema.fields || [];
  const data = req.body?.data || {};
  const accessList = normalizeAccess(req.body?.access, req.body?.accessLevel);
  const finalAccess = (Array.isArray(req.body?.access) || req.body?.accessLevel) ? accessList : schemaDefaultRecordAccess(schema);
  const accessUsers = Array.isArray(req.body?.accessUsers) ? req.body.accessUsers : [];

  const errors = validateRecordData(fields, data);
  if (errors.length) throw badRequest(errors.join('; '));

  const cleaned = {};
  for (const f of fields) {
    const key = f.id || f.name;
    if (data[key] !== undefined) cleaned[key] = data[key];
  }

  const record = await prisma.dbRecord.create({
    data: {
      schemaId: schema.id, tenantId: req.tenantId, data: cleaned,
      access: finalAccess, accessLevel: accessToLegacy(finalAccess), accessUsers,
    },
  });

  emitToTenant(req.tenantId, 'db:record:created', { schemaId: schema.id, record });
  res.status(201).json({ record: withAccess(record) });
}));

router.get('/schemas/:id/records/:rid', asyncHandler(async (req, res) => {
  await assertModuleActive(req);
  const record = await prisma.dbRecord.findFirst({
    where: { id: req.params.rid, schemaId: req.params.id, tenantId: req.tenantId },
  });
  if (!record) throw notFound('Record non trovato');
  if (!canSee(req, record)) throw forbidden('Accesso negato');
  res.json({ record: withAccess(record) });
}));

router.patch('/schemas/:id/records/:rid', asyncHandler(async (req, res) => {
  await assertModuleActive(req);

  const schema = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!schema) throw notFound('Database non trovato');

  const record = await prisma.dbRecord.findFirst({
    where: { id: req.params.rid, schemaId: schema.id, tenantId: req.tenantId },
  });
  if (!record) throw notFound('Record non trovato');
  if (!canSee(req, record)) throw forbidden('Accesso negato');
  if (!canWrite(req, record)) throw forbidden('Non hai il permesso di modificare questo record.');

  const fields = schema.fields || [];
  const patch = req.body?.data || {};
  const merged = { ...(record.data || {}), ...patch };

  const cleaned = {};
  for (const f of fields) {
    const key = f.id || f.name;
    if (merged[key] !== undefined) cleaned[key] = merged[key];
  }

  const errors = validateRecordData(fields, cleaned);
  if (errors.length) throw badRequest(errors.join('; '));

  const updateData = { data: cleaned, updatedAt: new Date() };
  if (Array.isArray(req.body?.access) || req.body?.accessLevel !== undefined) {
    const accessList = normalizeAccess(req.body?.access, req.body?.accessLevel);
    updateData.access = accessList;
    updateData.accessLevel = accessToLegacy(accessList);
  }
  if (Array.isArray(req.body?.accessUsers)) updateData.accessUsers = req.body.accessUsers;

  const updated = await prisma.dbRecord.update({ where: { id: record.id }, data: updateData });

  emitToTenant(req.tenantId, 'db:record:updated', { schemaId: schema.id, record: updated });
  res.json({ record: withAccess(updated) });
}));

router.delete('/schemas/:id/records/:rid', asyncHandler(async (req, res) => {
  await assertModuleActive(req);

  const record = await prisma.dbRecord.findFirst({
    where: { id: req.params.rid, schemaId: req.params.id, tenantId: req.tenantId },
  });
  if (!record) throw notFound('Record non trovato');
  if (!canSee(req, record)) throw forbidden('Accesso negato');
  if (!canWrite(req, record)) throw forbidden('Non hai il permesso di eliminare questo record.');

  await prisma.dbRecord.delete({ where: { id: record.id } });
  emitToTenant(req.tenantId, 'db:record:deleted', { schemaId: req.params.id, id: record.id });
  res.json({ ok: true });
}));

// ── Endpoint: lista utenti del tenant (per audience "Utenti specifici") ─────────
router.get('/users', asyncHandler(async (req, res) => {
  await assertModuleActive(req);
  if (!isAdmin(req)) throw forbidden('Permesso negato');
  const users = await prisma.user.findMany({
    where: { tenantId: req.tenantId },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: 'asc' },
  });
  res.json({ users });
}));

export default router;
