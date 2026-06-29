import { defineModule } from '../base.js';

export default defineModule({
  key: 'calendar',
  name: 'Calendario',
  description: "Permette all'AI di gestire calendari e appuntamenti.",
  defaultInstalled: true,
  capabilities: [

    // ── CALENDARI ─────────────────────────────────────────────────────────────

    {
      name: 'list_calendars',
      description: "Elenca tutti i calendari dell'utente (nome, colore, default). Usalo quando l'utente chiede 'quali calendari ho'.",
      parameters: { type: 'object', properties: {} },
      async handler(ctx) {
        const { prisma, tenantId, userId } = ctx;
        const [owned, shares] = await Promise.all([
          prisma.calendar.findMany({ where: { tenantId, ownerId: userId }, orderBy: { isDefault: 'desc' } }),
          prisma.calendarShare.findMany({ where: { userId }, include: { calendar: true } }),
        ]);
        return {
          count: owned.length + shares.length,
          calendars: [
            ...owned.map(c => ({ id: c.id, name: c.name, color: c.color, isDefault: c.isDefault, owned: true })),
            ...shares.map(s => ({ id: s.calendar.id, name: s.calendar.name, color: s.calendar.color, isDefault: false, owned: false })),
          ],
        };
      },
    },

    {
      name: 'create_calendar',
      description: "Crea un nuovo calendario con nome e colore.",
      parameters: {
        type: 'object',
        properties: {
          name:  { type: 'string', description: 'Nome calendario (es. "Personale", "Lavoro").' },
          color: { type: 'string', description: 'Colore esadecimale (es. "#16a34a"). Default: #2563eb.' },
        },
        required: ['name'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId, userId } = ctx;
        const existing = await prisma.calendar.findFirst({
          where: { tenantId, ownerId: userId, name: { equals: args.name.trim(), mode: 'insensitive' } },
        });
        if (existing) return { ok: false, message: `Esiste già un calendario "${args.name}".`, id: existing.id };
        const cal = await prisma.calendar.create({
          data: { tenantId, ownerId: userId, name: args.name.trim(), color: args.color || '#2563eb', isDefault: false },
        });
        return { ok: true, id: cal.id, name: cal.name, message: `Calendario "${cal.name}" creato.` };
      },
    },

    {
      name: 'update_calendar',
      description: "Rinomina un calendario o cambia il suo colore. Usa l'id da list_calendars.",
      parameters: {
        type: 'object',
        properties: {
          id:    { type: 'string', description: 'ID calendario.' },
          name:  { type: 'string', description: 'Nuovo nome.' },
          color: { type: 'string', description: 'Nuovo colore esadecimale.' },
        },
        required: ['id'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId, userId } = ctx;
        const cal = await prisma.calendar.findFirst({ where: { id: args.id, tenantId, ownerId: userId } });
        if (!cal) return { ok: false, message: 'Calendario non trovato o non modificabile.' };
        const data = {};
        if (args.name)  data.name  = args.name.trim();
        if (args.color) data.color = args.color;
        await prisma.calendar.update({ where: { id: args.id }, data });
        return { ok: true, message: `Calendario aggiornato in "${data.name || cal.name}".` };
      },
    },

    {
      name: 'delete_calendar',
      description: "Elimina un calendario e tutti i suoi eventi. Non eliminare il calendario di default.",
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'ID calendario.' } },
        required: ['id'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId, userId } = ctx;
        const cal = await prisma.calendar.findFirst({ where: { id: args.id, tenantId, ownerId: userId } });
        if (!cal) return { ok: false, message: 'Calendario non trovato.' };
        if (cal.isDefault) return { ok: false, message: 'Non puoi eliminare il calendario di default.' };
        await prisma.calendarEvent.deleteMany({ where: { calendarId: cal.id } });
        await prisma.calendar.delete({ where: { id: cal.id } });
        return { ok: true, message: `Calendario "${cal.name}" eliminato.` };
      },
    },

    // ── EVENTI ────────────────────────────────────────────────────────────────

    {
      name: 'list_events',
      description: "Elenca gli eventi in un intervallo di date.",
      parameters: {
        type: 'object',
        properties: {
          from:  { type: 'string',  description: 'Data inizio ISO.' },
          to:    { type: 'string',  description: 'Data fine ISO.' },
          limit: { type: 'integer', description: 'Max risultati (default 20).' },
        },
      },
      async handler(ctx, args) {
        const { prisma, tenantId, userId } = ctx;
        const from  = args.from ? new Date(args.from) : new Date();
        const to    = args.to   ? new Date(args.to)   : new Date(from.getTime() + 30 * 86400000);
        const limit = Math.min(parseInt(args.limit, 10) || 20, 100);
        const [owned, shares] = await Promise.all([
          prisma.calendar.findMany({ where: { tenantId, ownerId: userId }, select: { id: true } }),
          prisma.calendarShare.findMany({ where: { userId }, select: { calendarId: true } }),
        ]);
        const ids = [...owned.map(c => c.id), ...shares.map(s => s.calendarId)];
        if (!ids.length) return { events: [], message: 'Nessun calendario trovato.' };
        const events = await prisma.calendarEvent.findMany({
          where: { calendarId: { in: ids }, startAt: { gte: from }, endAt: { lte: to } },
          orderBy: { startAt: 'asc' },
          take: limit,
          include: { calendar: { select: { id: true, name: true, color: true } } },
        });
        return {
          count: events.length,
          events: events.map(e => ({
            id: e.id, title: e.title,
            start: e.startAt.toISOString(), end: e.endAt.toISOString(),
            allDay: e.allDay, location: e.location || null,
            description: e.description || null,
            calendarId: e.calendar.id, calendarName: e.calendar.name,
          })),
        };
      },
    },

    {
      name: 'create_event',
      description: "Crea un appuntamento. Specifica calendarName per usare/creare un calendario specifico. La risposta contiene l'id: usalo con update_event per modifiche immediate.",
      parameters: {
        type: 'object',
        properties: {
          title:        { type: 'string' },
          startAt:      { type: 'string', description: 'ISO 8601 con timezone.' },
          endAt:        { type: 'string', description: 'ISO 8601 con timezone.' },
          description:  { type: 'string' },
          location:     { type: 'string' },
          calendarName: { type: 'string', description: 'Nome calendario. Viene creato se non esiste.' },
          calendarId:   { type: 'string', description: 'ID calendario (alternativa a calendarName).' },
          reminderMin:  { type: 'integer' },
          reminderCh:   { type: 'string', enum: ['dashboard','whatsapp','email'] },
          allDay:       { type: 'boolean' },
        },
        required: ['title', 'startAt', 'endAt'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId, userId } = ctx;
        let cal = null;
        if (args.calendarId) {
          cal = await prisma.calendar.findFirst({ where: { id: args.calendarId, tenantId } });
        }
        if (!cal && args.calendarName?.trim()) {
          const cname = args.calendarName.trim();
          cal = await prisma.calendar.findFirst({
            where: { tenantId, ownerId: userId, name: { equals: cname, mode: 'insensitive' } },
          });
          if (!cal) {
            cal = await prisma.calendar.create({
              data: { tenantId, ownerId: userId, name: cname, color: '#2563eb', isDefault: false },
            });
          }
        }
        if (!cal) {
          cal = await prisma.calendar.findFirst({ where: { tenantId, ownerId: userId, isDefault: true } })
             || await prisma.calendar.findFirst({ where: { tenantId, ownerId: userId } });
        }
        if (!cal) {
          cal = await prisma.calendar.create({
            data: { tenantId, ownerId: userId, name: 'Il mio calendario', isDefault: true, color: '#2563eb' },
          });
        }
        const event = await prisma.calendarEvent.create({
          data: {
            calendarId:  cal.id,
            title:       String(args.title).slice(0, 200),
            startAt:     new Date(args.startAt),
            endAt:       new Date(args.endAt),
            description: args.description || null,
            location:    args.location    || null,
            allDay:      args.allDay      || false,
            reminderMin: args.reminderMin ?? null,
            reminderCh:  args.reminderCh  || (args.reminderMin != null ? 'dashboard' : null),
          },
        });
        return {
          ok: true, id: event.id, title: event.title,
          start: event.startAt.toISOString(), end: event.endAt.toISOString(),
          calendarId: cal.id, calendarName: cal.name,
          message: `Evento "${event.title}" creato nel calendario "${cal.name}".`,
        };
      },
    },

    {
      name: 'update_event',
      description: "Modifica un evento esistente. Usa l'id da list_events o create_event. Puoi anche spostarlo in un altro calendario con calendarName.",
      parameters: {
        type: 'object',
        properties: {
          id:           { type: 'string', description: 'ID evento (obbligatorio).' },
          title:        { type: 'string' },
          startAt:      { type: 'string' },
          endAt:        { type: 'string' },
          description:  { type: 'string' },
          location:     { type: 'string' },
          calendarName: { type: 'string', description: 'Sposta in questo calendario (lo crea se non esiste).' },
          calendarId:   { type: 'string' },
          reminderMin:  { type: 'integer' },
          reminderCh:   { type: 'string', enum: ['dashboard','whatsapp','email'] },
        },
        required: ['id'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId, userId } = ctx;
        const event = await prisma.calendarEvent.findUnique({
          where: { id: args.id }, include: { calendar: true },
        });
        if (!event || event.calendar.tenantId !== tenantId) return { ok: false, message: 'Evento non trovato.' };
        const data = {};
        if (args.title       != null) data.title       = String(args.title).slice(0, 200);
        if (args.startAt     != null) data.startAt     = new Date(args.startAt);
        if (args.endAt       != null) data.endAt       = new Date(args.endAt);
        if (args.description != null) data.description = args.description;
        if (args.location    != null) data.location    = args.location;
        if (args.reminderMin != null) data.reminderMin = args.reminderMin;
        if (args.reminderCh  != null) data.reminderCh  = args.reminderCh;
        if (args.calendarId) {
          const cal = await prisma.calendar.findFirst({ where: { id: args.calendarId, tenantId } });
          if (cal) data.calendarId = cal.id;
        } else if (args.calendarName?.trim()) {
          const cname = args.calendarName.trim();
          let cal = await prisma.calendar.findFirst({
            where: { tenantId, ownerId: userId, name: { equals: cname, mode: 'insensitive' } },
          });
          if (!cal) {
            cal = await prisma.calendar.create({
              data: { tenantId, ownerId: userId, name: cname, color: '#2563eb', isDefault: false },
            });
          }
          data.calendarId = cal.id;
        }
        await prisma.calendarEvent.update({ where: { id: args.id }, data });
        return { ok: true, id: args.id, message: 'Evento aggiornato.' };
      },
    },

    {
      name: 'delete_event',
      description: "Elimina un evento dal calendario.",
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'ID evento.' } },
        required: ['id'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;
        const event = await prisma.calendarEvent.findUnique({
          where: { id: args.id }, include: { calendar: true },
        });
        if (!event || event.calendar.tenantId !== tenantId) return { ok: false, message: 'Evento non trovato.' };
        await prisma.calendarEvent.delete({ where: { id: args.id } });
        return { ok: true, message: `Evento "${event.title}" eliminato.` };
      },
    },

  ],
});
