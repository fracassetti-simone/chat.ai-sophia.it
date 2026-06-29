import { getOpenAI, MODEL } from '../ai/openai.js';

// Analizza la documentazione (testo estratto da PDF/DOCX/TXT/MD/JSON/YAML/OpenAPI/Swagger)
// e restituisce un elenco strutturato di endpoint pronti per la tabella modificabile.
export async function extractEndpointsFromDocs(text) {
  const openai = getOpenAI();
  const truncated = text.slice(0, 24000);

  const completion = await openai.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Estrai gli endpoint API dalla documentazione fornita. Rispondi SOLO con JSON ' +
          'nel formato {"endpoints":[{"name","description","url","method","category",' +
          '"headers":{},"query":{},"params":{},"body":{},"variables":{},"bearerToken":null}]}. ' +
          'method è uno di GET/POST/PUT/PATCH/DELETE. ' +
          'IMPORTANTE: per ogni valore che nella documentazione è un dato di esempio/mockup, un ' +
          'segnaposto, un token, un ID specifico o un valore che dovrà essere fornito dall\'utente in ' +
          'chat (es. un numero di telefono, un nome prodotto, un importo, una chiave come $OTP_API_KEY), ' +
          'NON inserire il valore letterale in headers/query/params/body: sostituiscilo con {{nome_variabile}} ' +
          '(snake_case, descrittivo) e aggiungi una entry corrispondente in "variables" con un valore di ' +
          'default sensato (stringa vuota se non noto). Lascia invece valori letterali fissi (es. ' +
          '"Content-Type": "application/json") quando non variano mai. Non aggiungere testo fuori dal JSON.',
      },
      { role: 'user', content: truncated },
    ],
  });

  try {
    const parsed = JSON.parse(completion.choices[0].message.content);
    return Array.isArray(parsed.endpoints) ? parsed.endpoints : [];
  } catch {
    return [];
  }
}
