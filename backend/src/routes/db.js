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

// ── Access level constants ────────────────────────────────────────────────────
const ACCESS_ADMIN          = 'admin';
const ACCESS_ADMIN_USERS    = 'admin_users';
const ACCESS_ADMIN_SELECTED = 'admin_selected';
const VALID_ACCESS = [ACCESS_ADMIN, ACCESS_ADMIN_USERS, ACCESS_ADMIN_SELECTED];

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

async function canManageSchemas(req, cfg) {
  if (isSuperAdmin(req)) return true;
  return !!(cfg?.adminCanCreate);
}

async function canWriteRecords(req, cfg) {
  if (isSuperAdmin(req)) return true;
  return !!(cfg?.adminCanWrite);
}

/** Verifica se l'utente corrente può vedere uno schema */
function userCanSeeSchema(req, schema) {
  if (isSuperAdmin(req)) return true;
  const level = schema.accessLevel || ACCESS_ADMIN;
  if (level === ACCESS_ADMIN_USERS) return true; // tutti gli utenti del tenant
  if (level === ACCESS_ADMIN) return isAdmin(req);
  return isAdmin(req); // admin_selected per schemi: solo admin vede sempre
}

/** Verifica se l'utente corrente può vedere un record */
function userCanSeeRecord(req, record) {
  if (isSuperAdmin(req)) return true;
  const level = record.accessLevel || ACCESS_ADMIN;
  if (level === ACCESS_ADMIN_USERS) return true;
  if (level === ACCESS_ADMIN_SELECTED) {
    const users = Array.isArray(record.accessUsers) ? record.accessUsers : [];
    return isAdmin(req) || users.includes(req.user.id);
  }
  return isAdmin(req); // ACCESS_ADMIN
}

// ── Field validation ──────────────────────────────────────────────────────────

function normalizeFields(rawFields) {
  return (rawFields || []).map((f, i) => ({
    id:       f.id || `f_${Date.now()}_${i}`,
    name:     (f.name || '').trim(),
    label:    (f.label || f.name || '').trim(),
    type:     f.type || 'string',
    required: !!f.required,
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
  const cfg = await assertModuleActive(req);
  if (!await canManageSchemas(req, cfg)) throw forbidden('Non hai il permesso di creare database.');

  const { name, description, icon, showInSidebar, fields: rawFields, accessLevel, defaultRecordAccess } = req.body;
  if (!name?.trim()) throw badRequest('Nome obbligatorio');

  const schema = await prisma.dbSchema.create({
    data: {
      tenantId: req.tenantId,
      name: name.trim(),
      description: description?.trim() || '',
      icon: icon?.trim() || 'server-outline',
      showInSidebar: !!showInSidebar,
      accessLevel: VALID_ACCESS.includes(accessLevel) ? accessLevel : ACCESS_ADMIN,
      defaultRecordAccess: VALID_ACCESS.includes(defaultRecordAccess) ? defaultRecordAccess : ACCESS_ADMIN,
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
  const cfg = await assertModuleActive(req);
  if (!await canManageSchemas(req, cfg)) throw forbidden('Non hai il permesso di modificare database.');

  const existing = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!existing) throw notFound('Database non trovato');

  const { name, description, icon, showInSidebar, fields: rawFields, accessLevel, defaultRecordAccess } = req.body;
  const update = { updatedAt: new Date() };
  if (name?.trim())                        update.name                = name.trim();
  if (description !== undefined)           update.description         = description?.trim() || '';
  if (icon?.trim())                        update.icon                = icon.trim();
  if (showInSidebar !== undefined)         update.showInSidebar       = !!showInSidebar;
  if (VALID_ACCESS.includes(accessLevel))  update.accessLevel         = accessLevel;
  if (VALID_ACCESS.includes(defaultRecordAccess)) update.defaultRecordAccess = defaultRecordAccess;
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
  const cfg = await assertModuleActive(req);
  if (!await canWriteRecords(req, cfg)) throw forbidden('Non hai il permesso di creare record.');

  const schema = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!schema) throw notFound('Database non trovato');
  if (!userCanSeeSchema(req, schema)) throw forbidden('Accesso negato');

  const fields = schema.fields || [];
  const data = req.body?.data || {};
  const accessLevel = VALID_ACCESS.includes(req.body?.accessLevel) ? req.body.accessLevel : (schema.defaultRecordAccess || ACCESS_ADMIN);
  const accessUsers = Array.isArray(req.body?.accessUsers) ? req.body.accessUsers : [];

  const errors = validateRecordData(fields, data);
  if (errors.length) throw badRequest(errors.join('; '));

  const cleaned = {};
  for (const f of fields) {
    const key = f.id || f.name;
    if (data[key] !== undefined) cleaned[key] = data[key];
  }

  const record = await prisma.dbRecord.create({
    data: { schemaId: schema.id, tenantId: req.tenantId, data: cleaned, accessLevel, accessUsers },
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
  const cfg = await assertModuleActive(req);
  if (!await canWriteRecords(req, cfg)) throw forbidden('Non hai il permesso di modificare record.');

  const schema = await prisma.dbSchema.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!schema) throw notFound('Database non trovato');

  const record = await prisma.dbRecord.findFirst({
    where: { id: req.params.rid, schemaId: schema.id, tenantId: req.tenantId },
  });
  if (!record) throw notFound('Record non trovato');
  if (!userCanSeeRecord(req, record)) throw forbidden('Accesso negato');

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
  if (VALID_ACCESS.includes(req.body?.accessLevel)) updateData.accessLevel = req.body.accessLevel;
  if (Array.isArray(req.body?.accessUsers)) updateData.accessUsers = req.body.accessUsers;

  const updated = await prisma.dbRecord.update({ where: { id: record.id }, data: updateData });

  emitToTenant(req.tenantId, 'db:record:updated', { schemaId: schema.id, record: updated });
  res.json({ record: updated });
}));

router.delete('/schemas/:id/records/:rid', asyncHandler(async (req, res) => {
  const cfg = await assertModuleActive(req);
  if (!await canWriteRecords(req, cfg)) throw forbidden('Non hai il permesso di eliminare record.');

  const record = await prisma.dbRecord.findFirst({
    where: { id: req.params.rid, schemaId: req.params.id, tenantId: req.tenantId },
  });
  if (!record) throw notFound('Record non trovato');

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
