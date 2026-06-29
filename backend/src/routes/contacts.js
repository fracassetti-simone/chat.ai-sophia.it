import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, badRequest } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { normalizePhone } from '../utils/phone.js';
import { contactSearchWhere } from '../utils/contactSearch.js';
import { writeAudit } from '../services/audit.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

const contactSchema = z.object({
  firstName: z.string().trim().max(120).optional().nullable(),
  lastName: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().email().max(200).optional().or(z.literal('')).nullable(),
  company: z.string().trim().max(160).optional().nullable(),
  jobRole: z.string().trim().max(120).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  address: z.string().trim().max(240).optional().nullable(),
  preferences: z.string().trim().max(2000).optional().nullable(),
  category: z.string().trim().max(80).optional().nullable(),
  tags: z.array(z.string().trim().max(40)).max(40).optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
  customFields: z.record(z.string(), z.any()).optional(),
});

// Pulisce e normalizza i dati in ingresso.
function prepare(data) {
  const clean = { ...data };
  if ('phone' in clean) clean.phone = clean.phone ? normalizePhone(clean.phone) : null;
  if ('email' in clean) clean.email = clean.email ? clean.email.toLowerCase() : null;
  if ('tags' in clean && clean.tags) clean.tags = [...new Set(clean.tags.filter(Boolean))];
  // Rimuove stringhe vuote → null per non sporcare il DB
  for (const k of ['firstName', 'lastName', 'company', 'jobRole', 'city', 'address', 'preferences', 'category', 'notes']) {
    if (clean[k] === '') clean[k] = null;
  }
  return clean;
}

function displayName(c) {
  const n = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return n || c.company || c.phone || c.email || 'Senza nome';
}

// GET /api/contacts?q=&category=&tag=
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const category = (req.query.category || '').toString().trim();
    const tag = (req.query.tag || '').toString().trim();

    const where = { tenantId: req.tenantId };
    if (category) where.category = category;
    if (tag) where.tags = { has: tag };
    if (q) Object.assign(where, contactSearchWhere(q));

    const [contacts, all] = await Promise.all([
      prisma.contact.findMany({ where, orderBy: [{ updatedAt: 'desc' }] }),
      // Categorie e tag esistenti, per i filtri (a prescindere dalla ricerca)
      prisma.contact.findMany({
        where: { tenantId: req.tenantId },
        select: { category: true, tags: true },
      }),
    ]);

    const categories = [...new Set(all.map((c) => c.category).filter(Boolean))].sort();
    const tags = [...new Set(all.flatMap((c) => c.tags || []))].sort();

    res.json({
      contacts: contacts.map((c) => ({ ...c, displayName: displayName(c) })),
      categories,
      tags,
      total: contacts.length,
    });
  }),
);

// GET /api/contacts/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!contact) throw notFound('Contatto non trovato');
    res.json({ contact: { ...contact, displayName: displayName(contact) } });
  }),
);

// POST /api/contacts
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = prepare(contactSchema.parse(req.body || {}));
    const hasAny = ['firstName', 'lastName', 'phone', 'email', 'company'].some((k) => data[k]);
    if (!hasAny) throw badRequest('Inserisci almeno nome, telefono, email o azienda.');

    const contact = await prisma.contact.create({
      data: { ...data, tenantId: req.tenantId, source: 'manual' },
    });
    await writeAudit({ tenantId: req.tenantId, userId: req.user.id, req, action: 'contact.create', target: contact.id });
    res.status(201).json({ contact: { ...contact, displayName: displayName(contact) } });
  }),
);

// PATCH /api/contacts/:id
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = prepare(contactSchema.partial().parse(req.body || {}));
    const { count } = await prisma.contact.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data,
    });
    if (!count) throw notFound('Contatto non trovato');
    const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });

    // Sincronizza il nome della cartella cloud con il nome aggiornato del contatto
    if (data.firstName !== undefined || data.lastName !== undefined || data.company !== undefined) {
      const newName = displayName(contact);
      await prisma.cloudFolder.updateMany({
        where: { tenantId: req.tenantId, contactId: req.params.id },
        data: { name: newName },
      });
    }

    await writeAudit({ tenantId: req.tenantId, userId: req.user.id, req, action: 'contact.update', target: req.params.id });
    res.json({ contact: { ...contact, displayName: displayName(contact) } });
  }),
);

// DELETE /api/contacts/:id
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.contact.deleteMany({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!count) throw notFound('Contatto non trovato');
    await writeAudit({ tenantId: req.tenantId, userId: req.user.id, req, action: 'contact.delete', target: req.params.id });
    res.json({ ok: true });
  }),
);

export default router;
