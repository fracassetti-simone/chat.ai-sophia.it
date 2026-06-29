import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { asyncHandler, forbidden } from '../utils/http.js';
import { authenticate, tenantScope } from '../middleware/auth.js';
import { PRICING } from '../ai/pricing.js';

const router = Router();
router.use(authenticate, tenantScope);

// Solo ADMIN e SUPER_ADMIN possono consultare i consumi e i costi.
function requireManager(req, _res, next) {
  if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'ADMIN') return next();
  next(forbidden('Sezione riservata agli amministratori.'));
}

const SOURCE_LABELS = {
  CHAT: 'Chat dashboard',
  WHATSAPP: 'WhatsApp',
  WIDGET: 'Widget sito',
  EMAIL: 'Email',
  FLOW: 'Automazioni',
  SCHEDULED: 'Azioni programmate',
  TRAINING: 'Addestramento',
};

// Normalizza una data dalla query (ISO o yyyy-mm-dd); ritorna null se non valida.
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayKey(date) {
  // YYYY-MM-DD in UTC, stabile per il raggruppamento.
  return date.toISOString().slice(0, 10);
}

function emptyTotals() {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 };
}

router.get(
  '/summary',
  requireManager,
  asyncHandler(async (req, res) => {
    const isSuper = req.user.role === 'SUPER_ADMIN';

    // Intervallo: default ultimi 30 giorni.
    const to = parseDate(req.query.to) || new Date();
    const from =
      parseDate(req.query.from) || new Date(to.getTime() - 30 * 86400000);
    // Includi tutto il giorno "to".
    const toEnd = new Date(to.getTime());
    toEnd.setUTCHours(23, 59, 59, 999);

    // Determinazione dello scope tenant.
    // - ADMIN: sempre e solo la propria azienda.
    // - SUPER_ADMIN: l'azienda attiva (header X-Tenant-Id) se presente,
    //   altrimenti vista globale con ripartizione per azienda.
    let tenantFilter;
    let global = false;
    if (isSuper) {
      if (req.tenantId) tenantFilter = { tenantId: req.tenantId };
      else { tenantFilter = {}; global = true; }
    } else {
      if (!req.user.tenantId) throw forbidden('Utente senza azienda associata.');
      tenantFilter = { tenantId: req.user.tenantId };
    }

    const where = { ...tenantFilter, createdAt: { gte: from, lte: toEnd } };

    // Carichiamo solo i campi necessari per le aggregazioni.
    const rows = await prisma.tokenUsage.findMany({
      where,
      select: {
        tenantId: true,
        source: true,
        inputTokens: true,
        cachedInputTokens: true,
        outputTokens: true,
        costUsd: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const totals = emptyTotals();
    const bySourceMap = new Map();
    const byDayMap = new Map();
    const byTenantMap = new Map();

    for (const r of rows) {
      const tokens = r.inputTokens + r.cachedInputTokens + r.outputTokens;

      totals.inputTokens += r.inputTokens;
      totals.cachedInputTokens += r.cachedInputTokens;
      totals.outputTokens += r.outputTokens;
      totals.totalTokens += tokens;
      totals.costUsd += r.costUsd;
      totals.calls += 1;

      const s = bySourceMap.get(r.source) || { costUsd: 0, totalTokens: 0, calls: 0 };
      s.costUsd += r.costUsd; s.totalTokens += tokens; s.calls += 1;
      bySourceMap.set(r.source, s);

      const dk = dayKey(r.createdAt);
      const d = byDayMap.get(dk) || { costUsd: 0, totalTokens: 0 };
      d.costUsd += r.costUsd; d.totalTokens += tokens;
      byDayMap.set(dk, d);

      if (global) {
        const t = byTenantMap.get(r.tenantId) || emptyTotals();
        t.inputTokens += r.inputTokens;
        t.cachedInputTokens += r.cachedInputTokens;
        t.outputTokens += r.outputTokens;
        t.totalTokens += tokens;
        t.costUsd += r.costUsd;
        t.calls += 1;
        byTenantMap.set(r.tenantId, t);
      }
    }

    // Serie giornaliera continua (riempie i giorni senza consumo con 0).
    const series = [];
    const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    const last = new Date(Date.UTC(toEnd.getUTCFullYear(), toEnd.getUTCMonth(), toEnd.getUTCDate()));
    let guard = 0;
    while (cursor <= last && guard < 400) {
      const dk = dayKey(cursor);
      const d = byDayMap.get(dk) || { costUsd: 0, totalTokens: 0 };
      series.push({ date: dk, costUsd: round6(d.costUsd), totalTokens: d.totalTokens });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      guard += 1;
    }

    const bySource = [...bySourceMap.entries()]
      .map(([key, v]) => ({ key, label: SOURCE_LABELS[key] || key, costUsd: round6(v.costUsd), totalTokens: v.totalTokens, calls: v.calls }))
      .sort((a, b) => b.costUsd - a.costUsd);

    let byTenant = [];
    if (global && byTenantMap.size) {
      const ids = [...byTenantMap.keys()];
      const tenants = await prisma.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      const nameById = new Map(tenants.map((t) => [t.id, t.name]));
      byTenant = ids
        .map((id) => {
          const v = byTenantMap.get(id);
          return { tenantId: id, name: nameById.get(id) || 'Azienda', ...roundTotals(v) };
        })
        .sort((a, b) => b.costUsd - a.costUsd);
    }

    res.json({
      range: { from: from.toISOString(), to: toEnd.toISOString() },
      scope: global ? 'all' : 'tenant',
      totals: roundTotals(totals),
      series,
      bySource,
      byTenant,
      pricing: PRICING['gpt-5.5'],
    });
  }),
);

function round6(n) { return Math.round(n * 1e6) / 1e6; }
function roundTotals(t) { return { ...t, costUsd: round6(t.costUsd) }; }

export default router;
