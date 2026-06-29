import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../utils/rbac.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant, requirePermission(PERMISSIONS.ENDPOINTS_MANAGE));

const endpointSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  category: z.string().optional(),
  headers: z.record(z.any()).optional(),
  query: z.record(z.any()).optional(),
  params: z.record(z.any()).optional(),
  body: z.record(z.any()).optional(),
  variables: z.record(z.any()).optional(),
  bearerToken: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const endpoints = await prisma.apiEndpoint.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ endpoints });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = endpointSchema.parse(req.body);
    const endpoint = await prisma.apiEndpoint.create({ data: { ...data, tenantId: req.tenantId } });
    res.status(201).json({ endpoint });
  }),
);

// Importazione: l'AI analizza la documentazione caricata ed estrae gli endpoint
// in formato strutturato. Riceve testo già estratto dal documento.
router.post(
  '/import',
  asyncHandler(async (req, res) => {
    const text = z.string().min(1).parse(req.body?.text);
    const { extractEndpointsFromDocs } = await import('../services/apiDocImport.js');
    const extracted = await extractEndpointsFromDocs(text);
    res.json({ endpoints: extracted });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = endpointSchema.partial().parse(req.body);
    const { count } = await prisma.apiEndpoint.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data,
    });
    if (!count) throw notFound('Endpoint non trovato');
    res.json({ ok: true });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.apiEndpoint.deleteMany({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!count) throw notFound('Endpoint non trovato');
    res.json({ ok: true });
  }),
);

// Sostituisce {{var}}, $VAR e ${VAR} con i valori delle "variables" dell'endpoint
// (stessa logica usata da connect-api in fase di chiamata reale dall'AI).
function interpolate(value, vars) {
  if (typeof value === 'string') {
    return value
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? 'test'))
      .replace(/\$\{(\w+)\}/g, (_, k) => (vars[k] ?? 'test'))
      .replace(/\$(\w+)/g, (_, k) => (k in vars ? vars[k] : 'test'));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  }
  return value;
}

// Verifica un endpoint eseguendolo e restituendo status / risposta
router.post(
  '/:id/verify',
  asyncHandler(async (req, res) => {
    const ep = await prisma.apiEndpoint.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!ep) return res.status(404).json({ error: 'Endpoint non trovato' });

    const vars = { ...(ep.variables ?? {}), ...(req.body?.variables ?? {}) };
    const url = new URL(interpolate(ep.url, vars));
    for (const [k, v] of Object.entries(interpolate(ep.query ?? {}, vars))) {
      url.searchParams.set(k, String(v));
    }

    const headers = { ...interpolate(ep.headers ?? {}, vars) };
    if (ep.bearerToken) headers.Authorization = `Bearer ${interpolate(ep.bearerToken, vars)}`;
    const hasBody = !['GET', 'DELETE'].includes(ep.method) && ep.body && Object.keys(ep.body).length;
    if (hasBody) headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';

    const start = Date.now();
    try {
      const r = await fetch(url.toString(), {
        method: ep.method,
        headers,
        body: hasBody ? JSON.stringify(interpolate(ep.body, vars)) : undefined,
        signal: AbortSignal.timeout(8000),
      });
      const elapsed = Date.now() - start;
      const ct = r.headers.get('content-type') ?? '';
      const payload = ct.includes('application/json')
        ? await r.json().catch(() => null)
        : await r.text().catch(() => null);
      res.json({ ok: r.ok, status: r.status, elapsed, payload });
    } catch (err) {
      res.json({ ok: false, status: null, elapsed: Date.now() - start, error: err.message });
    }
  }),
);

export default router;
