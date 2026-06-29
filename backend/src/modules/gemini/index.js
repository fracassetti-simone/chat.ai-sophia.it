import { z } from 'zod';
import { defineModule } from '../base.js';

const configSchema = z.object({}).optional();

export default defineModule({
  key: 'gemini',
  name: 'Gemini AI',
  description: 'Interroga i manuali e documenti caricati nella sezione Addestramento tramite Google Gemini. La API key viene configurata nella pagina del modulo.',
  defaultInstalled: false,
  notice: null,
  defaultConfig: {},
  configSchema,
  capabilities: [
    {
      name: 'query_manual',
      description:
        'Interroga i manuali e documenti caricati nella sezione Addestramento tramite Google Gemini. ' +
        'Usa questa capability quando l\'utente fa domande su manuali tecnici, guide o documentazione che è stata caricata. ' +
        'Restituisce la risposta estratta dal documento.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'La domanda da porre al documento' },
          documentId: { type: 'string', description: 'ID del documento specifico da interrogare (opzionale; se omesso usa tutti i documenti disponibili)' },
        },
        required: ['question'],
      },
      async handler(ctx, args) {
        const { tenantId, prisma } = ctx;

        const cfg = await prisma.geminiConfig.findUnique({ where: { tenantId } });
        if (!cfg?.apiKey) throw new Error('API key Gemini non configurata. Vai in Moduli → Gemini → Configura.');

        let doc = null;
        if (args.documentId) {
          doc = await prisma.trainingDocument.findFirst({
            where: { id: args.documentId, tenantId },
          });
        } else {
          // Usa il primo documento disponibile
          doc = await prisma.trainingDocument.findFirst({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
          });
        }

        if (!doc) throw new Error('Nessun manuale disponibile. Carica documenti nella sezione Addestramento.');

        const model = cfg.model || 'gemini-2.5-flash';
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.apiKey}`;

        const b64 = Buffer.isBuffer(doc.data) ? doc.data.toString('base64') : doc.data;
        const parts = [
          { inline_data: { mime_type: doc.mimeType || 'application/pdf', data: b64 } },
          { text: `Documento: ${doc.filename}\n\n${args.question}` },
        ];

        const r = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { maxOutputTokens: 2048 },
          }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error?.message || 'Errore Gemini');

        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Nessuna risposta.';
        return { answer, document: doc.filename };
      },
    },
  ],
});
