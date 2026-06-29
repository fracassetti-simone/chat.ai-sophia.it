// Errore applicativo con codice HTTP esplicito.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (m, d) => new HttpError(400, m, d);
export const unauthorized = (m = 'Non autenticato') => new HttpError(401, m);
export const forbidden = (m = 'Permesso negato') => new HttpError(403, m);
export const notFound = (m = 'Risorsa non trovata') => new HttpError(404, m);

// Wrapper per gestire le promise rejection nelle route Express.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
