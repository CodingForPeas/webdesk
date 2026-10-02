// lib/errors.js
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function errorHandler(err, req, res, next) {
  // Full detail server-side only
  console.error(`[${req.method} ${req.originalUrl}]`, err);

  if (res.headersSent) return next(err);

  const known = Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
  const status = known ? err.status : 500;

  res.status(status).json({
    error: known ? err.message : 'An unexpected server error occurred.',
    requestId: res.locals.requestId, // optional: correlate with logs
  });
}
