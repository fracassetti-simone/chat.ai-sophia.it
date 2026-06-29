import { PrismaClient } from '@prisma/client';
import { isProd } from '../config/index.js';

// Inizializzazione lazy: il client viene costruito al primo utilizzo reale,
// non all'import. Evita di esaurire le connessioni con l'hot-reload e permette
// di importare i moduli che dipendono da `prisma` senza toccare subito il DB.
const globalForPrisma = globalThis;

function createClient() {
  return new PrismaClient({ log: isProd ? ['error'] : ['warn', 'error'] });
}

function getClient() {
  if (!globalForPrisma.__prisma) globalForPrisma.__prisma = createClient();
  return globalForPrisma.__prisma;
}

// Proxy: inoltra ogni accesso al client reale, costruendolo on-demand.
export const prisma = new Proxy(
  {},
  {
    get(_t, prop) {
      const client = getClient();
      const value = client[prop];
      return typeof value === 'function' ? value.bind(client) : value;
    },
  },
);
