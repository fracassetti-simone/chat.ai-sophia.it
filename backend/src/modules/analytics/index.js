import { defineModule } from '../base.js';
import { computeCost } from '../../ai/pricing.js';

// Modulo "Analisi": espone all'AI la consultazione dei consumi token e dei
// costi. È installato di default ma la capability è RISERVATA: risponde con i
// dati solo se la richiesta arriva da un amministratore (ADMIN o SUPER_ADMIN).
// Per chiunque altro (clienti su WhatsApp, widget, ecc.) restituisce un
// diniego, così questi dati non escono mai verso l'esterno.

const SOURCE_LABELS = {
  CHAT: 'Chat dashboard',
  WHATSAPP: 'WhatsApp',
  WIDGET: 'Widget sito',
  EMAIL: 'Email',
  FLOW: 'Automazioni',
  SCHEDULED: 'Azioni programmate',
  TRAINING: 'Addestramento',
};

export default defineModule({
  key: 'analytics',
  name: 'Analisi consumi',
  description: 'Consente all\u2019AI di riferire consumi token e costi agli amministratori.',
  defaultInstalled: true,
  capabilities: [
    {
      name: 'token_usage',
      description:
        'Riepiloga i token consumati e il costo stimato in USD per l\u2019azienda corrente in un periodo. ' +
        'Usa questo strumento quando un amministratore chiede quanto si \u00e8 speso o consumato. ' +
        'Restituisce token di input, input in cache, output e costo totale.',
      parameters: {
        type: 'object',
        properties: {
          days: {
            type: 'integer',
            description: 'Numero di giorni indietro da includere (default 30, massimo 365).',
          },
          source: {
            type: 'string',
            enum: Object.keys(SOURCE_LABELS),
            description: 'Filtra per canale (opzionale).',
          },
        },
      },
      async handler(ctx, args) {
        const role = ctx.userRole;
        if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
          return {
            allowed: false,
            message:
              'I dati di consumo e di costo sono riservati agli amministratori e non possono essere condivisi.',
          };
        }

        const days = Math.min(Math.max(parseInt(args.days, 10) || 30, 1), 365);
        const from = new Date(Date.now() - days * 86400000);
        const where = { tenantId: ctx.tenantId, createdAt: { gte: from } };
        if (args.source && SOURCE_LABELS[args.source]) where.source = args.source;

        const agg = await ctx.prisma.tokenUsage.aggregate({
          where,
          _sum: {
            inputTokens: true,
            cachedInputTokens: true,
            outputTokens: true,
            costUsd: true,
          },
          _count: true,
        });

        const inputTokens = agg._sum.inputTokens || 0;
        const cachedInputTokens = agg._sum.cachedInputTokens || 0;
        const outputTokens = agg._sum.outputTokens || 0;
        const costUsd =
          Math.round((agg._sum.costUsd || 0) * 1e6) / 1e6 ||
          computeCost({ model: 'gpt-5.5', inputTokens, cachedInputTokens, outputTokens });

        return {
          allowed: true,
          periodDays: days,
          channel: args.source ? SOURCE_LABELS[args.source] : 'Tutti i canali',
          inputTokens,
          cachedInputTokens,
          outputTokens,
          totalTokens: inputTokens + cachedInputTokens + outputTokens,
          costUsd,
          costFormatted: `$${costUsd.toFixed(2)}`,
          calls: agg._count || 0,
        };
      },
    },
  ],
});
