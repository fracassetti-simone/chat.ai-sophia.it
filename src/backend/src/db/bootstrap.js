import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from './prisma.js';
import { logger } from '../config/logger.js';
import { seedSuperAdmin } from '../../prisma/seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../prisma/migrations');

// Esistono migrazioni versionate committate nel progetto?
function hasMigrations() {
  try {
    if (!existsSync(migrationsDir)) return false;
    return readdirSync(migrationsDir).some(
      (f) => !f.startsWith('.') && f !== 'migration_lock.toml',
    );
  } catch {
    return false;
  }
}

// Requisito di spec: al primo avvio il server crea database e tabelle in autonomia.
// - Se esistono migrazioni versionate -> `migrate deploy` (consigliato in produzione).
// - Altrimenti (primo avvio del progetto) -> `db push` allinea lo schema al database.
export async function bootstrapDatabase() {
  try {
    // Rigenera sempre il client Prisma: se lo schema è cambiato (es. nuovi modelli)
    // ma il client non è stato rigenerato manualmente, evita errori
    // "Cannot read properties of undefined" sui nuovi accessor (prisma.nuovoModello).
    logger.info('Generazione del client Prisma…');
    execSync('npx prisma generate', { stdio: 'inherit' });

    if (hasMigrations()) {
      logger.info('Applicazione delle migrazioni…');
      execSync('npx prisma migrate deploy', { stdio: 'inherit' });
    } else {
      logger.info('Nessuna migrazione versionata: allineo lo schema con `db push`.');
      execSync('npx prisma db push --skip-generate', { stdio: 'inherit' });
    }
  } catch (err) {
    logger.error({ err }, 'Impossibile applicare lo schema del database');
    throw err;
  }

  // Crea il primo Super Admin se il sistema è vuoto.
  await seedSuperAdmin(prisma);
}
