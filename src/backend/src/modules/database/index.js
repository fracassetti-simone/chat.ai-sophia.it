/**
 * Modulo Database — database personalizzati per ogni tenant.
 *
 * Il Super Admin configura il modulo impostando nel config:
 *   adminCanCreate: boolean   (default false — solo lettura per admin)
 *   adminCanWrite:  boolean   (default false — solo lettura per admin)
 *
 * AI capabilities:
 *  - db__list_schemas        → elenca tutti i database/schemi del tenant
 *  - db__search_records      → cerca record in un database
 *  - db__get_record          → recupera un record per ID
 *  - db__create_record       → crea un nuovo record (se adminCanWrite o super admin)
 *  - db__update_record       → aggiorna un record (se adminCanWrite o super admin)
 *  - db__delete_record       → elimina un record (se adminCanWrite o super admin)
 *  - db__create_schema       → crea un nuovo schema (se adminCanCreate o super admin)
 */

import { defineModule } from '../base.js';

// ── Validazione di un valore rispetto a un campo ─────────────────────────────
function validateField(field, value) {
  if (value === undefined || value === null || value === '') {
    if (field.required) return `Il campo "${field.label || field.name}" è obbligatorio.`;
    return null; // campo vuoto e non obbligatorio → ok
  }

  const strVal = String(value);

  if (field.type === 'string' || field.type === 'text') {
    if (field.regex) {
      try {
        if (!new RegExp(field.regex).test(strVal)) {
          return `Il campo "${field.label || field.name}" non rispetta il formato richiesto (${field.regex}).`;
        }
      } catch { /* regex non valida, ignora */ }
    }
  }

  if (field.type === 'integer' || field.type === 'decimal') {
    const num = Number(value);
    if (isNaN(num)) return `Il campo "${field.label || field.name}" deve essere un numero.`;
    if (field.type === 'integer' && !Number.isInteger(num)) {
      return `Il campo "${field.label || field.name}" deve essere un numero intero.`;
    }
    if (field.min !== undefined && field.min !== null && num < field.min) {
      return `Il campo "${field.label || field.name}" deve essere ≥ ${field.min}.`;
    }
    if (field.max !== undefined && field.max !== null && num > field.max) {
      return `Il campo "${field.label || field.name}" deve essere ≤ ${field.max}.`;
    }
  }

  if (field.type === 'select' && Array.isArray(field.options) && field.options.length) {
    if (!field.options.includes(strVal)) {
      return `Il campo "${field.label || field.name}" deve essere uno di: ${field.options.join(', ')}.`;
    }
  }

  return null;
}

function validateRecord(fields, data) {
  const errors = [];
  for (const field of fields) {
    const err = validateField(field, data[field.id || field.name]);
    if (err) errors.push(err);
  }
  return errors;
}

// ── Formatta un record per la risposta AI ─────────────────────────────────────
function formatRecord(record, fields) {
  const out = { id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt };
  for (const field of fields) {
    const key = field.id || field.name;
    const val = record.data?.[key];
    if (val !== undefined) out[field.label || field.name] = val;
  }
  return out;
}

// ── Ricerca full-text semplice nei record ─────────────────────────────────────
function recordMatchesQuery(record, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const dataStr = JSON.stringify(record.data || {}).toLowerCase();
  return dataStr.includes(q);
}

// ── Controlla se l'utente ha permesso di scrittura ───────────────────────────
function canWrite(ctx) {
  if (ctx.userRole === 'SUPER_ADMIN') return true;
  return !!(ctx.config?.adminCanWrite);
}

function canCreate(ctx) {
  if (ctx.userRole === 'SUPER_ADMIN') return true;
  return !!(ctx.config?.adminCanCreate);
}

export default defineModule({
  key: 'database',
  name: 'Database',
  description: 'Database personalizzati per il tenant. Permette di creare schemi con campi tipizzati e gestire i record. L\'AI può cercare, leggere, creare e aggiornare record.',
  defaultInstalled: false,
  defaultConfig: {
    adminCanCreate: false, // admin può creare/eliminare schemi
    adminCanWrite: false,  // admin può creare/modificare/eliminare record
  },

  capabilities: [

    // ── Lista schemi ──────────────────────────────────────────────────────────
    {
      name: 'list_schemas',
      description: 'Elenca tutti i database/tabelle disponibili per questo tenant. Usalo per sapere quali database esistono prima di cercare record.',
      parameters: { type: 'object', properties: {}, required: [] },
      async handler(ctx) {
        const schemas = await ctx.prisma.dbSchema.findMany({
          where: { tenantId: ctx.tenantId },
          select: { id: true, name: true, icon: true, description: true, fields: true, showInSidebar: true },
          orderBy: { name: 'asc' },
        });
        return {
          schemas: schemas.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            fields: (s.fields || []).map(f => ({
              name: f.label || f.name,
              type: f.type,
              required: f.required || false,
            })),
          })),
        };
      },
    },

    // ── Cerca record ──────────────────────────────────────────────────────────
    {
      name: 'search_records',
      description:
        'Cerca record in un database specifico. ' +
        'Usa questo tool quando l\'utente dice cose come: ' +
        '"trovami il cliente X", "cerca nel database Y l\'elemento Z", ' +
        '"quanti clienti abbiamo", "mostrami tutti i fornitori attivi". ' +
        'Prima usa db__list_schemas per trovare il database giusto.',
      parameters: {
        type: 'object',
        properties: {
          schema_name: { type: 'string', description: 'Nome del database/schema in cui cercare (es. "Clienti", "Fornitori").' },
          query:       { type: 'string', description: 'Testo da cercare nei record. Lascia vuoto per elencare tutti.' },
          field_name:  { type: 'string', description: 'Nome del campo specifico su cui filtrare (opzionale, es. "Città", "Stato").' },
          field_value: { type: 'string', description: 'Valore esatto da cercare nel campo specificato (opzionale).' },
          limit:       { type: 'integer', description: 'Numero massimo di risultati (default 20, max 100).' },
        },
        required: ['schema_name'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;

        // Trova schema per nome (fuzzy)
        const schemas = await prisma.dbSchema.findMany({ where: { tenantId } });
        const schema = schemas.find(s => s.name.toLowerCase() === (args.schema_name || '').toLowerCase())
          || schemas.find(s => s.name.toLowerCase().includes((args.schema_name || '').toLowerCase()));
        if (!schema) {
          return { ok: false, message: `Database "${args.schema_name}" non trovato. Database disponibili: ${schemas.map(s => s.name).join(', ') || 'nessuno'}.` };
        }

        const fields = (schema.fields || []);
        const limit = Math.min(parseInt(args.limit, 10) || 20, 100);

        let records = await prisma.dbRecord.findMany({
          where: { schemaId: schema.id, tenantId },
          orderBy: { updatedAt: 'desc' },
          take: 200, // filtriamo in memoria per ricerca full-text
        });

        // L'AI accede come super admin — vede tutti i record indipendentemente dall'accessLevel

        // Filtra per query generica
        if (args.query?.trim()) {
          records = records.filter(r => recordMatchesQuery(r, args.query));
        }

        // Filtra per campo specifico
        if (args.field_name?.trim() && args.field_value !== undefined) {
          const targetField = fields.find(f =>
            (f.label || f.name).toLowerCase() === args.field_name.toLowerCase()
          );
          if (targetField) {
            const key = targetField.id || targetField.name;
            const val = String(args.field_value).toLowerCase();
            records = records.filter(r => String(r.data?.[key] || '').toLowerCase().includes(val));
          }
        }

        const total = records.length;
        records = records.slice(0, limit);

        return {
          schema: schema.name,
          total,
          showing: records.length,
          records: records.map(r => formatRecord(r, fields)),
          ...(total === 1 ? { navigateTo: `/database/${schema.id}?open=${records[0].id}`, navigateLabel: `Apri record in ${schema.name}` } : {}),
          ...(total > 1 ? { navigateTo: `/database/${schema.id}`, navigateLabel: `Vai al database ${schema.name}` } : {}),
        };
      },
    },

    // ── Recupera record per ID ─────────────────────────────────────────────────
    {
      name: 'get_record',
      description: 'Recupera un singolo record per ID da un database.',
      parameters: {
        type: 'object',
        properties: {
          record_id: { type: 'string', description: 'ID del record.' },
        },
        required: ['record_id'],
      },
      async handler(ctx, args) {
        const record = await ctx.prisma.dbRecord.findFirst({
          where: { id: args.record_id, tenantId: ctx.tenantId },
          include: { schema: true },
        });
        if (!record) return { ok: false, message: 'Record non trovato.' };
        return {
          ok: true,
          schema: record.schema.name,
          record: formatRecord(record, record.schema.fields || []),
        };
      },
    },

    // ── Crea record ───────────────────────────────────────────────────────────
    {
      name: 'create_record',
      description:
        'Crea un nuovo record in un database. ' +
        'Usa dopo db__list_schemas per conoscere i campi richiesti. ' +
        'Esempio: "aggiungi il cliente Mario Rossi al database Clienti".',
      parameters: {
        type: 'object',
        properties: {
          schema_name: { type: 'string', description: 'Nome del database in cui creare il record.' },
          data: {
            type: 'object',
            description: 'Oggetto con i valori dei campi. Usa i nomi dei campi come chiavi (es. { "Nome": "Mario", "Email": "mario@x.it" }).',
            additionalProperties: true,
          },
        },
        required: ['schema_name', 'data'],
      },
      async handler(ctx, args) {
        if (!canWrite(ctx)) {
          return { ok: false, message: 'Non hai il permesso di creare record in questo database.' };
        }

        const schemas = await ctx.prisma.dbSchema.findMany({ where: { tenantId: ctx.tenantId } });
        const schema = schemas.find(s => s.name.toLowerCase() === (args.schema_name || '').toLowerCase())
          || schemas.find(s => s.name.toLowerCase().includes((args.schema_name || '').toLowerCase()));
        if (!schema) return { ok: false, message: `Database "${args.schema_name}" non trovato.` };

        const fields = schema.fields || [];

        // Mappa nomi/label → id del campo
        const normalizedData = {};
        for (const [key, val] of Object.entries(args.data || {})) {
          const field = fields.find(f =>
            (f.label || f.name).toLowerCase() === key.toLowerCase() ||
            f.name.toLowerCase() === key.toLowerCase() ||
            f.id === key
          );
          if (field) normalizedData[field.id || field.name] = val;
        }

        // Validazione
        const errors = validateRecord(fields, normalizedData);
        if (errors.length) return { ok: false, message: errors.join(' | ') };

        const record = await ctx.prisma.dbRecord.create({
          data: {
            schemaId: schema.id,
            tenantId: ctx.tenantId,
            data: normalizedData,
            accessLevel: schema.defaultRecordAccess || 'admin',
            accessUsers: [],
          },
        });

        return {
          ok: true,
          id: record.id,
          schema: schema.name,
          message: `Record creato nel database "${schema.name}".`,
          record: formatRecord(record, fields),
          navigateTo: `/database/${schema.id}?open=${record.id}`,
          navigateLabel: `Apri in ${schema.name}`,
        };
      },
    },

    // ── Aggiorna record ───────────────────────────────────────────────────────
    {
      name: 'update_record',
      description: 'Aggiorna un record esistente in un database.',
      parameters: {
        type: 'object',
        properties: {
          record_id: { type: 'string', description: 'ID del record da aggiornare.' },
          data: {
            type: 'object',
            description: 'Campi da aggiornare (solo quelli modificati).',
            additionalProperties: true,
          },
        },
        required: ['record_id', 'data'],
      },
      async handler(ctx, args) {
        if (!canWrite(ctx)) return { ok: false, message: 'Non hai il permesso di modificare record.' };

        const record = await ctx.prisma.dbRecord.findFirst({
          where: { id: args.record_id, tenantId: ctx.tenantId },
          include: { schema: true },
        });
        if (!record) return { ok: false, message: 'Record non trovato.' };

        const fields = record.schema.fields || [];

        // Mappa nomi → id
        const patch = {};
        for (const [key, val] of Object.entries(args.data || {})) {
          const field = fields.find(f =>
            (f.label || f.name).toLowerCase() === key.toLowerCase() ||
            f.name.toLowerCase() === key.toLowerCase() ||
            f.id === key
          );
          if (field) patch[field.id || field.name] = val;
        }

        const merged = { ...(record.data || {}), ...patch };
        const errors = validateRecord(fields, merged);
        if (errors.length) return { ok: false, message: errors.join(' | ') };

        const updated = await ctx.prisma.dbRecord.update({
          where: { id: record.id },
          data: { data: merged, updatedAt: new Date() },
        });

        return {
          ok: true,
          id: record.id,
          message: `Record aggiornato nel database "${record.schema.name}".`,
          record: formatRecord(updated, fields),
        };
      },
    },

    // ── Elimina record ────────────────────────────────────────────────────────
    {
      name: 'delete_record',
      description: 'Elimina un record da un database. Chiedi sempre conferma all\'utente prima di eliminare.',
      parameters: {
        type: 'object',
        properties: {
          record_id:    { type: 'string', description: 'ID del record da eliminare.' },
          confirmed:    { type: 'boolean', description: 'Deve essere true — chiedi conferma all\'utente prima di chiamare questo tool.' },
        },
        required: ['record_id', 'confirmed'],
      },
      async handler(ctx, args) {
        if (!canWrite(ctx)) return { ok: false, message: 'Non hai il permesso di eliminare record.' };
        if (!args.confirmed) return { ok: false, message: 'Operazione annullata: conferma richiesta.' };

        const record = await ctx.prisma.dbRecord.findFirst({
          where: { id: args.record_id, tenantId: ctx.tenantId },
          include: { schema: { select: { name: true } } },
        });
        if (!record) return { ok: false, message: 'Record non trovato.' };

        await ctx.prisma.dbRecord.delete({ where: { id: record.id } });
        return { ok: true, message: `Record eliminato dal database "${record.schema.name}".` };
      },
    },

    // ── Crea schema (solo se adminCanCreate) ──────────────────────────────────
    {
      name: 'create_schema',
      description:
        'Crea un nuovo database/schema con i suoi campi. ' +
        'Ogni campo ha: name (nome chiave), label (nome visualizzato), type (string|text|integer|decimal|boolean|date|select), ' +
        'required (bool), regex (per stringhe), min/max (per numeri), options (array per select).',
      parameters: {
        type: 'object',
        properties: {
          name:          { type: 'string', description: 'Nome del database (es. "Clienti Premium").' },
          description:   { type: 'string', description: 'Descrizione opzionale.' },
          icon:          { type: 'string', description: 'Nome icona Ionicons (es. "people-outline", "business-outline"). Default: "server-outline".' },
          showInSidebar: { type: 'boolean', description: 'Se true, appare nella sidebar laterale come voce "Dati".' },
          fields: {
            type: 'array',
            description: 'Lista dei campi del database.',
            items: {
              type: 'object',
              properties: {
                name:     { type: 'string',  description: 'Chiave del campo (snake_case, es. "email_cliente").' },
                label:    { type: 'string',  description: 'Nome visualizzato (es. "Email Cliente").' },
                type:     { type: 'string',  enum: ['string', 'text', 'integer', 'decimal', 'boolean', 'date', 'select'], description: 'Tipo di dato.' },
                required: { type: 'boolean', description: 'Campo obbligatorio.' },
                regex:    { type: 'string',  description: 'Regex di validazione (solo per string/text).' },
                min:      { type: 'number',  description: 'Valore minimo (solo per integer/decimal).' },
                max:      { type: 'number',  description: 'Valore massimo (solo per integer/decimal).' },
                options:  { type: 'array',   items: { type: 'string' }, description: 'Opzioni (solo per select).' },
              },
              required: ['name', 'label', 'type'],
            },
          },
        },
        required: ['name', 'fields'],
      },
      async handler(ctx, args) {
        if (!canCreate(ctx)) {
          return { ok: false, message: 'Non hai il permesso di creare nuovi database. Contatta il Super Admin.' };
        }

        const fields = (args.fields || []).map((f, i) => ({
          id: `f${Date.now()}_${i}`,
          name: f.name,
          label: f.label || f.name,
          type: f.type || 'string',
          required: !!f.required,
          ...(f.regex   ? { regex: f.regex }     : {}),
          ...(f.min !== undefined ? { min: f.min } : {}),
          ...(f.max !== undefined ? { max: f.max } : {}),
          ...(f.options ? { options: f.options } : {}),
        }));

        const schema = await ctx.prisma.dbSchema.create({
          data: {
            tenantId: ctx.tenantId,
            name: args.name,
            description: args.description || '',
            icon: args.icon || 'server-outline',
            showInSidebar: !!args.showInSidebar,
            fields,
          },
        });

        return {
          ok: true,
          id: schema.id,
          name: schema.name,
          message: `Database "${schema.name}" creato con ${fields.length} campi.`,
          navigateTo: `/database/${schema.id}`,
          navigateLabel: `Apri ${schema.name}`,
        };
      },
    },

  ],
});
