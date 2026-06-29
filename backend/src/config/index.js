import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string(),
  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().default('simone@phi.it'),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(6).default('Ciao123!'),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-5.5'),
  MAX_UPLOAD_MB: z.coerce.number().default(20),
  // Chiave API per OTP via ai-sophia (otp.ai-sophia.it)
  OTP_API_KEY: z.string().optional().default(''),
  // URL pubblico del backend (usato per lo snippet embed)
  PUBLIC_API_URL: z.string().default('https://api.ai-sophia.it'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Errore di configurazione: fallisci subito con un messaggio chiaro.
  console.error('Configurazione non valida:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
