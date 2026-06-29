// Contratto del sistema a plugin.
//
// Un modulo è un oggetto "definizione" puro che il core scopre a runtime.
// Aggiungere un nuovo modulo significa creare una cartella in src/modules/<key>/
// che esporta un default `defineModule(...)`. Il core non va MAI modificato.
//
// Ogni modulo dichiara delle "capability": funzioni che l'AI può invocare come tool.
// Ogni capability descrive i propri parametri con JSON Schema (formato tool OpenAI).

/**
 * @typedef {Object} Capability
 * @property {string} name           Nome univoco nel modulo (es. "send").
 * @property {string} description    Descrizione per l'AI.
 * @property {object} parameters     JSON Schema dei parametri.
 * @property {(ctx: CapabilityContext, args: object) => Promise<any>} handler
 *
 * @typedef {Object} CapabilityContext
 * @property {string} tenantId
 * @property {object} config         Configurazione per-tenant del modulo.
 * @property {import('@prisma/client').PrismaClient} prisma
 *
 * @typedef {Object} ModuleDefinition
 * @property {string} key
 * @property {string} name
 * @property {string} description
 * @property {boolean} [defaultInstalled]
 * @property {object} [defaultConfig]
 * @property {import('zod').ZodTypeAny} [configSchema]
 * @property {Capability[]} capabilities
 * @property {string} [notice]       Avviso mostrato in UI (es. limitazioni versione iniziale).
 */

/** @param {ModuleDefinition} def */
export function defineModule(def) {
  if (!def.key) throw new Error('Un modulo deve avere una chiave (key).');
  return {
    defaultInstalled: false,
    defaultConfig: {},
    capabilities: [],
    notice: null,
    ...def,
  };
}

// Identificatore esposto all'AI: "<moduleKey>__<capability>".
export function toolName(moduleKey, capabilityName) {
  return `${moduleKey}__${capabilityName}`;
}

export function parseToolName(name) {
  const idx = name.indexOf('__');
  if (idx === -1) return { moduleKey: null, capabilityName: name };
  return { moduleKey: name.slice(0, idx), capabilityName: name.slice(idx + 2) };
}
