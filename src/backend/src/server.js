import { createServer } from 'node:http';
import { config } from './config/index.js';
import { logger } from './config/logger.js';
import { createApp } from './app.js';
import { bootstrapDatabase } from './db/bootstrap.js';
import { registry } from './modules/registry.js';
import { initRealtime } from './realtime/io.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';
import { prisma } from './db/prisma.js';

// ── Protezione globale: impedisce che errori non gestiti crashino il server ──
// Questo cattura qualsiasi errore non gestito (es. ImapFlow timeout)
// e lo logga senza abbattere il processo.
process.on('uncaughtException', (err) => {
  // Non far crashare per errori di rete/socket comuni
  if (err.code === 'ETIMEOUT' || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EPIPE') {
    logger.warn({ code: err.code, message: err.message }, 'Errore di rete ignorato (uncaughtException)');
    return;
  }
  logger.error({ err }, 'Eccezione non gestita — il server continua');
  // NON chiamare process.exit() — il server rimane in piedi
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.warn({ reason: msg }, 'Promise rejection non gestita (ignorata)');
});

async function main() {
  // 1) Scopri e registra i moduli (architettura a plugin).
  await registry.discover();

  // 2) Crea/aggiorna lo schema del database e il primo Super Admin.
  await bootstrapDatabase();

  // 3) Avvia HTTP + WebSocket.
  const app = createApp();
  const server = createServer(app);
  initRealtime(server);

  server.listen(config.PORT, () => {
    logger.info(`Sophia backend in ascolto su http://localhost:${config.PORT}`);
  });

  // Task in background (retry e azioni ricorrenti): girano lato server,
  // indipendentemente dal fatto che l'utente abbia il browser aperto.
  startScheduler();

  const shutdown = async () => {
    logger.info('Arresto in corso…');
    stopScheduler();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Avvio fallito');
  process.exit(1);
});
