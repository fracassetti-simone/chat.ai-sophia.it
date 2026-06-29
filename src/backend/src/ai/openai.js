import OpenAI from 'openai';
import { config } from '../config/index.js';

// Non mettiamo il client in cache a livello di modulo: in questo modo,
// se la chiave viene aggiornata a runtime (future dashboard), si crea un nuovo client.
export function getOpenAI() {
  const apiKey = config.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY non configurata. Aggiungi la chiave al file .env del backend e riavvia il server.',
    );
  }
  return new OpenAI({ apiKey });
}

export const MODEL = config.OPENAI_MODEL;
