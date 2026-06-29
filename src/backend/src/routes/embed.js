import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant, requirePermission(PERMISSIONS.EMBED_MANAGE));

const schema = z.object({
  title: z.string().optional(),
  primaryColor: z.string().optional(),
  logoUrl: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
  welcomeMessage: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  enabled: z.boolean().optional(),
  // Toggle delle funzionalità esposte al widget (Email, WhatsApp, API, Internet, Prompt, ...).
  enabledFeatures: z
    .object({
      modules: z.array(z.string()).optional(),
      internet: z.boolean().optional(),
      prompt: z.boolean().optional(),
      endpoints: z.array(z.string()).optional(),
    })
    .optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const embeds = await prisma.embedWidget.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ embeds });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = schema.parse(req.body);
    const embed = await prisma.embedWidget.create({ data: { ...data, tenantId: req.tenantId } });
    res.status(201).json({ embed, snippet: snippetFor(embed) });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = schema.parse(req.body);
    const embed = await prisma.embedWidget
      .update({ where: { id: req.params.id }, data })
      .catch(() => null);
    if (!embed || embed.tenantId !== req.tenantId) throw notFound('Embed non trovato');
    res.json({ embed, snippet: snippetFor(embed) });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.embedWidget.deleteMany({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!count) throw notFound('Embed non trovato');
    res.json({ ok: true });
  }),
);

// Snippet JavaScript da incollare in qualsiasi sito: una chat flottante in basso a destra.
function snippetFor(embed) {
  const apiBase = process.env.PUBLIC_API_URL || 'https://api.ai-sophia.it';
  return `<!-- Sophia Widget -->
<script>
  (function(){
    window.SophiaConfig = { id: "${embed.publicId}", api: "${apiBase}" };
    var s = document.createElement('script');
    s.src = "${apiBase}/widget.js";
    s.async = true;
    document.head.appendChild(s);
  })();
</script>`;
}

export default router;
