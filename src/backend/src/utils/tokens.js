import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config/index.js';

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, tenantId: user.tenantId ?? null },
    config.JWT_ACCESS_SECRET,
    { expiresIn: config.ACCESS_TOKEN_TTL },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.JWT_ACCESS_SECRET);
}

// I refresh token sono opachi: generiamo un valore casuale, ne salviamo solo l'hash.
export function generateRefreshToken() {
  const raw = crypto.randomBytes(48).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export function hashRefreshToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function refreshExpiry() {
  const d = new Date();
  d.setDate(d.getDate() + config.REFRESH_TOKEN_TTL_DAYS);
  return d;
}
