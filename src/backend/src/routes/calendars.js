import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, badRequest, forbidden } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

// ── Calendari accessibili dall'utente (propri + condivisi) ─────────────────
async function accessibleCalendars(tenantId, userId) {
  const [owned, shared] = await Promise.all([
    prisma.calendar.findMany({ where: { tenantId, ownerId: userId } }),
    prisma.calendarShare.findMany({ where: { userId }, include: { calendar: true } }),
  ]);
  const sharedCals = shared.map((s) => ({ ...s.calendar, canEdit: s.canEdit, isShared: true }));
  return [...owned.map((c) => ({ ...c, canEdit: true, isShared: false })), ...sharedCals];
}

// ── GET /api/calendars ─────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const cals = await accessibleCalendars(req.tenantId, req.user.id);
  res.json({ calendars: cals });
}));

// ── POST /api/calendars ────────────────────────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
  const { name, color } = z.object({
    name: z.string().trim().min(1).max(80),
    color: z.string().trim().max(20).optional(),
  }).parse(req.body || {});
  const cal = await prisma.calendar.create({
    data: { tenantId: req.tenantId, ownerId: req.user.id, name, color: color || '#2563eb' },
  });
  res.status(201).json({ calendar: cal });
}));

// ── PATCH /api/calendars/:id ───────────────────────────────────────────────
router.patch('/:id', asyncHandler(async (req, res) => {
  const { name, color } = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    color: z.string().trim().max(20).optional(),
  }).parse(req.body || {});
  const { count } = await prisma.calendar.updateMany({
    where: { id: req.params.id, tenantId: req.tenantId, ownerId: req.user.id },
    data: { ...(name && { name }), ...(color && { color }) },
  });
  if (!count) throw notFound('Calendario non trovato');
  res.json({ ok: true });
}));

// ── DELETE /api/calendars/:id ──────────────────────────────────────────────
router.delete('/:id', asyncHandler(async (req, res) => {
  const { count } = await prisma.calendar.deleteMany({
    where: { id: req.params.id, tenantId: req.tenantId, ownerId: req.user.id },
  });
  if (!count) throw notFound('Calendario non trovato');
  res.json({ ok: true });
}));

// ── GET /api/calendars/events?from=&to=&calendarId= ───────────────────────
router.get('/events', asyncHandler(async (req, res) => {
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  const to   = req.query.to   ? new Date(req.query.to)   : new Date(Date.now() + 60 * 86400000);

  const cals = await accessibleCalendars(req.tenantId, req.user.id);
  const ids   = req.query.calendarId
    ? [req.query.calendarId]
    : cals.map((c) => c.id);

  const events = await prisma.calendarEvent.findMany({
    where: { calendarId: { in: ids }, startAt: { gte: from }, endAt: { lte: to } },
    orderBy: { startAt: 'asc' },
    include: { calendar: { select: { name: true, color: true } } },
  });

  res.json({ events });
}));

const eventSchema = z.object({
  calendarId:  z.string(),
  title:       z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  location:    z.string().trim().max(300).optional().nullable(),
  startAt:     z.string().datetime(),
  endAt:       z.string().datetime(),
  allDay:      z.boolean().optional(),
  reminderMin: z.number().int().min(0).max(10080).optional().nullable(),
  reminderCh:  z.enum(['dashboard', 'whatsapp', 'email']).optional().nullable(),
  contactId:   z.string().optional().nullable(),
});

// ── POST /api/calendars/events ─────────────────────────────────────────────
router.post('/events', asyncHandler(async (req, res) => {
  const data = eventSchema.parse(req.body || {});
  const cals = await accessibleCalendars(req.tenantId, req.user.id);
  const cal = cals.find((c) => c.id === data.calendarId && c.canEdit);
  if (!cal) throw forbidden('Non hai accesso a questo calendario.');
  if (new Date(data.endAt) <= new Date(data.startAt))
    throw badRequest('La data di fine deve essere successiva a quella di inizio.');
  const event = await prisma.calendarEvent.create({ data });
  res.status(201).json({ event: { ...event, calendar: { name: cal.name, color: cal.color } } });
}));

// ── PATCH /api/calendars/events/:id ───────────────────────────────────────
router.patch('/events/:id', asyncHandler(async (req, res) => {
  const data = eventSchema.partial().parse(req.body || {});
  const event = await prisma.calendarEvent.findUnique({
    where: { id: req.params.id },
    include: { calendar: true },
  });
  if (!event || event.calendar.tenantId !== req.tenantId) throw notFound('Evento non trovato');
  const cals = await accessibleCalendars(req.tenantId, req.user.id);
  if (!cals.find((c) => c.id === event.calendarId && c.canEdit)) throw forbidden('Permesso negato');
  const updated = await prisma.calendarEvent.update({ where: { id: event.id }, data });
  res.json({ event: { ...updated, calendar: { name: event.calendar.name, color: event.calendar.color } } });
}));

// ── DELETE /api/calendars/events/:id ──────────────────────────────────────
router.delete('/events/:id', asyncHandler(async (req, res) => {
  const event = await prisma.calendarEvent.findUnique({
    where: { id: req.params.id },
    include: { calendar: true },
  });
  if (!event || event.calendar.tenantId !== req.tenantId) throw notFound('Evento non trovato');
  const cals = await accessibleCalendars(req.tenantId, req.user.id);
  if (!cals.find((c) => c.id === event.calendarId && c.canEdit)) throw forbidden('Permesso negato');
  await prisma.calendarEvent.delete({ where: { id: event.id } });
  res.json({ ok: true });
}));

export default router;
