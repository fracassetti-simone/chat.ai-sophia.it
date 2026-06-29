import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import hpp from 'hpp';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { config } from './config/index.js';
import { logger } from './config/logger.js';
import routes from './routes/index.js';
import widgetRouter from './routes/widget.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

// CORS per le route pubbliche del widget: origin aperto a tutti i siti.
const widgetCors = cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] });

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  // Sicurezza HTTP.
  app.use(helmet({
    // Helmet imposta CSP che blocca le risorse cross-origin; disabilitiamo
    // solo crossOriginResourcePolicy perché la gestiamo manualmente per i file.
    crossOriginResourcePolicy: false,
  }));

  // ── Widget routes PRIMA del CORS globale ────────────────────────────────
  // Le route /widget.js e /widget-chat/* devono rispondere a qualsiasi origin
  // (il cliente incorpora il widget nel suo sito). Le montiamo qui, prima del
  // cors() globale, con il loro cors aperto.
  app.options('/widget-chat/:publicId/messages', widgetCors);
  app.options('/widget-chat/:publicId/config', widgetCors);
  app.use(widgetCors, widgetRouter);

  // ── Compiler webhook: CORS aperto (chiamato da compiler.ai-sophia.it) ───
  const compilerWebhookCors = cors({ origin: '*', methods: ['POST', 'GET', 'OPTIONS'] });
  app.options('/api/compiler/webhook/:tenantId', compilerWebhookCors);
  app.options('/api/compiler/webhook/:tenantId/test', compilerWebhookCors);
  app.use('/api/compiler/webhook', compilerWebhookCors);

  // ── CORS globale per le route autenticate (/api) ─────────────────────────
  app.use(cors({ origin: config.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(hpp());
  app.use(pinoHttp({
    logger,
    autoLogging: { ignore: (req) => !req.url.includes('/whatsapp/webhook') },
  }));

  // Rate limiting globale.
  app.use('/api', rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));
  app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false }));

  // File pubblici: documenti e media WA accessibili cross-origin.
  app.use('/api/documents/:id/file', (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });
  app.use('/api/whatsapp/media', (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });

  app.use('/api', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
