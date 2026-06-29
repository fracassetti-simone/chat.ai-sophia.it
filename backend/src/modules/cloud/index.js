import { defineModule } from '../base.js';

function publicUrl(id) {
  const base = process.env.PUBLIC_API_URL || 'http://localhost:4000';
  return `${base}/api/documents/${id}/file`;
}

export default defineModule({
  key: 'cloud',
  name: 'Cloud documentale',
  description: "Permette all'AI di trovare, rinominare e inviare documenti in archivio.",
  defaultInstalled: true,
  capabilities: [
    {
      name: 'rename_document',
      description:
        'Rinomina un file nel cloud. Usa l\'id da find_documents. ' +
        'Usalo quando l\'utente dice "rinomina il file X in Y", "chiamala carta identità", "salvala come...".',
      parameters: {
        type: 'object',
        properties: {
          id:       { type: 'string', description: 'ID del documento (da find_documents).' },
          filename: { type: 'string', description: 'Nuovo nome file (includi l\'estensione se necessario, es. "carta_identità.jpg").' },
        },
        required: ['id', 'filename'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;
        const rows = await prisma.$queryRawUnsafe(
          `SELECT id FROM "Document" WHERE id = $1 AND "tenantId" = $2 LIMIT 1`,
          args.id, tenantId
        );
        if (!rows.length) return { ok: false, message: 'Documento non trovato.' };
        await prisma.$executeRawUnsafe(
          `UPDATE "Document" SET filename = $1 WHERE id = $2 AND "tenantId" = $3`,
          args.filename.trim(), args.id, tenantId
        );
        return { ok: true, message: `File rinominato in "${args.filename.trim()}".` };
      },
    },
    {
      name: 'find_documents',
      description:
        'Cerca documenti nel cloud aziendale. ' +
        'IMPORTANTE: quando l\'utente usa "la mia", "i miei", "il mio" (es. "la mia carta identità", "i miei documenti") ' +
        'NON passare contactName — il sistema usa automaticamente il contatto dell\'utente corrente. ' +
        'Passa contactName SOLO per cercare i documenti di ALTRI (es. "i documenti di Mario Rossi").',
      parameters: {
        type: 'object',
        properties: {
          query:       { type: 'string',  description: 'Parola chiave nel nome file (es. "carta identità", "fattura"). Ometti per vedere tutti i file.' },
          contactName: { type: 'string',  description: 'Nome del TERZO a cui appartengono i documenti. NON usare per l\'utente corrente.' },
          limit:       { type: 'integer', description: 'Max risultati (default 20).' },
        },
      },
      async handler(ctx, args) {
        const { prisma, tenantId, userContactId } = ctx;
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
        const query = String(args.query || '').trim();

        let contactId    = null;
        let folderId     = null;
        let contactLabel = null;

        if (args.contactName?.trim()) {
          // Cerca documenti di un TERZO (es. "i documenti di Mario")
          const name = `%${args.contactName.trim()}%`;
          const rows = await prisma.$queryRawUnsafe(
            `SELECT id, "firstName", "lastName", company, phone FROM "Contact"
             WHERE "tenantId" = $1
               AND ("firstName" ILIKE $2 OR "lastName" ILIKE $2 OR company ILIKE $2)
             LIMIT 5`,
            tenantId, name
          );
          if (!rows.length) return { ok: false, message: `Nessun contatto trovato con nome "${args.contactName.trim()}".` };
          const c = rows[0];
          contactId    = c.id;
          contactLabel = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.company || args.contactName.trim();
        } else if (userContactId) {
          // L'utente parla di SE STESSO: usa il suo contactId
          contactId = userContactId;
          const rows = await prisma.$queryRawUnsafe(
            `SELECT "firstName", "lastName", company FROM "Contact" WHERE id = $1 LIMIT 1`,
            contactId
          );
          if (rows.length) {
            const c = rows[0];
            contactLabel = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.company || 'te';
          }
        }

        // Trova la cartella cloud del contatto
        if (contactId) {
          const folders = await prisma.$queryRawUnsafe(
            `SELECT id FROM "CloudFolder" WHERE "tenantId" = $1 AND "contactId" = $2 LIMIT 1`,
            tenantId, contactId
          );
          if (folders.length) folderId = folders[0].id;
        }

        // Costruisce la query documenti
        let docs = [];
        const like = query ? `%${query}%` : null;

        if (contactId && like) {
          docs = await prisma.$queryRawUnsafe(
            `SELECT id, filename, "mimeType", "sizeBytes"
             FROM "Document"
             WHERE "tenantId" = $1
               AND ("contactId" = $2 OR "folderId" = $3)
               AND (filename ILIKE $4 OR extracted ILIKE $4)
             ORDER BY "createdAt" DESC LIMIT $5`,
            tenantId, contactId, folderId || '', like, limit
          );
        } else if (contactId) {
          docs = await prisma.$queryRawUnsafe(
            `SELECT id, filename, "mimeType", "sizeBytes"
             FROM "Document"
             WHERE "tenantId" = $1
               AND ("contactId" = $2 OR "folderId" = $3)
             ORDER BY "createdAt" DESC LIMIT $4`,
            tenantId, contactId, folderId || '', limit
          );
        } else if (like) {
          docs = await prisma.$queryRawUnsafe(
            `SELECT id, filename, "mimeType", "sizeBytes"
             FROM "Document"
             WHERE "tenantId" = $1 AND (filename ILIKE $2 OR extracted ILIKE $2)
             ORDER BY "createdAt" DESC LIMIT $3`,
            tenantId, like, limit
          );
        } else {
          docs = await prisma.$queryRawUnsafe(
            `SELECT id, filename, "mimeType", "sizeBytes"
             FROM "Document"
             WHERE "tenantId" = $1
             ORDER BY "createdAt" DESC LIMIT $2`,
            tenantId, limit
          );
        }

        const navigateTo    = contactId ? `/cloud?contactId=${contactId}` : '/cloud';
        const navigateLabel = contactLabel
          ? `Apri i documenti di ${contactLabel}`
          : query ? `Cerca "${query}" nel Cloud` : 'Apri il Cloud';

        return {
          ok: true,
          contact: contactLabel,
          count: docs.length,
          documents: docs.map(d => ({ id: d.id, filename: d.filename, mimeType: d.mimeType, url: publicUrl(d.id) })),
          navigateTo,
          navigateLabel,
        };
      },
    },
  ],
});
