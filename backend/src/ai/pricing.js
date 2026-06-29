// Listino prezzi AI e calcolo costi.
//
// Prezzi GPT-5.5 (USD per 1 milione di token), come da specifica:
//   - input (non in cache):  $5.00
//   - cached input:          $0.50
//   - output:                $30.00
//
// I prezzi sono centralizzati qui: per aggiornare un listino o aggiungere un
// modello, basta modificare questa tabella. Il costo viene calcolato e
// "congelato" al momento della registrazione (vedi recordUsage), così lo
// storico rimane corretto anche se i listini cambiano.

import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';

// Prezzo per 1.000.000 di token.
export const PRICING = {
  'gpt-5.5': { input: 5.0, cachedInput: 0.5, output: 30.0 },
};

// Listino di riferimento usato quando il modello non è esplicitamente mappato
// (mantiene coerenti i costi col modello principale richiesto dalla specifica).
const DEFAULT_PRICE = PRICING['gpt-5.5'];

const PER_MILLION = 1_000_000;

/** Restituisce il listino per un modello (con fallback al listino predefinito). */
export function priceFor(model) {
  return PRICING[model] || DEFAULT_PRICE;
}

/**
 * Calcola il costo in USD dato il conteggio token.
 * @param {{ model?: string, inputTokens?: number, cachedInputTokens?: number, outputTokens?: number }} u
 * @returns {number} costo in USD
 */
export function computeCost({ model, inputTokens = 0, cachedInputTokens = 0, outputTokens = 0 }) {
  const p = priceFor(model);
  const cost =
    (inputTokens / PER_MILLION) * p.input +
    (cachedInputTokens / PER_MILLION) * p.cachedInput +
    (outputTokens / PER_MILLION) * p.output;
  // Arrotonda a 6 decimali per evitare rumore in virgola mobile.
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * Normalizza l'oggetto `usage` restituito da OpenAI in token netti.
 * OpenAI riporta prompt_tokens come totale (cache inclusa): qui separiamo la
 * quota in cache da quella a tariffa piena.
 */
export function normalizeUsage(usage = {}) {
  const prompt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const inputNonCached = Math.max(0, prompt - cached);
  return { inputTokens: inputNonCached, cachedInputTokens: cached, outputTokens: output };
}

/**
 * Registra un consumo token. Non lancia mai: un errore di logging non deve
 * mai interrompere una risposta all'utente.
 *
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string|null} [p.userId]
 * @param {string|null} [p.conversationId]
 * @param {string} [p.source]   uno dei valori dell'enum TokenUsageSource
 * @param {string} p.model
 * @param {number} p.inputTokens
 * @param {number} p.cachedInputTokens
 * @param {number} p.outputTokens
 */
export async function recordUsage({
  tenantId,
  userId = null,
  conversationId = null,
  source = 'CHAT',
  model,
  inputTokens = 0,
  cachedInputTokens = 0,
  outputTokens = 0,
}) {
  if (!tenantId) return; // senza tenant non c'è nulla da attribuire
  if (inputTokens + cachedInputTokens + outputTokens === 0) return; // niente da registrare

  const costUsd = computeCost({ model, inputTokens, cachedInputTokens, outputTokens });

  try {
    await prisma.tokenUsage.create({
      data: {
        tenantId,
        userId: userId ?? undefined,
        conversationId: conversationId ?? undefined,
        source,
        model: model || 'gpt-5.5',
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costUsd,
      },
    });
  } catch (err) {
    logger.warn({ err, tenantId }, 'Registrazione consumo token non riuscita');
  }
}
