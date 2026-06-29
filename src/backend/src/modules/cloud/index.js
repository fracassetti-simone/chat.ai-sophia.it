import { defineModule } from '../base.js';

function publicUrl(id) {
  const base = process.env.PUBLIC_API_URL || 'http://localhost:4000';
  return `${base}/api/documents/${id}/file`;
}

// ── Controllo accessi cartelle (allineato a routes/cloud.js) ──────────────────
const AUDIENCES = ['admin', 'users', 'selected', 'external'];

function folderAccess(folder) {
  if (Array.isArray(folder?.access) && folder.access.length) {
    return folder.access.filter(a => a && AUDIENCES.includes(a.audience));
  }
  // Default retro-compatibile: visibile a tutti gli utenti del tenant.
  return [{ audience: 'admin', permission: 'write' }, { audience: 'users', permission: 'write' }];
}

// La sessione è "esterna" quando l'AI opera in un canale esterno (widget / WhatsApp), non nella chat interna.
function isExternalCtx(ctx) {
  return !!ctx?.externalChatId || (!!ctx?.source && ctx.source !== 'CHAT');
}

/** Permesso della sessione su una cartella: 'write' | 'read' | null. */
function sessionFolderPermission(ctx, folder) {
  const access = folderAccess(folder);
  const external = isExternalCtx(ctx);
  const selUsers = Array.isArray(folder?.accessUsers) ? folder.accessUsers : [];
  let best = null;
  for (const a of access) {
    let match = false;
    if (external) {
      match = a.audience === 'external';
    } else if (a.audience === 'external') {
      match = false;
    } else if (a.audience === 'selected') {
      match = ctx?.userId ? selUsers.includes(ctx.userId) : true; // interno admin/utente: la chat AI vede comunque
    } else {
      match = true; // admin/users → l'AI interna ha accesso
    }
    if (!match) continue;
    if (a.permission === 'write') return 'write';
    best = best || 'read';
  }
  return best;
}

/** Mappa folderId → folder per i documenti dati, e indica se la sessione può vederli. */
async function buildFolderAccessMap(ctx, docs) {
  const folderIds = [...new Set(docs.map(d => d.folderId).filter(Boolean))];
  const map = new Map();
  if (folderIds.length) {
    const folders = await ctx.prisma.cloudFolder.findMany({
      where: { tenantId: ctx.tenantId, id: { in: folderIds } },
      select: { id: true, access: true, accessUsers: true },
    });
    for (const f of folders) map.set(f.id, f);
  }
  return map;
}

function docVisible(ctx, doc, folderMap) {
  if (!doc.folderId) return true; // root → sempre visibile internamente; esterni vedono solo via cartelle dedicate
  const f = folderMap.get(doc.folderId);
  if (!f) return true;
  return sessionFolderPermission(ctx, f) != null;
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
          `SELECT id, "folderId" FROM "Document" WHERE id = $1 AND "tenantId" = $2 LIMIT 1`,
          args.id, tenantId
        );
        if (!rows.length) return { ok: false, message: 'Documento non trovato.' };
        // Verifica permesso di scrittura sulla cartella del documento.
        const folderMap = await buildFolderAccessMap(ctx, rows);
        if (rows[0].folderId) {
          const f = folderMap.get(rows[0].folderId);
          if (f && sessionFolderPermission(ctx, f) !== 'write') {
            return { ok: false, message: 'Non hai il permesso di rinominare questo documento.' };
          }
        }
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
            `SELECT id, filename, "mimeType", "sizeBytes", "folderId"
             FROM "Document"
             WHERE "tenantId" = $1
               AND ("contactId" = $2 OR "folderId" = $3)
               AND (filename ILIKE $4 OR extracted ILIKE $4)
             ORDER BY "createdAt" DESC LIMIT $5`,
            tenantId, contactId, folderId || '', like, limit
          );
        } else if (contactId) {
          docs = await prisma.$queryRawUnsafe(
            `SELECT id, filename, "mimeType", "sizeBytes", "folderId"
             FROM "Document"
             WHERE "tenantId" = $1
               AND ("contactId" = $2 OR "folderId" = $3)
             ORDER BY "createdAt" DESC LIMIT $4`,
            tenantId, contactId, folderId || '', limit
          );
        } else if (like) {
          docs = await prisma.$queryRawUnsafe(
            `SELECT id, filename, "mimeType", "sizeBytes", "folderId"
             FROM "Document"
             WHERE "tenantId" = $1 AND (filename ILIKE $2 OR extracted ILIKE $2)
             ORDER BY "createdAt" DESC LIMIT $3`,
            tenantId, like, limit
          );
        } else {
          docs = await prisma.$queryRawUnsafe(
            `SELECT id, filename, "mimeType", "sizeBytes", "folderId"
             FROM "Document"
             WHERE "tenantId" = $1
             ORDER BY "createdAt" DESC LIMIT $2`,
            tenantId, limit
          );
        }

        // Nascondi i documenti che si trovano in cartelle non accessibili alla sessione.
        const folderMap = await buildFolderAccessMap(ctx, docs);
        const visibleDocs = docs.filter(d => docVisible(ctx, d, folderMap));

        const navigateTo    = contactId ? `/cloud?contactId=${contactId}` : '/cloud';
        const navigateLabel = contactLabel
          ? `Apri i documenti di ${contactLabel}`
          : query ? `Cerca "${query}" nel Cloud` : 'Apri il Cloud';

        return {
          ok: true,
          contact: contactLabel,
          count: visibleDocs.length,
          documents: visibleDocs.map(d => ({ id: d.id, filename: d.filename, mimeType: d.mimeType, url: publicUrl(d.id) })),
          navigateTo,
          navigateLabel,
        };
      },
    },
    {
      name: 'grant_folder_access',
      description:
        'Concede o revoca a un utente l\'accesso alla cartella documentale di un contatto. ' +
        'Usalo quando un admin dice "garantisci/dai accesso ai file/documenti di [contatto] all\'utente [nome]", ' +
        '"fai vedere i documenti di X a Y", "rimuovi/togli l\'accesso ai documenti di X a Y". ' +
        'Riservato agli amministratori nella dashboard (non disponibile sui canali esterni).',
      parameters: {
        type: 'object',
        properties: {
          contactName: { type: 'string', description: 'Nome del contatto proprietario della cartella documentale (es. "Mario Rossi").' },
          userName:    { type: 'string', description: 'Nome o email dell\'utente a cui concedere/revocare l\'accesso.' },
          permission:  { type: 'string', enum: ['read', 'write'], description: '"read" = sola lettura (default), "write" = accesso completo.' },
          revoke:      { type: 'boolean', description: 'true per REVOCARE l\'accesso invece di concederlo.' },
        },
        required: ['contactName', 'userName'],
      },
      async handler(ctx, args) {
        // Sicurezza: solo admin interni, mai dai canali esterni.
        if (isExternalCtx(ctx)) return { ok: false, message: 'Operazione non consentita da questo canale.' };
        if (ctx.userRole !== 'ADMIN' && ctx.userRole !== 'SUPER_ADMIN') {
          return { ok: false, message: 'Solo un amministratore può modificare i permessi delle cartelle.' };
        }

        const { prisma, tenantId } = ctx;

        // 1) Trova il contatto.
        const cname = `%${String(args.contactName || '').trim()}%`;
        const contacts = await prisma.$queryRawUnsafe(
          `SELECT id, "firstName", "lastName", company FROM "Contact"
           WHERE "tenantId" = $1 AND ("firstName" ILIKE $2 OR "lastName" ILIKE $2 OR company ILIKE $2)
           LIMIT 5`,
          tenantId, cname
        );
        if (!contacts.length) return { ok: false, message: `Nessun contatto trovato con nome "${args.contactName}".` };
        const contact = contacts[0];
        const contactLabel = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || contact.company || args.contactName;

        // 2) Trova la cartella documentale del contatto.
        const folder = await prisma.cloudFolder.findFirst({ where: { tenantId, contactId: contact.id } });
        if (!folder) return { ok: false, message: `Non esiste ancora una cartella documentale per ${contactLabel}.` };

        // 3) Trova l'utente destinatario.
        const term = String(args.userName || '').trim();
        const users = await prisma.user.findMany({
          where: { tenantId, OR: [
            { name:  { contains: term, mode: 'insensitive' } },
            { email: { contains: term, mode: 'insensitive' } },
          ] },
          select: { id: true, name: true, email: true },
          take: 5,
        });
        if (!users.length) return { ok: false, message: `Nessun utente trovato con nome "${args.userName}".` };
        const user = users[0];
        const userLabel = user.name || user.email;

        // 4) Aggiorna il modello di accesso (additivo, gli admin restano sempre inclusi).
        let access = Array.isArray(folder.access) && folder.access.length
          ? folder.access.map(a => ({ ...a }))
          : [{ audience: 'admin', permission: 'write' }, { audience: 'users', permission: 'write' }];
        let accessUsers = Array.isArray(folder.accessUsers) ? folder.accessUsers.slice() : [];

        if (args.revoke) {
          accessUsers = accessUsers.filter(id => id !== user.id);
          if (!accessUsers.length) access = access.filter(a => a.audience !== 'selected');
        } else {
          const perm = args.permission === 'write' ? 'write' : 'read';
          const sel = access.find(a => a.audience === 'selected');
          if (sel) sel.permission = perm;
          else access.push({ audience: 'selected', permission: perm });
          if (!accessUsers.includes(user.id)) accessUsers.push(user.id);
        }
        if (!access.some(a => a.audience === 'admin')) access.unshift({ audience: 'admin', permission: 'write' });

        await prisma.cloudFolder.update({ where: { id: folder.id }, data: { access, accessUsers } });

        return {
          ok: true,
          message: args.revoke
            ? `Accesso ai documenti di ${contactLabel} revocato a ${userLabel}.`
            : `Accesso ai documenti di ${contactLabel} concesso a ${userLabel} (${args.permission === 'write' ? 'accesso completo' : 'sola lettura'}).`,
          navigateTo: `/cloud?contactId=${contact.id}`,
          navigateLabel: `Apri i documenti di ${contactLabel}`,
        };
      },
    },
  ],
});
