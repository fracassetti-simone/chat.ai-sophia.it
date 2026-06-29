import { getOpenAI, MODEL } from './openai.js';
import { buildSystemPrompt } from './prompt.js';
import { registry } from '../modules/registry.js';
import { logger } from '../config/logger.js';
import { normalizeUsage, recordUsage } from './pricing.js';

const MAX_TOOL_ROUNDS = 5;

/**
 * Esegue una conversazione in streaming.
 *
 * @param {object} opts
 * @param {string}  opts.tenantId
 * @param {string|null} opts.conversationId
 * @param {string|null} opts.userId
 * @param {Array}   opts.history   Messaggi precedenti.
 *   Ogni elemento può essere { role, content } dove content è stringa o array OpenAI.
 *   Se un messaggio ha { role:'user', content, images:[{base64,mimeType}] }
 *   viene automaticamente convertito in content array con image_url.
 * @param {object|null} opts.allow
 * @param {string} [opts.source]   origine del consumo (CHAT, WHATSAPP, WIDGET, ...)
 * @param {string|null} [opts.userRole]  ruolo del richiedente; abilita le capability riservate (es. consultazione costi)
 * @param {(delta:string)=>void} opts.onToken
 * @param {(call:object)=>void}  opts.onToolCall
 */
export async function runChat({ tenantId, conversationId = null, userId = null, isTraining = false, history, allow = null, source = 'CHAT', userRole = null, extraContext = null, agentId = null, agentOverride = null, externalChatId = null, onToken, onToolCall }) {
  let openai;
  try {
    openai = getOpenAI();
  } catch (err) {
    logger.error({ err }, 'Inizializzazione client OpenAI fallita');
    throw new Error('API AI non configurata. Verifica OPENAI_API_KEY nel .env.');
  }

  const system = await buildSystemPrompt(tenantId, userId, isTraining, extraContext, agentId, agentOverride);
  const tools  = await registry.openAiTools(tenantId, allow);

  // Carica il contactId dell'utente per passarlo ai tool (es. cloud find_documents)
  let userContactId = null;
  if (userId) {
    try {
      const { prisma } = await import('../db/prisma.js');
      const profile = await prisma.userProfile.findUnique({ where: { userId }, select: { contactId: true } });
      userContactId = profile?.contactId || null;
    } catch {}
  }

  // Normalizza i messaggi history: converte { content, images } in content array
  const normalizedHistory = history.map((m) => {
    if (m.images && m.images.length > 0 && m.role === 'user') {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const img of m.images) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}` },
        });
      }
      return { role: 'user', content: parts };
    }
    return { role: m.role, content: m.content };
  });

  const messages = [{ role: 'system', content: system }, ...normalizedHistory];
  const executedToolCalls = [];
  let finalText = '';
  // Accumula i token consumati attraverso i vari round di tool-calling.
  const usageTotal = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let stream;
    try {
      stream = await openai.chat.completions.create({
        model: MODEL,
        messages,
        tools: tools.length ? tools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      });
    } catch (err) {
      logger.error({ err, model: MODEL, tenantId }, 'Chiamata OpenAI fallita');
      const status = err?.status ?? err?.response?.status;
      if (status === 401) throw new Error('Chiave API OpenAI non valida (401).');
      if (status === 429) throw new Error('Limite richieste OpenAI raggiunto (429). Riprova tra poco.');
      throw new Error(`Errore OpenAI: ${err.message ?? 'sconosciuto'}`);
    }

    let roundText = '';
    const pendingToolCalls = new Map();

    for await (const chunk of stream) {
      // Il chunk finale (con include_usage) contiene il conteggio token e
      // nessun delta di contenuto.
      if (chunk.usage) {
        const u = normalizeUsage(chunk.usage);
        usageTotal.inputTokens += u.inputTokens;
        usageTotal.cachedInputTokens += u.cachedInputTokens;
        usageTotal.outputTokens += u.outputTokens;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        roundText += delta.content;
        finalText += delta.content;
        onToken?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = pendingToolCalls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name)      slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        pendingToolCalls.set(tc.index, slot);
      }
    }

    if (pendingToolCalls.size === 0) break;

    const assistantToolMsg = {
      role: 'assistant',
      content: roundText || null,
      tool_calls: [...pendingToolCalls.values()].map((t) => ({
        id: t.id, type: 'function',
        function: { name: t.name, arguments: t.args || '{}' },
      })),
    };
    messages.push(assistantToolMsg);

    for (const t of pendingToolCalls.values()) {
      let result;
      try {
        const args = t.args ? JSON.parse(t.args) : {};
        onToolCall?.({ name: t.name, args });
        result = await registry.invoke(tenantId, t.name, args, { conversationId, userId, userRole, source, userContactId, externalChatId });
        executedToolCalls.push({ name: t.name, args, ok: true, result });
      } catch (err) {
        logger.warn({ err, tool: t.name }, 'Capability fallita');
        result = { error: err.message };
        executedToolCalls.push({ name: t.name, ok: false, error: err.message });
      }
      messages.push({ role: 'tool', tool_call_id: t.id, content: JSON.stringify(result) });
    }
  }

  // Registra il consumo token (non blocca mai la risposta).
  await recordUsage({
    tenantId,
    userId,
    conversationId,
    source,
    model: MODEL,
    ...usageTotal,
  });

  return { content: finalText, toolCalls: executedToolCalls };
}
