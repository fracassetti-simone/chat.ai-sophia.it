import { HttpError } from '../utils/http.js';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';
import { isProd } from '../config/index.js';

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Dati non validi', details: err.flatten().fieldErrors });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  logger.error({ err }, 'Errore non gestito');
  res.status(500).json({
    error: 'Errore interno del server',
    ...(isProd ? {} : { detail: err.message }),
  });
}

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Endpoint non trovato' });
}
