import { defineModule } from '../base.js';

const BASE = 'https://compiler.ai-sophia.it';

async function apiCall(apiKey, method, path, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Compiler API error ${res.status}`);
  return data;
}

export default defineModule({
  key: 'compiler',
  name: 'Compilatore moduli PDF',
  description:
    'Invia moduli PDF compilabili ai contatti e salva automaticamente le compilazioni nel cloud. ' +
    'Utilizza PHI Compiler (compiler.ai-sophia.it) per la generazione e mappatura automatica dei moduli.',
  defaultInstalled: false, // solo super admin può attivarlo
  superAdminOnly: true,
  capabilities: [

    {
      name: 'list_forms',
      description: 'Elenca i moduli PDF disponibili. Usalo per "quali moduli ho?", "che form abbiamo?".',
      parameters: { type: 'object', properties: {} },
      async handler(ctx) {
        const { prisma, tenantId } = ctx;
        const forms = await prisma.compilerForm.findMany({
          where: { tenantId, status: 'ready' },
          orderBy: { createdAt: 'desc' },
        });
        if (!forms.length) return { count: 0, forms: [], message: 'Nessun modulo disponibile. Carica un PDF dal pannello Compilatore.' };
        return { count: forms.length, forms: forms.map(f => ({ id: f.id, name: f.name, templateId: f.templateId, formUrl: f.formUrl })) };
      },
    },

    {
      name: 'send_form',
      description:
        'Invia un modulo PDF compilabile a uno o più contatti via WhatsApp o email. ' +
        'Usalo per "invia il modulo F24 a tutti i nuovi clienti", "manda il form di iscrizione a Mario". ' +
        'Prima usa list_forms per trovare il formId. ' +
        'Se l\'utente vuole fare qualcosa DOPO la compilazione (es. "quando compila mandami la conferma su WhatsApp"), ' +
        'usa il campo onCompleted con l\'istruzione da eseguire a compilazione avvenuta.',
      parameters: {
        type: 'object',
        properties: {
          formId:           { type: 'string', description: 'ID modulo (da list_forms).' },
          contactIds:       { type: 'array', items: { type: 'string' }, description: 'ID contatti specifici.' },
          contactCategory:  { type: 'string', description: 'Categoria contatti (es. "Nuovi clienti") — invia a tutti i contatti di quel gruppo.' },
          channel:          { type: 'string', enum: ['whatsapp', 'email', 'both'], description: 'Canale di invio. Default: whatsapp.' },
          excludeAttachments: { type: 'array', items: { type: 'string' }, description: 'Etichette allegati da NON richiedere (es. se già in possesso).' },
          onCompleted:      { type: 'string', description: 'Istruzione AI da eseguire automaticamente quando il contatto completa la compilazione (es. "invia messaggio WhatsApp di conferma a Mario", "avvisami su WhatsApp che Mario ha compilato il modulo"). Lascia vuoto se non serve.' },
        },
        required: ['formId'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId, config } = ctx;
        const apiKey = config.apiKey;
        if (!apiKey) return { ok: false, message: 'API key PHI Compiler non configurata.' };

        const form = await prisma.compilerForm.findFirst({ where: { id: args.formId, tenantId } });
        if (!form) return { ok: false, message: 'Modulo non trovato.' };

        // Risolvi i contatti
        let contacts = [];
        if (args.contactIds?.length) {
          contacts = await prisma.contact.findMany({ where: { id: { in: args.contactIds }, tenantId } });
        }
        if (args.contactCategory) {
          const byCat = await prisma.contact.findMany({
            where: { tenantId, category: { equals: args.contactCategory, mode: 'insensitive' } },
          });
          contacts = [...new Map([...contacts, ...byCat].map(c => [c.id, c])).values()];
        }
        if (!contacts.length) return { ok: false, message: 'Nessun contatto trovato.' };

        const results = [];
        for (const contact of contacts) {
          try {
            // Genera link personalizzato per questo contatto
            const linkRes = await apiCall(apiKey, 'POST', `/api/v1/forms/${form.templateId}/link`, {
              excludeAttachments: args.excludeAttachments || [],
            });
            const url = linkRes.url;
            const linkId = linkRes.linkId;

            // Invia tramite WhatsApp se disponibile
            const ch = args.channel || 'whatsapp';
            if ((ch === 'whatsapp' || ch === 'both') && contact.phone) {
              const waConfig = await prisma.moduleInstance.findFirst({
                where: { tenantId, moduleKey: 'whatsapp', enabled: true },
              });
              if (waConfig?.config?.accessToken && waConfig?.config?.phoneNumberId) {
                const { accessToken, phoneNumberId } = waConfig.config;
                const text = `📋 *${form.name}*\nCompila il modulo al seguente link:\n${url}`;
                await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    to: contact.phone.replace(/\D/g, ''),
                    type: 'text',
                    text: { body: text },
                  }),
                });
              }
            }

            if ((ch === 'email' || ch === 'both') && contact.email) {
              const emailAccount = await prisma.emailAccount.findFirst({ where: { tenantId, enabled: true } });
              if (emailAccount) {
                const { sendEmailFromAccount } = await import('../../services/emailService.js');
                await sendEmailFromAccount(emailAccount, {
                  to: contact.email,
                  subject: `Modulo da compilare: ${form.name}`,
                  text: `Gentile ${contact.firstName || 'Cliente'},\n\nLe inviamo il modulo "${form.name}" da compilare online:\n${url}\n\nGrazie.`,
                  html: `<p>Gentile ${contact.firstName || 'Cliente'},</p><p>Le inviamo il modulo <strong>${form.name}</strong> da compilare online:</p><p><a href="${url}">${url}</a></p><p>Grazie.</p>`,
                });
              }
            }

            // Se c'è un'istruzione da eseguire dopo la compilazione, crea un task in attesa
            if (args.onCompleted && ctx.conversationId && linkId) {
              const instruction = `[Compilazione modulo "${form.name}" completata da ${[contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || contact.phone}]\n${args.onCompleted}`;
              await prisma.backgroundTask.create({
                data: {
                  tenantId,
                  conversationId: ctx.conversationId,
                  kind: 'ONCE',
                  instruction,
                  // Salviamo il linkId nel payload per trovare questo task quando arriva il webhook
                  payload: { waitForFormLinkId: linkId, formName: form.name, contactId: contact.id },
                  runAt: new Date(Date.now() + 365 * 24 * 3600 * 1000), // lontano nel futuro, verrà anticipato dal webhook
                  status: 'PAUSED', // in attesa dell'evento form.completed
                },
              });
            }

            results.push({ contactId: contact.id, name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || contact.email || contact.phone, url, sent: true });
          } catch (err) {
            results.push({ contactId: contact.id, sent: false, error: err.message });
          }
        }

        const sent = results.filter(r => r.sent).length;
        return {
          ok: true,
          sent,
          total: contacts.length,
          results,
          message: `Modulo "${form.name}" inviato a ${sent}/${contacts.length} contatti.${args.onCompleted ? ' Eseguirò l\'azione richiesta quando verrà compilato.' : ''}`,
        };
      },
    },

    {
      name: 'get_submissions',
      description:
        'Recupera le compilazioni ricevute per un modulo. ' +
        'Usalo per "chi ha compilato il modulo F24?", "mostrami le ultime compilazioni".',
      parameters: {
        type: 'object',
        properties: {
          formId: { type: 'string', description: 'ID modulo (da list_forms). Ometti per tutte.' },
          limit:  { type: 'integer', description: 'Max risultati (default 20).' },
        },
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;
        const where = { tenantId };
        if (args.formId) where.formId = args.formId;
        const subs = await prisma.compilerSubmission.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: Math.min(parseInt(args.limit, 10) || 20, 100),
          include: { form: { select: { name: true } } },
        });
        return {
          count: subs.length,
          submissions: subs.map(s => ({
            id: s.id,
            form: s.form.name,
            email: s.email,
            contactId: s.contactId,
            pdfUrl: s.pdfUrl,
            date: s.createdAt,
          })),
        };
      },
    },

  ],
});
