import { defineModule } from '../base.js';

// Sostituisce le variabili con i valori forniti (variabili dell'endpoint + argomenti AI).
// Supporta sia la sintassi {{var}} che $VAR / ${VAR}, così endpoint importati da
// documentazione esterna (es. $OTP_API_KEY negli header) vengono interpolati correttamente.
function interpolate(value, vars) {
  if (typeof value === 'string') {
    return value
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? ''))
      .replace(/\$\{(\w+)\}/g, (_, k) => (vars[k] ?? ''))
      .replace(/\$(\w+)/g, (_, k) => (k in vars ? vars[k] : `$${k}`));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  }
  return value;
}

// Cerca nel testo della risposta indizi su quando riprovare
// (es. messaggi Meta/Graph "riprova fra 1 ora", "try again in 30 minutes").
// Ritorna i secondi suggeriti, o null se non trova nulla di utile.
function parseRetryHintSeconds(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  const m = s.match(/(\d+)\s*(second|secondo|minute|minuto|hour|ora|day|giorno)/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit.startsWith('second') || unit.startsWith('secondo')) return n;
  if (unit.startsWith('minute') || unit.startsWith('minuto')) return n * 60;
  if (unit.startsWith('hour') || unit.startsWith('ora')) return n * 3600;
  if (unit.startsWith('day') || unit.startsWith('giorno')) return n * 86400;
  return null;
}

// Esegue realmente la chiamata HTTP per un endpoint registrato, con interpolazione
// delle variabili. Condivisa fra la capability AI (call_endpoint) e lo scheduler
// dei task in background (retry).
export async function executeEndpointCall(ctx, ep, extraVars = {}) {
  const vars = { ...(ep.variables ?? {}), ...extraVars };
  const url = new URL(interpolate(ep.url, vars));
  for (const [k, v] of Object.entries(interpolate(ep.query ?? {}, vars))) {
    url.searchParams.set(k, String(v));
  }

  const headers = { ...interpolate(ep.headers ?? {}, vars) };
  if (ep.bearerToken) headers.Authorization = `Bearer ${interpolate(ep.bearerToken, vars)}`;

  const hasBody = !['GET', 'DELETE'].includes(ep.method) && ep.body && Object.keys(ep.body).length;
  if (hasBody) headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';

  const res = await fetch(url, {
    method: ep.method,
    headers,
    body: hasBody ? JSON.stringify(interpolate(ep.body, vars)) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text();

  const result = { status: res.status, ok: res.ok, data: payload };

  // Rilevamento intelligente di rate-limit / "riprova più tardi", per proporre
  // (lato AI/chat) un task in background che riprovi automaticamente.
  if (!res.ok && (res.status === 429 || res.status === 503)) {
    const retryAfterHeader = Number(res.headers.get('retry-after'));
    const hinted = parseRetryHintSeconds(JSON.stringify(payload));
    const delaySeconds = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader
      : hinted ?? 60; // default prudente se non c'è alcun indizio
    result.suggestAction = {
      type: 'schedule_retry',
      endpointId: ep.id,
      endpointName: ep.name,
      delaySeconds,
      variables: extraVars,
      message:
        delaySeconds >= 3600
          ? `Vuoi che riprovi "${ep.name}" tra ${Math.round(delaySeconds / 3600)} ora/e?`
          : delaySeconds >= 60
            ? `L'API ha risposto "troppe richieste". Vuoi che riprovi "${ep.name}" tra ${Math.round(delaySeconds / 60)} minuti?`
            : `L'API ha risposto "troppe richieste". Vuoi che riprovi "${ep.name}" tra ${delaySeconds} secondi?`,
    };
  }

  return result;
}

export default defineModule({
  key: 'connect-api',
  name: 'Connetti API',
  description:
    'Permette all\'AI di chiamare endpoint API esterni precedentemente registrati e autorizzati. ' +
    'L\'AI utilizza esclusivamente gli endpoint abilitati.',
  defaultInstalled: true,
  defaultConfig: {},
  capabilities: [
    {
      name: 'list_endpoints',
      description: 'Elenca gli endpoint API disponibili e abilitati, con metodo, descrizione e variabili richieste.',
      parameters: { type: 'object', properties: {}, required: [] },
      async handler(ctx) {
        const endpoints = await ctx.prisma.apiEndpoint.findMany({
          where: { tenantId: ctx.tenantId, enabled: true },
          select: { id: true, name: true, description: true, method: true, category: true, variables: true, body: true, query: true, url: true },
        });

        // Estrai tutte le variabili {{var}} usate nell'endpoint (url, body, query, headers)
        function extractVarNames(obj) {
          const text = typeof obj === 'string' ? obj : JSON.stringify(obj ?? '');
          const matches = text.match(/\{\{\s*(\w+)\s*\}\}/g) || [];
          return [...new Set(matches.map(m => m.replace(/\{\{\s*|\s*\}\}/g, '')))];
        }

        return {
          endpoints: endpoints.map(ep => {
            const staticVars = Object.keys(ep.variables ?? {});
            const usedInTemplate = [
              ...extractVarNames(ep.url),
              ...extractVarNames(ep.body),
              ...extractVarNames(ep.query),
            ];
            // Variabili da passare = quelle usate nel template che NON sono già nelle variabili statiche
            const dynamicVars = usedInTemplate.filter(v => !staticVars.includes(v));
            return {
              id: ep.id,
              name: ep.name,
              description: ep.description,
              method: ep.method,
              category: ep.category,
              // Variabili già configurate (non richiedono input dall'AI)
              staticVariables: staticVars,
              // Variabili che l'AI DEVE passare nel campo "variables" quando chiama call_endpoint
              requiredVariables: dynamicVars,
            };
          }),
        };
      },
    },
    {
      name: 'call_endpoint',
      description:
        'Chiama un endpoint registrato (per id o nome). Passa eventuali valori per le variabili ' +
        'dell\'endpoint tramite "variables".',
      parameters: {
        type: 'object',
        properties: {
          endpoint: { type: 'string', description: 'id o nome dell\'endpoint da chiamare' },
          variables: {
            type: 'object',
            description: 'Valori per le variabili {{...}} usate nell\'endpoint',
            additionalProperties: true,
          },
        },
        required: ['endpoint'],
      },
      async handler(ctx, args) {
        const ep = await ctx.prisma.apiEndpoint.findFirst({
          where: {
            tenantId: ctx.tenantId,
            enabled: true,
            OR: [{ id: args.endpoint }, { name: args.endpoint }],
          },
        });
        if (!ep) throw new Error(`Endpoint non autorizzato o inesistente: ${args.endpoint}`);

        const vars = { ...(args.variables ?? {}) };
        return executeEndpointCall({ tenantId: ctx.tenantId, prisma: ctx.prisma }, ep, vars);
      },
    },
  ],
});
