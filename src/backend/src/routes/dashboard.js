import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/http.js';
import { authenticate, tenantScope } from '../middleware/auth.js';
import { registry } from '../modules/registry.js';

const router = Router();
router.use(authenticate, tenantScope);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const isSuper = req.user.role === 'SUPER_ADMIN';

    const scope = tenantId ? { tenantId } : {};
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);

    const [users, conversations, messages, apiKeys, recentConversations, recentActivity, modules] =
      await Promise.all([
        prisma.user.count({ where: tenantId ? { tenantId } : {} }),
        prisma.conversation.count({ where: scope }),
        prisma.message.count({
          where: { conversation: scope, createdAt: { gte: sevenDaysAgo } },
        }),
        prisma.apiKey.count({ where: scope }),
        prisma.conversation.findMany({
          where: scope,
          orderBy: { updatedAt: 'desc' },
          take: 5,
          select: { id: true, title: true, updatedAt: true },
        }),
        prisma.auditLog.findMany({
          where: tenantId ? { tenantId } : {},
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: { id: true, action: true, target: true, createdAt: true },
        }),
        tenantId ? registry.instancesForTenant(tenantId) : Promise.resolve([]),
      ]);

    const stats = {
      users,
      conversations,
      aiMessages7d: messages,
      apiKeys,
      activeModules: modules.filter((m) => m.installed && m.enabled).length,
    };

    if (isSuper) {
      stats.tenants = await prisma.tenant.count();
    }

    res.json({
      stats,
      recentConversations,
      recentActivity,
      modules: modules.map((m) => ({ key: m.key, name: m.name, enabled: m.enabled, installed: m.installed })),
    });
  }),
);

export default router;
