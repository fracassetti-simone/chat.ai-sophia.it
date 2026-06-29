import { Server } from 'socket.io';
import { verifyAccessToken } from '../utils/tokens.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

let io = null;

export function initRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
    connectTimeout: 10000,
    allowEIO3: true,
  });

  // Autenticazione del socket tramite access token.
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = verifyAccessToken(token);
      socket.data.userId = payload.sub;
      socket.data.tenantId = payload.tenantId;
      next();
    } catch {
      next(new Error('Autenticazione socket fallita'));
    }
  });

  io.on('connection', (socket) => {
    const { tenantId, userId } = socket.data;
    if (tenantId) socket.join(`tenant:${tenantId}`);
    socket.join(`user:${userId}`);
    logger.debug({ userId, tenantId }, 'Socket connesso');
    socket.on('error', (err) => {
      logger.warn({ err, userId }, 'Errore socket (ignorato)');
    });
  });

  io.engine.on('connection_error', (err) => {
    logger.warn({ code: err.code }, 'Socket engine error (ignorato)');
  });

  return io;
}

// Notifica live a tutti i client di un tenant (dashboard, liste, ecc.).
export function emitToTenant(tenantId, event, payload) {
  if (io && tenantId) io.to(`tenant:${tenantId}`).emit(event, payload);
}

export function emitToUser(userId, event, payload) {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
}
