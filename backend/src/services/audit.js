import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';

// Scrive un evento di audit. Non blocca mai la richiesta in caso di errore.
export async function writeAudit({ tenantId = null, userId = null, action, target = null, metadata = null, req = null }) {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action,
        target,
        metadata: metadata ?? undefined,
        ip: req?.ip ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err, action }, 'Audit log non scritto');
  }
}
