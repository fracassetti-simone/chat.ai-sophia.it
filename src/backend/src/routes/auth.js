import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiry,
} from '../utils/tokens.js';
import { asyncHandler, unauthorized, badRequest } from '../utils/http.js';
import { authenticate } from '../middleware/auth.js';
import { effectivePermissions } from '../utils/rbac.js';
import { writeAudit } from '../services/audit.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    permissions: [...effectivePermissions(user)],
  };
}

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email }, include: { permissions: true } });
    if (!user || !user.isActive) throw unauthorized('Credenziali non valide');

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) throw unauthorized('Credenziali non valide');

    const accessToken = signAccessToken(user);
    const { raw, hash } = generateRefreshToken();
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt: refreshExpiry() },
    });

    await writeAudit({ tenantId: user.tenantId, userId: user.id, action: 'auth.login', req });
    res.json({ accessToken, refreshToken: raw, user: publicUser(user) });
  }),
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) throw badRequest('refreshToken mancante');

    const record = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
      include: { user: { include: { permissions: true } } },
    });
    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw unauthorized('Refresh token non valido');
    }

    // Rotazione del refresh token.
    await prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });
    const { raw, hash } = generateRefreshToken();
    await prisma.refreshToken.create({
      data: { userId: record.userId, tokenHash: hash, expiresAt: refreshExpiry() },
    });

    res.json({ accessToken: signAccessToken(record.user), refreshToken: raw });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(refreshToken) },
        data: { revokedAt: new Date() },
      });
    }
    res.json({ ok: true });
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  }),
);

const changePwSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});

router.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = changePwSchema.parse(req.body);
    const ok = await verifyPassword(req.user.passwordHash, currentPassword);
    if (!ok) throw badRequest('Password attuale errata');

    await prisma.user.update({
      where: { id: req.user.id },
      data: { passwordHash: await hashPassword(newPassword) },
    });
    // Revoca tutti i refresh token esistenti dell'utente.
    await prisma.refreshToken.updateMany({
      where: { userId: req.user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writeAudit({ tenantId: req.user.tenantId, userId: req.user.id, action: 'auth.change_password', req });
    res.json({ ok: true });
  }),
);

// POST /auth/forgot-password — risponde sempre OK per non rivelare se l'email esiste.
router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body || {});
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Se l'utente esiste e ha un tenant con account email configurato, inviamo il link.
    if (user) {
      // TODO: quando il modulo email è configurato, inviare un link con token temporaneo.
      // Per ora logghiamo in audit per tracciabilità.
      await writeAudit({ tenantId: user.tenantId, userId: user.id, action: 'auth.forgot_password_request', req }).catch(() => {});
    }
    // Risposta identica in ogni caso (sicurezza: non rivela se l'email è registrata)
    res.json({ ok: true });
  }),
);

export default router;
