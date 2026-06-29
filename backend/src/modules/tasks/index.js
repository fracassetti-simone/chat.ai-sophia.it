import { defineModule } from '../base.js';

// Modulo "Task in background": permette all'AI di impostare azioni ricorrenti
// legate alla conversazione corrente (es. "ogni ora invia questo messaggio su
// WhatsApp" oppure "ogni ora controlla questo e avvisami"). L'esecuzione vera
// e propria è gestita dallo scheduler lato server (src/services/scheduler.js),
// quindi continua a girare anche se l'utente chiude il browser.

const MIN_INTERVAL_SECONDS = 60; // evita azioni ricorrenti troppo aggressive

export default defineModule({
  key: 'tasks',
  name: 'Task in background',
  description:
    'Permette di impostare azioni ricorrenti per questa chat (es. "ogni ora invia questo su WhatsApp") ' +
    'e di gestirle (elenco, annullamento). L\'esecuzione continua anche se l\'utente chiude il browser.',
  defaultInstalled: true,
  defaultConfig: {},
  capabilities: [
    {
      name: 'schedule_recurring_action',
      description:
        'Imposta un\'azione RICORRENTE a intervallo fisso (es. ogni ora, ogni giorno): ' +
        'riesegue l\'istruzione ogni N secondi. ' +
        'Usalo SOLO per azioni temporizzate tipo "ogni ora fai X", "ogni mattina invia Y". ' +
        'NON usarlo per trigger su eventi (messaggi WA, file WA) — per quelli usa create_global_flow.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: 'Istruzione in linguaggio naturale da rieseguire ad ogni intervallo, con tutti i dettagli necessari (testo, destinatario, endpoint, ecc).',
          },
          interval_seconds: {
            type: 'number',
            description: 'Intervallo in secondi tra una esecuzione e la successiva (minimo 60). Es. 3600 per "ogni ora".',
          },
        },
        required: ['instruction', 'interval_seconds'],
      },
      async handler(ctx, args) {
        if (!ctx.conversationId) {
          throw new Error('Le azioni ricorrenti sono disponibili solo all\'interno di una conversazione.');
        }
        const intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, Math.round(Number(args.interval_seconds) || 0));
        const task = await ctx.prisma.backgroundTask.create({
          data: {
            tenantId: ctx.tenantId,
            conversationId: ctx.conversationId,
            kind: 'RECURRING',
            instruction: String(args.instruction || '').slice(0, 4000),
            intervalSeconds,
            runAt: new Date(Date.now() + intervalSeconds * 1000),
            status: 'ACTIVE',
          },
        });
        return {
          ok: true,
          taskId: task.id,
          intervalSeconds,
          nextRunAt: task.runAt,
          message: `Azione ricorrente impostata: ogni ${intervalSeconds}s eseguirò "${task.instruction}".`,
        };
      },
    },
    {
      name: 'list_recurring_actions',
      description: 'Elenca le azioni ricorrenti attive impostate in questa conversazione.',
      parameters: { type: 'object', properties: {}, required: [] },
      async handler(ctx) {
        if (!ctx.conversationId) return { tasks: [] };
        const tasks = await ctx.prisma.backgroundTask.findMany({
          where: { conversationId: ctx.conversationId, kind: 'RECURRING' },
          orderBy: { createdAt: 'desc' },
        });
        return { tasks };
      },
    },
    {
      name: 'cancel_recurring_action',
      description: 'Annulla (status PAUSED) un\'azione ricorrente impostata in questa conversazione, per id.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'id del task da annullare' } },
        required: ['task_id'],
      },
      async handler(ctx, args) {
        const { count } = await ctx.prisma.backgroundTask.updateMany({
          where: { id: args.task_id, tenantId: ctx.tenantId, conversationId: ctx.conversationId },
          data: { status: 'PAUSED' },
        });
        if (!count) throw new Error('Task non trovato in questa conversazione.');
        return { ok: true };
      },
    },

    {
      name: 'schedule_once',
      description:
        'Programma un\'azione che verrà eseguita UNA SOLA VOLTA a una data e ora specifiche. ' +
        'Usalo per "avvisami il 15 giugno alle 9", "manda questo messaggio domani alle 10", ' +
        '"promemoria tra 2 ore". Diverso da schedule_recurring_action che si ripete.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: 'Istruzione in linguaggio naturale da eseguire una sola volta (con tutti i dettagli: testo, destinatario, ecc.).',
          },
          run_at: {
            type: 'string',
            description: 'Data e ora di esecuzione in formato ISO 8601 (es. 2025-06-15T09:00:00+02:00).',
          },
        },
        required: ['instruction', 'run_at'],
      },
      async handler(ctx, args) {
        if (!ctx.conversationId) throw new Error('Le azioni programmate sono disponibili solo all\'interno di una conversazione.');
        const runAt = new Date(args.run_at);
        if (isNaN(runAt.getTime())) throw new Error('Data non valida. Usa il formato ISO 8601 con timezone, es: 2025-06-15T09:00:00+02:00');
        // Grace di 30s per evitare falsi positivi dovuti al tempo di elaborazione AI
        if (runAt < new Date(Date.now() - 30000)) throw new Error(`La data deve essere nel futuro (ricevuto: ${runAt.toLocaleString('it-IT')}). Nota: usa sempre il timezone corretto (+02:00 per ora italiana estiva, +01:00 invernale).`);
        const task = await ctx.prisma.backgroundTask.create({
          data: {
            tenantId: ctx.tenantId,
            conversationId: ctx.conversationId,
            kind: 'ONCE',
            instruction: String(args.instruction || '').slice(0, 4000),
            runAt,
            status: 'ACTIVE',
          },
        });
        return {
          ok: true,
          taskId: task.id,
          runAt: task.runAt.toISOString(),
          localTime: runAt.toLocaleString('it-IT'),
          message: `Azione programmata per ${runAt.toLocaleString('it-IT')}: "${task.instruction.slice(0, 80)}".`,
        };
      },
    },

    {
      name: 'create_global_flow',
      description:
        'Crea un flusso di automazione globale che scatta automaticamente su eventi WhatsApp o widget. ' +
        'USA QUESTO TOOL quando l\'utente dice cose come: ' +
        '"quando ricevo un messaggio WA fai X", ' +
        '"quando arriva un file su WhatsApp mandalo per email a Y", ' +
        '"ogni volta che qualcuno scrive sul widget rispondi Z", ' +
        '"imposta un\'automazione su WhatsApp", ' +
        '"quando ricevo un documento su WhatsApp..." — ' +
        'qualsiasi automazione basata su evento in ingresso WA o widget. ' +
        'Il flusso viene salvato e si attiva automaticamente anche in futuro. ' +
        'TRIGGER: WA_MESSAGE_RECEIVED=qualsiasi msg WA, WA_FILE_RECEIVED=file/foto/doc WA, ' +
        'WA_AUDIO_RECEIVED=audio WA, WIDGET_MESSAGE_RECEIVED=messaggio widget sito. ' +
        'Nell\'istruzione scrivi ESATTAMENTE cosa deve fare il sistema quando scatta il trigger, ' +
        'inclusi destinatari email, testo da inviare, numeri WA, ecc.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome breve del flusso' },
          trigger: {
            type: 'string',
            enum: ['WA_MESSAGE_RECEIVED', 'WA_FILE_RECEIVED', 'WA_AUDIO_RECEIVED', 'WIDGET_MESSAGE_RECEIVED'],
            description: 'Evento che attiva il flusso',
          },
          instruction: {
            type: 'string',
            description: 'Istruzione in linguaggio naturale da eseguire quando il trigger scatta. Includi tutti i dettagli (es. a chi rispondere, come, cosa fare).',
          },
        },
        required: ['name', 'trigger', 'instruction'],
      },
      async handler(ctx, args) {
        // Non permette di creare flussi mentre si sta eseguendo un flusso
        // (evita la duplicazione: un flusso che gira non deve poterne creare altri).
        if (ctx.source === 'FLOW') {
          return { ok: false, message: 'Non è possibile creare flussi durante l\'esecuzione di un flusso.' };
        }
        const flow = await ctx.prisma.flow.create({
          data: {
            tenantId: ctx.tenantId,
            name: String(args.name).slice(0, 120),
            trigger: args.trigger,
            instruction: String(args.instruction).slice(0, 4000),
            status: 'ACTIVE',
          },
        });
        return {
          ok: true,
          flowId: flow.id,
          name: flow.name,
          trigger: flow.trigger,
          message: `Flusso "${flow.name}" creato. Si attiverà automaticamente su: ${flow.trigger}.`,
        };
      },
    },

    {
      name: 'switch_agent',
      description:
        'Cambia l\'agente AI attivo per la conversazione corrente. ' +
        'Usa questo tool quando l\'utente dice cose come: ' +
        '"passami a [nome agente]", "voglio parlare con [nome]", "cambia agente", ' +
        '"parla con [nome]", "passa a [nome]", "chiama [nome]", ' +
        '"attiva [nome]", "usa [nome]" — qualsiasi richiesta di cambiare chi risponde. ' +
        'Funziona su dashboard chat E su WhatsApp. ' +
        'DOPO il cambio, il nuovo agente risponderà a tutti i messaggi successivi.',
      parameters: {
        type: 'object',
        properties: {
          agent_name: {
            type: 'string',
            description: 'Nome (parziale o completo) dell\'agente a cui passare la conversazione.',
          },
        },
        required: ['agent_name'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId, conversationId, source } = ctx;

        // Cerca l'agente per nome (fuzzy)
        const agents = await prisma.agent.findMany({
          where: { tenantId },
          select: { id: true, name: true, avatar: true },
        });
        const query = (args.agent_name || '').toLowerCase().trim();
        const match = agents.find(a => a.name.toLowerCase().includes(query))
          || agents.find(a => query.includes(a.name.toLowerCase()));

        if (!match) {
          const list = agents.map(a => a.name).join(', ');
          return {
            ok: false,
            message: `Agente "${args.agent_name}" non trovato. Agenti disponibili: ${list || 'nessuno'}.`,
          };
        }

        // Determina il contesto (chat interna o esterna)
        if (source === 'WHATSAPP' || source === 'WIDGET') {
          // Cerca la chat esterna associata alla conversazione corrente
          // Nel source WA, conversationId potrebbe non esserci — usiamo il chatId dalla richiesta
          // Passa il chatId nel ctx.chatId se disponibile (vedi whatsapp.js che lo passa come extraContext)
          if (ctx.externalChatId) {
            await prisma.externalChatAgent.upsert({
              where: { chatId: ctx.externalChatId },
              update: { agentId: match.id, assignedAt: new Date() },
              create: { chatId: ctx.externalChatId, agentId: match.id },
            });
            const { emitToTenant } = await import('../../realtime/io.js');
            emitToTenant(tenantId, 'agent:switched', {
              context: 'external-chat', contextId: ctx.externalChatId,
              agentId: match.id, agentName: match.name, agentAvatar: match.avatar,
            });
          }
        } else if (conversationId) {
          await prisma.conversationAgent.upsert({
            where: { conversationId },
            update: { agentId: match.id, assignedAt: new Date() },
            create: { conversationId, agentId: match.id },
          });
          const { emitToTenant } = await import('../../realtime/io.js');
          emitToTenant(tenantId, 'agent:switched', {
            context: 'conversation', contextId: conversationId,
            agentId: match.id, agentName: match.name, agentAvatar: match.avatar,
          });
        }

        return {
          ok: true,
          agentId: match.id,
          agentName: match.name,
          message: `Passaggio a ${match.name} completato. Da ora risponderà ${match.name}.`,
        };
      },
    },

    {
      name: 'delegate_to_agent',
      description:
        'Chiedi a un altro agente di rispondere a una domanda specifica, senza cambiare l\'agente attivo. ' +
        'Usalo quando l\'utente dice cose come: ' +
        '"chiedi ad [agente] ...", "cosa direbbe [agente] su ...", "interpella [agente] per ...". ' +
        'A differenza di switch_agent, la conversazione rimane con l\'agente corrente. ' +
        'Ritorna la risposta dell\'agente delegato che puoi poi presentare all\'utente.',
      parameters: {
        type: 'object',
        properties: {
          agent_name: {
            type: 'string',
            description: 'Nome dell\'agente a cui delegare la domanda.',
          },
          question: {
            type: 'string',
            description: 'La domanda o richiesta da passare all\'altro agente.',
          },
        },
        required: ['agent_name', 'question'],
      },
      async handler(ctx, args) {
        const { prisma, tenantId } = ctx;

        // Cerca l'agente per nome
        const agents = await prisma.agent.findMany({
          where: { tenantId },
          select: { id: true, name: true },
        });
        const query = (args.agent_name || '').toLowerCase().trim();
        const match = agents.find(a => a.name.toLowerCase().includes(query))
          || agents.find(a => query.includes(a.name.toLowerCase()));

        if (!match) {
          const list = agents.map(a => a.name).join(', ');
          return {
            ok: false,
            answer: null,
            message: `Agente "${args.agent_name}" non trovato. Disponibili: ${list || 'nessuno'}.`,
          };
        }

        // Esegui una chiamata AI con il profilo dell'agente delegato
        const { runChat } = await import('../../ai/engine.js');
        let answer = '';
        try {
          await runChat({
            tenantId,
            agentId: match.id,
            source: 'AGENT_DELEGATE',
            history: [{ role: 'user', content: args.question }],
            onToken: (t) => { answer += t; },
          });
        } catch (err) {
          return { ok: false, answer: null, message: `Errore nella delega a ${match.name}: ${err.message}` };
        }

        return {
          ok: true,
          agentName: match.name,
          answer,
          message: `Risposta di ${match.name}: "${answer}"`,
        };
      },
    },

    {
      name: 'list_agents',
      description:
        'Elenca gli agenti AI disponibili per questo tenant. ' +
        'Usalo quando l\'utente chiede "che agenti hai?", "chi c\'è disponibile?", "quali assistenti posso usare?".',
      parameters: { type: 'object', properties: {}, required: [] },
      async handler(ctx) {
        const agents = await ctx.prisma.agent.findMany({
          where: { tenantId: ctx.tenantId },
          select: { id: true, name: true, description: true, isDefault: true },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        });
        if (!agents.length) return { agents: [], message: 'Nessun agente configurato per questo tenant.' };
        return {
          agents: agents.map(a => ({
            id: a.id,
            name: a.name,
            description: a.description || '',
            isDefault: a.isDefault,
          })),
        };
      },
    },

    {
      name: 'remember_user_data',
      description:
        'Memorizza un dato sull\'utente corrente (es. numero di telefono, preferenza, nome del cliente, ecc.). ' +
        'Usalo quando l\'utente dice "ricorda che il mio numero è X", "memorizza che preferisco Y", ' +
        '"il numero di telefono del cliente X è Y". ' +
        'NON usarlo per le chat esterne con clienti finali — solo per l\'utente loggato.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Nome del dato da memorizzare (es. "numero_whatsapp", "nome_cliente_mario", "preferenza_lingua")' },
          value: { type: 'string', description: 'Valore da memorizzare' },
        },
        required: ['key', 'value'],
      },
      async handler(ctx, args) {
        const userId = ctx.userId;
        if (!userId) throw new Error('Nessun utente loggato — impossibile memorizzare dati.');

        const current = await ctx.prisma.userProfile.findUnique({ where: { userId } });
        const memory = { ...(current?.memory || {}), [args.key]: args.value };

        await ctx.prisma.userProfile.upsert({
          where: { userId },
          update: { memory },
          create: { userId, memory },
        });

        return { ok: true, memorized: { [args.key]: args.value }, message: `Ho memorizzato: ${args.key} = ${args.value}` };
      },
    },
  ],
});
