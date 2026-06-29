import { defineModule } from '../base.js';
import { normalizePhone } from '../../utils/phone.js';
import { contactSearchWhere } from '../../utils/contactSearch.js';

const STANDARD_FIELDS = ['firstName','lastName','email','company','jobRole','city','address','preferences','category','notes'];

function displayName(c) {
  const n = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return n || c.company || c.phone || c.email || '(senza nome)';
}

export default defineModule({
  key: 'contacts',
  name: 'Rubrica',
  description: "Permette all'AI di salvare e cercare i contatti in rubrica.",
  defaultInstalled: true,
  capabilities: [
    {
      name: 'save_contact',
      description:
        'Crea o aggiorna un contatto in rubrica. ' +
        'Identifica il contatto per telefono, email o ID. ' +
        'I dati da raccogliere configurati (es. codice_fiscale, professione) vanno SEMPRE in customFields, MAI nelle note. ' +
        'Aggiorna solo i campi forniti senza cancellare gli altri.',
      parameters: {
        type: 'object',
        properties: {
          id:          { type: 'string',  description: 'ID contatto esistente (preferire se disponibile).' },
          firstName:   { type: 'string',  description: 'Nome.' },
          lastName:    { type: 'string',  description: 'Cognome.' },
          phone:       { type: 'string',  description: 'Telefono (accetta qualsiasi formato).' },
          email:       { type: 'string',  description: 'Email.' },
          company:     { type: 'string',  description: 'Azienda.' },
          jobRole:     { type: 'string',  description: 'Ruolo.' },
          city:        { type: 'string',  description: 'Città.' },
          address:     { type: 'string',  description: 'Indirizzo.' },
          category:    { type: 'string',  description: 'Categoria (es. "Clienti").' },
          tags:        { type: 'array',   items: { type: 'string' }, description: 'Etichette.' },
          notes:       { type: 'string',  description: 'Note libere generiche. NON usare per dati strutturati.' },
          preferences: { type: 'string',  description: 'Preferenze.' },
          customFields: {
            type: 'object',
            description: 'OBBLIGATORIO per tutti i dati da raccogliere configurati (codice_fiscale, professione, ecc.). Esempio: { "codice_fiscale": "RSSMRA80A01H501Z" }.',
            additionalProperties: { type: 'string' },
          },
        },
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;
        const phone = args.phone ? normalizePhone(args.phone) : null;
        const email = args.email ? String(args.email).toLowerCase().trim() : null;

        // Cerca contatto esistente: prima per ID, poi telefono, poi email
        let existing = null;
        if (args.id) {
          existing = await prisma.contact.findFirst({ where: { id: args.id, tenantId } });
        }
        if (!existing && phone) {
          existing = await prisma.contact.findFirst({ where: { tenantId, phone } });
        }
        if (!existing && email) {
          existing = await prisma.contact.findFirst({ where: { tenantId, email } });
        }

        // Campi standard
        const data = {};
        for (const f of STANDARD_FIELDS) {
          if (typeof args[f] === 'string' && args[f].trim()) data[f] = args[f].trim();
        }
        if (phone) data.phone = phone;
        if (email) data.email = email;

        // customFields: merge con quelli esistenti (non sovrascrivere tutto)
        let mergedCustomFields = {};
        if (existing?.customFields && typeof existing.customFields === 'object') {
          mergedCustomFields = { ...existing.customFields };
        }
        if (args.customFields && typeof args.customFields === 'object') {
          for (const [k, v] of Object.entries(args.customFields)) {
            if (k && v != null && String(v).trim()) {
              mergedCustomFields[k] = String(v).trim();
            }
          }
        }
        if (Object.keys(mergedCustomFields).length > 0) {
          data.customFields = mergedCustomFields;
        }

        if (existing) {
          let tags = existing.tags || [];
          if (Array.isArray(args.tags)) tags = [...new Set([...tags, ...args.tags.filter(Boolean)])];
          const updated = await prisma.contact.update({
            where: { id: existing.id },
            data: { ...data, tags },
          });
          // Sincronizza il nome della cartella cloud
          const newName = displayName(updated);
          await prisma.cloudFolder.updateMany({
            where: { tenantId, contactId: existing.id },
            data: { name: newName },
          }).catch(() => {});
          return { ok: true, action: 'updated', id: updated.id, contact: displayName(updated), customFields: mergedCustomFields };
        }

        // Crea nuovo contatto (anche vuoto se non abbiamo ancora i dati base)
        const created = await prisma.contact.create({
          data: {
            tenantId,
            ...data,
            tags: Array.isArray(args.tags) ? [...new Set(args.tags.filter(Boolean))] : [],
            source: 'ai',
          },
        });
        return { ok: true, action: 'created', id: created.id, contact: displayName(created), customFields: mergedCustomFields };
      },
    },
    {
      name: 'find_contacts',
      description: 'Cerca contatti per nome, telefono, email o azienda.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Testo da cercare.' },
          limit: { type: 'integer', description: 'Max risultati (default 10).' },
        },
        required: ['query'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;
        const q = String(args.query || '').trim();
        if (!q) return { contacts: [] };
        const limit = Math.min(parseInt(args.limit, 10) || 10, 50);
        const contacts = await prisma.contact.findMany({
          where: { tenantId, ...contactSearchWhere(q) },
          take: limit,
          orderBy: { updatedAt: 'desc' },
        });
        const result = {
          count: contacts.length,
          contacts: contacts.map(c => ({
            id: c.id, name: displayName(c), phone: c.phone, email: c.email,
            company: c.company, category: c.category,
            customFields: c.customFields || {},
          })),
        };
        // Se trova esattamente 1 contatto, suggerisci la navigazione alla scheda
        if (contacts.length === 1) {
          result.navigateTo = `/contacts?open=${contacts[0].id}`;
          result.navigateLabel = `Apri scheda di ${displayName(contacts[0])}`;
        } else if (contacts.length > 1) {
          result.navigateTo = `/contacts?q=${encodeURIComponent(q)}`;
          result.navigateLabel = `Vedi tutti i ${contacts.length} contatti trovati`;
        }
        return result;
      },
    },
    {
      name: 'list_contacts',
      description: 'Elenca i contatti (i più recenti). Usa per "che contatti hai?", "quanti contatti ci sono".',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filtra per categoria.' },
          limit:    { type: 'integer', description: 'Max risultati (default 25).' },
        },
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;
        const limit = Math.min(parseInt(args.limit, 10) || 25, 100);
        const where = { tenantId };
        if (args.category?.trim()) where.category = { equals: args.category.trim(), mode: 'insensitive' };
        const [total, contacts] = await Promise.all([
          prisma.contact.count({ where }),
          prisma.contact.findMany({ where, take: limit, orderBy: { updatedAt: 'desc' } }),
        ]);
        return {
          total, showing: contacts.length,
          contacts: contacts.map(c => ({
            name: displayName(c), phone: c.phone, email: c.email,
            company: c.company, category: c.category,
          })),
          navigateTo: '/contacts',
          navigateLabel: 'Vai alla rubrica',
        };
      },
    },
    {
      name: 'list_contacts_by_category',
      description: 'Elenca i contatti di una categoria (es. "Clienti"). Usa per "avvisa tutti i clienti".',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Nome della categoria.' },
        },
        required: ['category'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;
        const category = String(args.category || '').trim();
        if (!category) return { contacts: [] };
        const contacts = await prisma.contact.findMany({
          where: { tenantId, category: { equals: category, mode: 'insensitive' } },
          take: 500,
          select: { id: true, firstName: true, lastName: true, company: true, phone: true, email: true },
        });
        return {
          category, count: contacts.length,
          contacts: contacts.filter(c => c.phone || c.email).map(c => ({
            name: displayName(c), phone: c.phone, email: c.email,
          })),
        };
      },
    },
  ],
});
