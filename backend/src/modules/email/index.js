import { defineModule } from '../base.js';

export default defineModule({
  key: 'email',
  name: 'Email',
  description: "Permette all'AI di cercare, leggere, inviare e rispondere alle email.",
  defaultInstalled: true, // attivo di default così funziona subito
  capabilities: [

    {
      name: 'find_emails',
      description:
        'Cerca email per mittente, oggetto o parola chiave. ' +
        'Usalo per "trovami le mail di X", "mostrami le email con oggetto Y", "ho email non lette?".',
      parameters: {
        type: 'object',
        properties: {
          query:  { type: 'string',  description: 'Parola chiave nell\'oggetto o nome mittente.' },
          from:   { type: 'string',  description: 'Indirizzo o nome mittente.' },
          unread: { type: 'boolean', description: 'Solo non lette.' },
          limit:  { type: 'integer', description: 'Max risultati (default 10).' },
        },
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;
        const limit = Math.min(parseInt(args.limit, 10) || 10, 50);
        const where = { account: { tenantId } };
        if (args.unread) where.isRead = false;
        const orClauses = [];
        if (args.query) {
          orClauses.push(
            { subject:   { contains: args.query, mode: 'insensitive' } },
            { fromName:  { contains: args.query, mode: 'insensitive' } },
            { fromEmail: { contains: args.query, mode: 'insensitive' } },
          );
        }
        if (args.from) {
          orClauses.push(
            { fromEmail: { contains: args.from, mode: 'insensitive' } },
            { fromName:  { contains: args.from, mode: 'insensitive' } },
          );
        }
        if (orClauses.length > 0) where.OR = orClauses;
        const threads = await prisma.emailThread.findMany({
          where,
          orderBy: { lastMessageAt: 'desc' },
          take: limit,
          include: { messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { bodyText: true, createdAt: true } } },
        });
        return {
          count: threads.length,
          emails: threads.map(t => ({
            id: t.id,
            subject: t.subject,
            from: t.fromName ? `${t.fromName} <${t.fromEmail}>` : t.fromEmail,
            date: t.lastMessageAt,
            isRead: t.isRead,
            preview: t.messages[0]?.bodyText?.slice(0, 200) || '',
          })),
        };
      },
    },

    {
      name: 'read_email',
      description: 'Leggi il contenuto completo di un\'email. Usa l\'id da find_emails.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID del thread email (da find_emails).' },
        },
        required: ['id'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;
        const thread = await prisma.emailThread.findFirst({
          where: { id: args.id, account: { tenantId } },
          include: { messages: { orderBy: { createdAt: 'asc' }, take: 10 } },
        });
        if (!thread) return { ok: false, message: 'Email non trovata.' };
        return {
          id: thread.id,
          subject: thread.subject,
          from: thread.fromName ? `${thread.fromName} <${thread.fromEmail}>` : thread.fromEmail,
          messages: thread.messages.map(m => ({
            role: m.role,
            from: m.fromEmail,
            body: m.bodyText,
            date: m.createdAt,
          })),
        };
      },
    },

    {
      name: 'send_email',
      description:
        'Invia una nuova email, opzionalmente con allegati dal cloud. ' +
        'Usalo per "invia una mail a X", "manda la carta identità via email a X come allegato". ' +
        'Per allegare file usa documentIds con gli ID dei documenti dal cloud.',
      parameters: {
        type: 'object',
        properties: {
          to:          { type: 'string',  description: 'Indirizzo destinatario.' },
          subject:     { type: 'string',  description: 'Oggetto.' },
          body:        { type: 'string',  description: 'Corpo del messaggio.' },
          accountId:   { type: 'string',  description: 'ID account mittente. Se omesso usa il primo disponibile.' },
          documentIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'ID documenti dal cloud da allegare. Ottienili con cloud__find_documents prima di chiamare questo tool.',
          },
        },
        required: ['to', 'subject', 'body'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;

        let account;
        if (args.accountId) {
          account = await prisma.emailAccount.findFirst({ where: { id: args.accountId, tenantId } });
        }
        if (!account) {
          account = await prisma.emailAccount.findFirst({ where: { tenantId, enabled: true } });
        }
        if (!account) return { ok: false, message: 'Nessun account email configurato.' };

        const { sendEmailFromAccount } = await import('../../services/emailService.js');

        let thread = await prisma.emailThread.findFirst({
          where: { accountId: account.id, fromEmail: args.to.toLowerCase() },
          orderBy: { lastMessageAt: 'desc' },
        });
        if (!thread) {
          thread = await prisma.emailThread.create({
            data: { accountId: account.id, subject: args.subject, fromEmail: args.to.toLowerCase(), fromName: args.to, isRead: true },
          });
        }

        const docIds = Array.isArray(args.documentIds) ? args.documentIds : [];

        // Verifica che i documenti esistano nel tenant
        let attachedNames = [];
        if (docIds.length > 0) {
          const docs = await prisma.$queryRawUnsafe(
            `SELECT id, filename FROM "Document" WHERE "tenantId" = $1 AND id = ANY($2::text[])`,
            tenantId, docIds
          );
          attachedNames = docs.map(d => d.filename);
        }

        await sendEmailFromAccount(account, {
          threadId: thread.id,
          to: args.to,
          subject: args.subject,
          text: args.body,
          attachmentDocIds: docIds,
        });

        const attachMsg = attachedNames.length > 0
          ? ` con allegati: ${attachedNames.join(', ')}`
          : '';
        return { ok: true, message: `Email inviata a ${args.to}${attachMsg} dall'account ${account.email}.` };
      },
    },

    {
      name: 'reply_email',
      description: 'Risponde a un\'email esistente. Usa l\'id del thread da find_emails.',
      parameters: {
        type: 'object',
        properties: {
          threadId:    { type: 'string', description: 'ID del thread email.' },
          body:        { type: 'string', description: 'Testo della risposta.' },
          documentIds: { type: 'array', items: { type: 'string' }, description: 'ID documenti cloud da allegare.' },
        },
        required: ['threadId', 'body'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;
        const thread = await prisma.emailThread.findFirst({
          where: { id: args.threadId, account: { tenantId } },
          include: { account: true },
        });
        if (!thread) return { ok: false, message: 'Thread non trovato.' };

        const account = await prisma.emailAccount.findUnique({ where: { id: thread.accountId } });
        if (!account?.smtpHost) return { ok: false, message: 'Account non configurato per l\'invio.' };

        const { sendEmailFromAccount } = await import('../../services/emailService.js');
        const docIds = Array.isArray(args.documentIds) ? args.documentIds : [];

        await sendEmailFromAccount(account, {
          threadId: thread.id,
          to: thread.fromEmail,
          subject: `Re: ${thread.subject}`,
          text: args.body,
          attachmentDocIds: docIds,
        });
        return { ok: true, message: `Risposta inviata a ${thread.fromEmail}${docIds.length ? ` con ${docIds.length} allegato/i` : ''}.` };
      },
    },

    {
      name: 'find_email_accounts',
      description: 'Elenca gli account email disponibili. Usalo per sapere quale accountId usare con send_email.',
      parameters: { type: 'object', properties: {} },
      async handler(ctx) {
        const { prisma, tenantId } = ctx;
        const accounts = await prisma.emailAccount.findMany({
          where: { tenantId, enabled: true },
          select: { id: true, name: true, email: true },
        });
        return { accounts };
      },
    },

  ],
});
