/**
 * API Database personalizzati — v2 con accessLevel per schema e record.
 *
 * AccessLevel valori:
 *   "admin"          → solo admin e super admin
 *   "admin_users"    → admin + tutti gli utenti del tenant
 *   "admin_selected" → admin + lista userId specificata (record.accessUsers)
 *
 * Super Admin: accesso sempre completo.
 *
 * GET    /api/db/schemas                       → lista schemi visibili all'utente
 * POST   /api/db/schemas                       → crea schema (adminCanCreate)
 * GET    /api/db/schemas/:id                   → dettaglio schema
 * PATCH  /api/db/schemas/:id                   → modifica schema
 * DELETE /api/db/schemas/:id                   → elimina schema
 *
 * GET    /api/db/schemas/:id/records           → lista record (filtrata per accessLevel)
 * POST   /api/db/schemas/:id/records           → crea record
 * GET    /api/db/schemas/:id/records/:rid      → dettaglio record
 * PATCH  /api/db/schemas/:id/records/:rid      → aggiorna record
 * DELETE /api/db/schemas/:id/records/:rid      → elimina record
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, forbidden, badRequest } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { emitToTenant } from '../realtime/io.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

// ── Access model (multi-target con permessi) ──────────────────────────────────
// Nuovo modello: array di grant { target, perm }
//   target: 'admin' | 'users' | 'selected' | 'external'
//   perm:   'read' | 'write'
// Memorizzato come JSON-string nelle colonne String accessLevel / defaultRecordAccess.
// Retro-compatibile con i vecchi valori string ('admin', 'admin_users', 'admin_selected').
const ACCESS_TARGETS = ['admin', 'users', 'selected', 'external'];

function legacyToGrants(level) {
  switch (level) {
    case 'admin_users':    return [{ target: 'admin', perm: 'write' }, { target: 'users', perm: 'write' }];
    case 'admin_selected': return [{ target: 'admin', perm: 'write' }, { target: 'selected', perm: 'write' }];
    case 'admin':
    default:               return [{ target: 'admin', perm: 'write' }];
  }
}

/** Interpreta un valore (array, JSON-string o legacy-string) come array di grant. */
function parseGrants(raw) {
  let val = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('[')) { try { val = JSON.parse(t); } catch { val = t; } }
    else return legacyToGrants(t);
  }
  if (Array.isArray(val)) {
    const out = val
      .filter(g => g && ACCESS_TARGETS.includes(g.target))
      .map(g => ({ target: g.target, perm: g.perm === 'write' ? 'write' : 'read' }));
    return out.length ? out : legacyToGrants('admin');
  }
  return legacyToGrants('admin');
}

/** Normalizza grant in arrivo dal client (admin sempre presente, target unici). */
function sanitizeGrants(input) {
  if (!Array.isArray(input)) return null;
  const seen = new Set();
  const out = [];
  for (const g of input) {
    if (!g || !ACCESS_TARGETS.includes(g.target) || seen.has(g.target)) continue;
    seen.add(g.target);
    out.push({ target: g.target, perm: g.perm === 'write' ? 'write' : 'read' });
  }
  if (!out.some(g => g.target === 'admin')) out.unshift({ target: 'admin', perm: 'write' });
  return out;
}

/** Estrae grant da un valore del body (array → sanitize, string → parse, altro → null). */
function grantsFromBody(value) {
  if (Array.isArray(value)) return sanitizeGrants(value);
  if (typeof value === 'string' && value) return parseGrants(value);
  return null;
}

function serializeGrants(grants) { return JSON.stringify(grants || legacyToGrants('admin')); }

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

function isSuperAdmin(req)  { return req.user?.role === 'SUPER_ADMIN'; }
function isAdmin(req)       { return req.user?.role === 'ADMIN' || isSuperAdmin(req); }

async function assertModuleActive(req) {
  if (isSuperAdmin(req)) return {}; // super admin bypassa
  const cfg = await getModuleConfig(req.tenantId);
  if (cfg === null) throw forbidden('Il modulo Database non è attivo per questo tenant.');
  return cfg;
}

// Admin e super admin gestiscono sempre tutto (creano/modificano database e record).
async function canManageSchemas(req) { return isAdmin(req); }
async function canWriteRecords(req)  { return isAdmin(req); }

/**
 * Permesso effettivo dell'utente corrente su un'entità (schema o record).
 * Ritorna 'write' | 'read' | null. Gli utenti esterni non passano da queste rotte.
 */
function accessFor(req, rawAccess, accessUsers) {
  if (isAdmin(req)) return 'write';
  const grants = parseGrants(rawAccess);
  let best = null;
  for (const g of grants) {
    let applies = false;
    if (g.target === 'users') applies = true;
    else if (g.target === 'selected') applies = Array.isArray(accessUsers) && accessUsers.includes(req.user.id);
    // 'admin' gestito sopra, 'external' non si applica agli utenti autenticati
    if (applies) {
      if (g.perm === 'write') return 'write';
      best = best || 'read';
    }
  }
  return best;
}

/** Verifica se l'utente corrente può vedere uno schema */
function userCanSeeSchema(req, schema) {
  return accessFor(req, schema.accessLevel, []) != null;
}

/** Verifica se l'utente corrente può vedere un record */
function userCanSeeRecord(req, record) {
  return accessFor(req, record.accessLevel, record.accessUsers) != null;
}

/** Verifica se l'utente corrente può modificare un record */
function userCanEditRecord(req, record) {
  return accessFor(req, record.accessLevel, record.accessUsers) === 'write';
}

// ── Field validation ──────────────────────────────────────────────────────────

function normalizeFields(rawFields) {
  return (rawFields || []).map((f, i) => ({
    id:       f.id || `f_${Date.now()}_${i}`,
    name:     (f.name || '').trim(),
    label:    (f.label || f.name || '').trim(),
    type:     f.type || 'string',
    required: !!f.required,
    // Visibilità nell'anteprima tabella: default true se non specificato
    showInTable: f.showInTable === undefined ? true : !!f.showInTable,
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

// ═════════════════════════════════════════════════════════════
// SCHEMI
// ═════════════════════════════════════════════════════════════

router.get('/schemas', asyncHandler(async (req, res) => {
  const cfg = await assertModuleActive(req);
  const schemas = await prisma.dbSchema.findMany({
    where: { tenantId: req.tenantId },
    orderBy: { name: 'asc' },
  });
  // Filtra in base all'accessLevel dello schema
  const visible = schemas.filter(s => userCanSeeSchema(req, s));
  res.json({ schemas: visible });
}));

router.post('/schemas', asyncHandler(async (req, res) => {
  await assertModuleActive(req);
  if (!await canManageSchemas(req)) throw forbidden('Non hai il permesso di creare database.');

  const { name, description, icon, showInSidebar, fields: rawFields, access, accessLevel, defaultRecordAccess } = req.body;
  if (!name?.trim()) throw badRequest('Nome obbligatorio');

  const accessGrants  = grantsFromBody(access ?? accessLevel) || legacyToGrants('admin');
  const defaultGrants = grantsFromBody(defaultRecordAccess) || legacyToGrants('admin');

  const schema = await prisma.dbSchema.create({
    data: {
      tenantId: req.tenantId,
      name: name.trim(),
      description: description?.trim() || '',
      icon: icon?.trim() || 'server-outline',
      showInSidebar: !!showInSidebar,
      accessLevel: serializeGrants(accessGrants),
      defaultRecordAccess: serializeGrants(defaultGrants),
      fields: normalizeFields(rawFields),
    },
  });

  emitToTenant(req.tenantId, 'db:schema:created', { schema });
  res.status(201).json({ schema });
}));

router.get('/schemas/:id', asyncHandler(async (req, res) => {
  const cfg = await assertModuleActive(req);
  const schema = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!schema) throw notFound('Database non trovato');
  if (!userCanSeeSchema(req, schema)) throw forbidden('Accesso negato');
  res.json({ schema });
}));

router.patch('/schemas/:id', asyncHandler(async (req, res) => {
  await assertModuleActive(req);
  if (!await canManageSchemas(req)) throw forbidden('Non hai il permesso di modificare database.');

  const existing = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!existing) throw notFound('Database non trovato');

  const { name, description, icon, showInSidebar, fields: rawFields, access, accessLevel, defaultRecordAccess } = req.body;
  const update = { updatedAt: new Date() };
  if (name?.trim())                        update.name                = name.trim();
  if (description !== undefined)           update.description         = description?.trim() || '';
  if (icon?.trim())                        update.icon                = icon.trim();
  if (showInSidebar !== undefined)         update.showInSidebar       = !!showInSidebar;
  const incomingAccess  = grantsFromBody(access ?? accessLevel);
  if (incomingAccess)  update.accessLevel = serializeGrants(incomingAccess);
  const incomingDefault = grantsFromBody(defaultRecordAccess);
  if (incomingDefault) update.defaultRecordAccess = serializeGrants(incomingDefault);
  if (Array.isArray(rawFields)) {
    const existingFields = existing.fields || [];
    update.fields = normalizeFields(rawFields).map(nf => {
      const exF = existingFields.find(ef => ef.name === nf.name || ef.id === nf.id);
      return exF ? { ...nf, id: exF.id } : nf;
    });
  }

  const schema = await prisma.dbSchema.update({ where: { id: req.params.id }, data: update });
  emitToTenant(req.tenantId, 'db:schema:updated', { schema });
  res.json({ schema });
}));

router.delete('/schemas/:id', asyncHandler(async (req, res) => {
  await assertModuleActive(req);
  if (!await canManageSchemas(req)) throw forbidden('Non hai il permesso di eliminare database.');

  const existing = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!existing) throw notFound('Database non trovato');

  await prisma.dbSchema.delete({ where: { id: req.params.id } });
  emitToTenant(req.tenantId, 'db:schema:deleted', { id: req.params.id });
  res.json({ ok: true });
}));

// ═════════════════════════════════════════════════════════════
// RECORD
// ═════════════════════════════════════════════════════════════

router.get('/schemas/:id/records', asyncHandler(async (req, res) => {
  const cfg = await assertModuleActive(req);
  const schema = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!schema) throw notFound('Database non trovato');
  if (!userCanSeeSchema(req, schema)) throw forbidden('Accesso negato');

  const q = (req.query.q || '').toString().trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  let records = await prisma.dbRecord.findMany({
    where: { schemaId: schema.id, tenantId: req.tenantId },
    orderBy: { updatedAt: 'desc' },
    take: 2000,
  });

  // Filtra per accessLevel del singolo record
  records = records.filter(r => userCanSeeRecord(req, r));

  // Ricerca full-text
  if (q) records = records.filter(r => JSON.stringify(r.data || {}).toLowerCase().includes(q));

  const total = records.length;
  records = records.slice((page - 1) * limit, page * limit);

  res.json({ schema: { id: schema.id, name: schema.name, fields: schema.fields, defaultRecordAccess: schema.defaultRecordAccess }, records, total, page, limit });
}));

router.post('/schemas/:id/records', asyncHandler(async (req, res) => {
  await assertModuleActive(req);
  if (!await canWriteRecords(req)) throw forbidden('Non hai il permesso di creare record.');

  const schema = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!schema) throw notFound('Database non trovato');
  if (!userCanSeeSchema(req, schema)) throw forbidden('Accesso negato');

  const fields = schema.fields || [];
  const data = req.body?.data || {};
  const accessGrants = grantsFromBody(req.body?.access ?? req.body?.accessLevel) || parseGrants(schema.defaultRecordAccess);
  const accessUsers = Array.isArray(req.body?.accessUsers) ? req.body.accessUsers : [];

  const errors = validateRecordData(fields, data);
  if (errors.length) throw badRequest(errors.join('; '));

  const cleaned = {};
  for (const f of fields) {
    const key = f.id || f.name;
    if (data[key] !== undefined) cleaned[key] = data[key];
  }

  const record = await prisma.dbRecord.create({
    data: { schemaId: schema.id, tenantId: req.tenantId, data: cleaned, accessLevel: serializeGrants(accessGrants), accessUsers },
  });

  emitToTenant(req.tenantId, 'db:record:created', { schemaId: schema.id, record });
  res.status(201).json({ record });
}));

router.get('/schemas/:id/records/:rid', asyncHandler(async (req, res) => {
  await assertModuleActive(req);
  const record = await prisma.dbRecord.findFirst({
    where: { id: req.params.rid, schemaId: req.params.id, tenantId: req.tenantId },
  });
  if (!record) throw notFound('Record non trovato');
  if (!userCanSeeRecord(req, record)) throw forbidden('Accesso negato');
  res.json({ record });
}));

router.patch('/schemas/:id/records/:rid', asyncHandler(async (req, res) => {
  await assertModuleActive(req);

  const schema = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!schema) throw notFound('Database non trovato');

  const record = await prisma.dbRecord.findFirst({
    where: { id: req.params.rid, schemaId: schema.id, tenantId: req.tenantId },
  });
  if (!record) throw notFound('Record non trovato');
  if (!userCanEditRecord(req, record)) throw forbidden('Non hai il permesso di modificare questo record.');

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
  // Solo gli admin possono cambiare l'accessibilità di un record
  if (isAdmin(req)) {
    const incomingAccess = grantsFromBody(req.body?.access ?? req.body?.accessLevel);
    if (incomingAccess) updateData.accessLevel = serializeGrants(incomingAccess);
    if (Array.isArray(req.body?.accessUsers)) updateData.accessUsers = req.body.accessUsers;
  }

  const updated = await prisma.dbRecord.update({ where: { id: record.id }, data: updateData });

  emitToTenant(req.tenantId, 'db:record:updated', { schemaId: schema.id, record: updated });
  res.json({ record: updated });
}));

router.delete('/schemas/:id/records/:rid', asyncHandler(async (req, res) => {
  await assertModuleActive(req);

  const record = await prisma.dbRecord.findFirst({
    where: { id: req.params.rid, schemaId: req.params.id, tenantId: req.tenantId },
  });
  if (!record) throw notFound('Record non trovato');
  if (!userCanEditRecord(req, record)) throw forbidden('Non hai il permesso di eliminare questo record.');

  await prisma.dbRecord.delete({ where: { id: record.id } });
  emitToTenant(req.tenantId, 'db:record:deleted', { schemaId: req.params.id, id: record.id });
  res.json({ ok: true });
}));

// ── Endpoint: lista utenti del tenant (per selezione "Accessibile a — selezionati") ─
router.get('/users', asyncHandler(async (req, res) => {
  await assertModuleActive(req);
  if (!isAdmin(req)) throw forbidden('Permesso negato');
  const users = await prisma.user.findMany({
    where: { tenants: { some: { id: req.tenantId } } },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: 'asc' },
  });
  res.json({ users });
}));

export default router;
