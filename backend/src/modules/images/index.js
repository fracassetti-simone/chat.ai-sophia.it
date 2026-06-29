import { defineModule } from '../base.js';
import { getOpenAI } from '../../ai/openai.js';
import { prisma } from '../../db/prisma.js';

export default defineModule({
  key: 'images',
  name: 'Generazione immagini',
  description: 'Genera immagini con AI a partire da una descrizione testuale.',
  defaultInstalled: true,
  notice: null,
  defaultConfig: {},
  capabilities: [
    {
      name: 'generate',
      description:
        'Genera un\'immagine a partire da una descrizione testuale. ' +
        'Usalo quando l\'utente chiede di creare, disegnare, generare o illustrare qualcosa. ' +
        'Restituisce un URL pubblico dell\'immagine generata che puoi mostrare o inviare via WhatsApp.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Descrizione dettagliata dell\'immagine da generare (in inglese per risultati migliori)',
          },
          size: {
            type: 'string',
            enum: ['1024x1024', '1536x1024', '1024x1536'],
            description: 'Dimensioni. Default: 1024x1024',
          },
        },
        required: ['prompt'],
      },
      async handler(ctx, args) {
        const openai = getOpenAI();
        const size = args.size || '1024x1024';
        let b64Json = null;

        // Prova gpt-image-2 (non supporta response_format — restituisce b64_json di default)
        try {
          const result = await openai.images.generate({
            model: 'gpt-image-2',
            prompt: args.prompt,
            n: 1,
            size,
          });
          b64Json = result.data[0].b64_json;
        } catch {
          // Fallback a dall-e-3
          try {
            const result2 = await openai.images.generate({
              model: 'dall-e-3',
              prompt: args.prompt,
              n: 1,
              size: '1024x1024',
              response_format: 'b64_json',
            });
            b64Json = result2.data[0].b64_json;
          } catch (err2) {
            throw new Error(`Generazione immagine fallita: ${err2.message}`);
          }
        }

        if (!b64Json) throw new Error('Nessuna immagine generata');

        const buffer = Buffer.from(b64Json, 'base64');
        const doc = await prisma.document.create({
          data: {
            tenant: { connect: { id: ctx.tenantId } },
            filename: `immagine-${Date.now()}.png`,
            mimeType: 'image/png',
            sizeBytes: buffer.length,
            extracted: `Immagine AI: ${args.prompt}`,
            data: buffer,
          },
          select: { id: true },
        });

        const base = process.env.PUBLIC_API_URL || 'https://api.ai-sophia.it';
        const publicUrl = `${base}/api/documents/${doc.id}/file`;

        return {
          ok: true,
          url: publicUrl,
          prompt: args.prompt,
          message: `Immagine generata. URL pubblico: ${publicUrl} — puoi mostrarla con ![img](${publicUrl}) o inviarla su WhatsApp con send_image.`,
        };
      },
    },
  ],
});
