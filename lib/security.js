// lib/security.js
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

export function nonceMiddleware(req, res, next) {
  crypto.randomBytes(16, (err, bytes) => {
    if (err) return next(err);
    res.locals.nonce = bytes.toString('base64url');
    next();
  });
}

export function securityMiddleware() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
        styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
        imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
        connectSrc: ["'self'", "https://auth.mortis.org.uk", "https://map.mortis.org.uk"],
        frameSrc: ["https://map.mortis.org.uk"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
  });
}

// Fix #4: general limiter applied to ALL /api routes
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,                       // burst-friendly for drag-save churn
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  message: { error: 'Too many requests, slow down.' },
});

export const uploadLimiter = rateLimit({
  windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many uploads from this IP, please try again later.' },
});

export const wpUploadLimiter = rateLimit({
  windowMs: 60 * 60_000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many wallpaper uploads, please try again later.' },
});

