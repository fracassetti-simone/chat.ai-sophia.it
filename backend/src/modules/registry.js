import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';
import { toolName, parseToolName } from './base.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

class ModuleRegistry {
  constructor() {
    /** @type {Map<string, import('./base.js').ModuleDefinition>} */
    this.modules = new Map();
  }

  // Scoperta automatica: ogni sottocartella di src/modules/ con un index.js
  // che esporta una definizione di modulo viene registrata.
  async discover() {
    const entries = await readdir(__dirname, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const indexPath = join(__dirname, entry.name, 'index.js');
      try {
        const mod = await import(pathToFileURL(indexPath).href);
        const def = mod.default;
        if (def?.key) {
          this.modules.set(def.key, def);
          logger.info(`Modulo registrato: ${def.key} (${def.capabilities.length} capability)`);
        }
      } catch (err) {
        if (err.code !== 'ERR_MODULE_NOT_FOUND') {
          logger.warn({ err, module: entry.name }, 'Modulo non caricato');
        }
      }
    }
  }

  list() {
    return [...this.modules.values()];
  }

  get(key) {
    return this.modules.get(key);
  }

  // Assicura che ogni tenant abbia le righe ModuleInstance per i moduli
  // installati di default (eseguito alla creazione del tenant).
  async installDefaultsForTenant(tenantId) {
    for (const def of this.modules.values()) {
      if (!def.defaultInstalled) continue;
      await prisma.moduleInstance.upsert({
        where: { tenantId_moduleKey: { tenantId, moduleKey: def.key } },
        update: {},
        create: {
          tenantId,
          moduleKey: def.key,
          installed: true,
          enabled: true,
          config: def.defaultConfig ?? {},
        },
      });
    }
  }

  // Restituisce le istanze (stato per-tenant) arricchite con la definizione.
  async instancesForTenant(tenantId) {
    const rows = await prisma.moduleInstance.findMany({ where: { tenantId } });
    const byKey = new Map(rows.map((r) => [r.moduleKey, r]));
    return this.list().map((def) => {
      const inst = byKey.get(def.key);
      return {
        key: def.key,
        name: def.name,
        description: def.description,
        notice: def.notice,
        installed: inst?.installed ?? false,
        enabled: inst?.enabled ?? false,
        config: inst?.config ?? def.defaultConfig ?? {},
        capabilities: def.capabilities.map((c) => ({ name: c.name, description: c.description })),
      };
    });
  }

  // Capability attive per un tenant, eventualmente filtrate da un allow-list
  // (usato dagli Embed per esporre solo certe funzionalità).
  async enabledCapabilities(tenantId, allow = null) {
    const rows = await prisma.moduleInstance.findMany({
      where: { tenantId, installed: true, enabled: true },
    });
    const installedKeys = new Set(rows.map(r => r.moduleKey));

    // Includi anche i moduli defaultInstalled che non hanno ancora una riga per questo tenant
    const defaultRows = [];
    for (const def of this.modules.values()) {
      if (def.defaultInstalled && !installedKeys.has(def.key)) {
        // Crea la riga automaticamente
        try {
          const inst = await prisma.moduleInstance.upsert({
            where: { tenantId_moduleKey: { tenantId, moduleKey: def.key } },
            update: {},
            create: { tenantId, moduleKey: def.key, installed: true, enabled: true, config: def.defaultConfig ?? {} },
          });
          defaultRows.push(inst);
        } catch { /* già esiste, ignora */ }
      }
    }

    const allRows = [...rows, ...defaultRows];
    const result = [];
    for (const row of allRows) {
      const def = this.modules.get(row.moduleKey);
      if (!def) continue;
      if (allow?.modules && !allow.modules.includes(def.key)) continue;
      for (const cap of def.capabilities) {
        result.push({ moduleKey: def.key, capability: cap, config: row.config });
      }
    }
    return result;
  }

  // Converte le capability in definizioni di tool nel formato OpenAI.
  async openAiTools(tenantId, allow = null) {
    const caps = await this.enabledCapabilities(tenantId, allow);
    return caps.map(({ moduleKey, capability }) => ({
      type: 'function',
      function: {
        name: toolName(moduleKey, capability.name),
        description: capability.description,
        parameters: capability.parameters,
      },
    }));
  }

  // Esegue una capability a partire dal nome del tool prodotto dall'AI.
  async invoke(tenantId, name, args, extra = {}) {
    const { moduleKey, capabilityName } = parseToolName(name);
    const def = this.modules.get(moduleKey);
    if (!def) throw new Error(`Modulo sconosciuto: ${moduleKey}`);

    const instance = await prisma.moduleInstance.findUnique({
      where: { tenantId_moduleKey: { tenantId, moduleKey } },
    });
    if (!instance?.installed || !instance.enabled) {
      throw new Error(`Modulo non attivo: ${moduleKey}`);
    }

    const cap = def.capabilities.find((c) => c.name === capabilityName);
    if (!cap) throw new Error(`Capability sconosciuta: ${capabilityName}`);

    return cap.handler(
      { tenantId, config: instance.config ?? {}, prisma, conversationId: extra.conversationId ?? null, userId: extra.userId ?? null, userRole: extra.userRole ?? null, source: extra.source ?? null, userContactId: extra.userContactId ?? null, externalChatId: extra.externalChatId ?? null },
      args ?? {},
    );
  }
}

export const registry = new ModuleRegistry();
