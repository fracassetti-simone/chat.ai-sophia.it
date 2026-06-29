/**
 * Rotte per la chat sincronizzata WhatsApp.
 *
 * GET  /api/whatsapp-chat/status   → Verifica se l'utente ha una chat WA sincronizzata
 * POST /api/whatsapp-chat/init     → Crea/recupera la conversazione sincronizzata
 */

import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { asyncHandler, badRequest } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { logger } from '../config/logger.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

// GET /api/whatsapp-chat/status
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const link = await prisma.userPhoneLink.findUnique({ where: { userId: req.user.id } });
    if (!link?.verified) return res.json({ synced: false, reason: 'phone_not_linked' });

    const sync = await prisma.whatsAppSyncedConversation.findFirst({
      where: { userId: req.user.id, tenantId: req.tenantId },
    });
    res.json({ synced: !!sync, conversationId: sync?.conversationId || null, phone: link.phone });
  }),
);

// POST /api/whatsapp-chat/init
router.post(
  '/init',
  asyncHandler(async (req, res) => {
    const link = await prisma.userPhoneLink.findUnique({ where: { userId: req.user.id } });
    if (!link?.verified) throw badRequest('Numero di telefono non ancora verificato.');

    // Recupera o crea la conversazione sincronizzata
    let sync = await prisma.whatsAppSyncedConversation.findFirst({
      where: { userId: req.user.id, tenantId: req.tenantId },
      include: { conversation: true },
    });

    if (!sync) {
      const conversation = await prisma.conversation.create({
        data: {
          tenantId: req.tenantId,
          userId: req.user.id,
          title: `💬 WhatsApp — ${link.phone}`,
        },
      });
      sync = await prisma.whatsAppSyncedConversation.create({
        data: {
          tenantId: req.tenantId,
          userId: req.user.id,
          phone: link.phone,
          conversationId: conversation.id,
        },
        include: { conversation: true },
      });
      logger.info({ userId: req.user.id, phone: link.phone, conversationId: conversation.id }, 'Chat WA sincronizzata creata');
    }

    res.json({ ok: true, conversationId: sync.conversationId, phone: link.phone });
  }),
);


// POST /api/whatsapp-chat/disconnect
router.post(
  '/disconnect',
  asyncHandler(async (req, res) => {
    await prisma.whatsAppSyncedConversation.deleteMany({
      where: { userId: req.user.id, tenantId: req.tenantId },
    });
    res.json({ ok: true });
  }),
);

export default router;
