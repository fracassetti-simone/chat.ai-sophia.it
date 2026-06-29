/**
 * Rotte collegamento numero di telefono utente tramite OTP ai-sophia.
 *
 * POST /api/phone/link       → Avvia il collegamento: invia OTP via WhatsApp al numero indicato
 * POST /api/phone/verify     → Verifica OTP e certifica il collegamento
 * GET  /api/phone/status     → Restituisce lo stato del collegamento dell'utente corrente
 * DELETE /api/phone/unlink   → Rimuove il collegamento
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, badRequest } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { logger } from '../config/logger.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);

const OTP_BASE = 'https://otp.ai-sophia.it';

function otpHeaders() {
  const key = process.env.OTP_API_KEY;
  if (!key) throw new Error('OTP_API_KEY non configurata nel .env del backend.');
  return { 'Content-Type': 'application/json', 'X-API-Key': key };
}

// ── GET /api/phone/status ────────────────────────────────────────────────

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const link = await prisma.userPhoneLink.findUnique({
      where: { userId: req.user.id },
    });
    if (!link) return res.json({ linked: false });
    res.json({
      linked: true,
      verified: link.verified,
      phone: link.phone,
    });
  }),
);

// ── POST /api/phone/link ─────────────────────────────────────────────────

const linkSchema = z.object({
  phone: z.string().regex(/^\+\d{7,15}$/, 'Formato numero non valido (es. +393331234567)'),
});

router.post(
  '/link',
  asyncHandler(async (req, res) => {
    const { phone } = linkSchema.parse(req.body);

    // Manda OTP tramite ai-sophia
    let otpData;
    try {
      const r = await fetch(`${OTP_BASE}/v1/otp/send`, {
        method: 'POST',
        headers: otpHeaders(),
        body: JSON.stringify({
          to: phone,
          ttlMinutes: 10,
          metadata: { userId: req.user.id },
        }),
      });
      otpData = await r.json();
      if (!otpData.ok) {
        throw new Error(otpData.message || otpData.error || 'Invio OTP fallito');
      }
    } catch (err) {
      logger.error({ err }, 'OTP send failed');
      throw badRequest(err.message);
    }

    // Salva / aggiorna il link (non ancora verificato)
    await prisma.userPhoneLink.upsert({
      where: { userId: req.user.id },
      update: { phone, verified: false, pendingOtpId: otpData.otp.id },
      create: { userId: req.user.id, phone, verified: false, pendingOtpId: otpData.otp.id },
    });

    logger.info({ userId: req.user.id, phone, otpId: otpData.otp.id }, 'OTP inviato per collegamento');
    res.json({ ok: true, message: `OTP inviato via WhatsApp a ${phone}`, expiresAt: otpData.otp.expiresAt });
  }),
);

// ── POST /api/phone/verify ───────────────────────────────────────────────

const verifySchema = z.object({
  code: z.string().length(6, 'Il codice OTP deve essere di 6 cifre'),
});

router.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const { code } = verifySchema.parse(req.body);

    const link = await prisma.userPhoneLink.findUnique({ where: { userId: req.user.id } });
    if (!link || !link.pendingOtpId) throw badRequest('Nessuna richiesta OTP in attesa. Avvia prima il collegamento.');

    // Verifica tramite ai-sophia
    let verifyData;
    try {
      const r = await fetch(`${OTP_BASE}/v1/otp/verify`, {
        method: 'POST',
        headers: otpHeaders(),
        body: JSON.stringify({ otpId: link.pendingOtpId, code }),
      });
      verifyData = await r.json();
      if (!verifyData.ok) {
        const msg = {
          INVALID_OTP: 'Codice OTP errato.',
          OTP_EXPIRED: 'OTP scaduto. Richiedi un nuovo codice.',
          MAX_ATTEMPTS_REACHED: 'Troppi tentativi. Richiedi un nuovo codice.',
          OTP_REVOKED: 'OTP revocato. Richiedi un nuovo codice.',
        }[verifyData.error] || verifyData.message || 'Verifica fallita';
        throw badRequest(msg);
      }
    } catch (err) {
      if (err.status) throw err;
      throw badRequest(err.message);
    }

    // Segna come verificato
    await prisma.userPhoneLink.update({
      where: { userId: req.user.id },
      data: { verified: true, pendingOtpId: null },
    });

    logger.info({ userId: req.user.id, phone: link.phone }, 'Numero di telefono verificato e collegato');
    res.json({ ok: true, message: 'Numero verificato con successo!', phone: link.phone });
  }),
);

// ── DELETE /api/phone/unlink ─────────────────────────────────────────────

router.delete(
  '/unlink',
  asyncHandler(async (req, res) => {
    await prisma.userPhoneLink.deleteMany({ where: { userId: req.user.id } });
    // Rimuovi anche la chat sincronizzata se presente
    await prisma.whatsAppSyncedConversation.deleteMany({
      where: { userId: req.user.id, tenantId: req.tenantId },
    });
    res.json({ ok: true });
  }),
);

export default router;
