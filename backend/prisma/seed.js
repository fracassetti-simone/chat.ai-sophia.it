import { config } from '../src/config/index.js';
import { hashPassword } from '../src/utils/password.js';
import { logger } from '../src/config/logger.js';

// Crea il Super Admin iniziale solo se non esiste già un utente con quella email.
// La password potrà essere modificata dal pannello.
export async function seedSuperAdmin(prisma) {
  const email = config.BOOTSTRAP_ADMIN_EMAIL;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    logger.info(`Super Admin già presente (${email}).`);
    return existing;
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: 'Super Admin',
      role: 'SUPER_ADMIN',
      passwordHash: await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD),
      tenantId: null,
    },
  });
  logger.info(`Super Admin creato: ${email}`);
  return user;
}

// Permette di eseguire il seed come script autonomo (`npm run db:seed`).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { prisma } = await import('../src/db/prisma.js');
  await seedSuperAdmin(prisma);
  await prisma.$disconnect();
}
