import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';
import { emitToTenant } from '../realtime/io.js';
import { runChat } from '../ai/engine.js';
import { executeEndpointCall } from '../modules/connect-api/index.js';

const TICK_MS = 15_000;
const MAX_AUTO_RETRIES = 5; // limite di sicurezza per i task RETRY se non specificato

let timer = null;

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => logger.error({ err }, 'Errore nel ciclo dello scheduler task'));
  }, TICK_MS);
  logger.info('Scheduler task in background avviato');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  const due = await prisma.backgroundTask.findMany({
    where: { status: 'ACTIVE', runAt: { lte: new Date() } },
    take: 25,
  });
  for (const task of due) {
    try {
      await runTask(task);
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Esecuzione task in background fallita');
      await prisma.backgroundTask.update({
        where: { id: task.id },
        data: { lastResult: { error: err.message }, lastRunAt: new Date() },
      });
    }
  }
}

async function postMessage(conversationId, content, toolCalls) {
  if (!conversationId) return;
  await prisma.message.create({
    data: { conversationId, role: 'assistant', content, toolCalls: toolCalls?.length ? toolCalls : undefined },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
}

async function runTask(task) {
  if (task.kind === 'RETRY') return runRetryTask(task);
  if (task.kind === 'RECURRING') return runRecurringTask(task);
  if (task.kind === 'ONCE') return runOnceTask(task);
}

async function runRetryTask(task) {
  const { endpointId, variables } = task.payload || {};
  const ep = await prisma.apiEndpoint.findFirst({ where: { id: endpointId, tenantId: task.tenantId } });
  if (!ep) {
    await prisma.backgroundTask.update({
      where: { id: task.id },
      data: { status: 'FAILED', lastResult: { error: 'Endpoint non trovato' }, lastRunAt: new Date() },
    });
    return;
  }

  const result = await executeEndpointCall({ tenantId: task.tenantId, prisma }, ep, variables || {});
  const attempts = task.attempts + 1;
  const cap = task.maxAttempts ?? MAX_AUTO_RETRIES;

  if (result.ok) {
    await prisma.backgroundTask.update({
      where: { id: task.id },
      data: { status: 'DONE', attempts, lastResult: result, lastRunAt: new Date() },
    });
    await postMessage(task.conversationId, `✅ Ho riprovato la chiamata a "${ep.name}": questa volta ha funzionato (status ${result.status}).`);
  } else if (result.suggestAction && attempts < cap) {
    // Ancora rate-limited: si rimette in coda con il nuovo ritardo suggerito.
    await prisma.backgroundTask.update({
      where: { id: task.id },
      data: {
        attempts,
        lastResult: result,
        lastRunAt: new Date(),
        runAt: new Date(Date.now() + result.suggestAction.delaySeconds * 1000),
      },
    });
  } else {
    await prisma.backgroundTask.update({
      where: { id: task.id },
      data: { status: 'FAILED', attempts, lastResult: result, lastRunAt: new Date() },
    });
    await postMessage(task.conversationId, `⚠️ Ho riprovato la chiamata a "${ep.name}" ma continua a fallire (status ${result.status}). Ho interrotto i tentativi automatici.`);
  }
  emitToTenant(task.tenantId, 'conversation:updated', { id: task.conversationId });
}

async function runOnceTask(task) {
  const { content, toolCalls } = await runChat({
    tenantId: task.tenantId,
    conversationId: task.conversationId,
    source: 'SCHEDULED',
    history: [{ role: 'user', content: task.instruction }],
  });

  await postMessage(task.conversationId, content || '(azione eseguita)', toolCalls);

  await prisma.backgroundTask.update({
    where: { id: task.id },
    data: { status: 'DONE', attempts: task.attempts + 1, lastResult: { content, toolCalls }, lastRunAt: new Date() },
  });

  const label = task.instruction.length > 60 ? task.instruction.slice(0, 60) + '…' : task.instruction;
  emitToTenant(task.tenantId, 'task:executed', { taskId: task.id, conversationId: task.conversationId, label, executedAt: new Date().toISOString() });
  if (task.conversationId) emitToTenant(task.tenantId, 'conversation:updated', { id: task.conversationId });
}

async function runRecurringTask(task) {  const { content, toolCalls } = await runChat({
    tenantId: task.tenantId,
    conversationId: task.conversationId,
    source: 'SCHEDULED',
    history: [{ role: 'user', content: task.instruction }],
  });

  await postMessage(task.conversationId, content || '(azione ricorrente eseguita)', toolCalls);

  const now = new Date();
  await prisma.backgroundTask.update({
    where: { id: task.id },
    data: {
      attempts: task.attempts + 1,
      lastResult: { content, toolCalls },
      lastRunAt: now,
      runAt: new Date(now.getTime() + task.intervalSeconds * 1000),
    },
  });

  // Emetti evento "azione eseguita" leggibile verso il frontend
  const label = task.instruction.length > 60
    ? task.instruction.slice(0, 60) + '…'
    : task.instruction;
  emitToTenant(task.tenantId, 'task:executed', {
    taskId: task.id,
    conversationId: task.conversationId,
    label,
    executedAt: now.toISOString(),
  });
  emitToTenant(task.tenantId, 'conversation:updated', { id: task.conversationId });
}
