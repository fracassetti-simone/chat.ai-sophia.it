/**
 * Rotte profilo utente.
 *
 * GET   /api/me/profile          → Legge profilo (numero WA, memoria)
 * PATCH /api/me/profile          → Aggiorna numero WA
 * PATCH /api/me/memory           → Aggiorna/aggiunge un dato in memoria (usato dall'AI)
 * DELETE /api/me/memory/:key     → Cancella un dato di memoria
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/http.js';
import { authenticate, tenantScope } from '../middleware/auth.js';

const router = Router();
router.use(authenticate, tenantScope);

// GET /api/me/profile
router.get('/profile', asyncHandler(async (req, res) => {
  const profile = await prisma.userProfile.findUnique({ where: { userId: req.user.id } });
  let linkedContact = null;
  if (profile?.contactId) {
    const c = await prisma.contact.findFirst({ where: { id: profile.contactId } }).catch(() => null);
    if (c) linkedContact = { id: c.id, displayName: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.company || c.phone || c.email, firstName: c.firstName, email: c.email };
  }
  res.json({ whatsappNumber: profile?.whatsappNumber || null, memory: profile?.memory || {}, linkedContact });
}));

const profileSchema = z.object({
  whatsappNumber: z.string().regex(/^\+?\d{7,15}$/, 'Formato +39... richiesto').nullable().optional(),
  name: z.string().min(1).max(120).optional(),
  contactId: z.string().nullable().optional(),
});

router.patch('/profile', asyncHandler(async (req, res) => {
  const data = profileSchema.parse(req.body);
  if (data.name !== undefined) {
    await prisma.user.update({ where: { id: req.user.id }, data: { name: data.name } });
  }
  const profileData = {};
  if (data.whatsappNumber !== undefined) profileData.whatsappNumber = data.whatsappNumber;
  if (data.contactId !== undefined) profileData.contactId = data.contactId;

  if (Object.keys(profileData).length > 0) {
    await prisma.userProfile.upsert({
      where: { userId: req.user.id },
      update: profileData,
      create: { userId: req.user.id, ...profileData },
    });
  }
  res.json({ ok: true });
}));

// PATCH /api/me/memory — aggiunge/aggiorna una coppia chiave-valore
// Usato dall'AI via capability per memorizzare dati sull'utente
const memSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string().max(500),
});

router.patch('/memory', asyncHandler(async (req, res) => {
  const { key, value } = memSchema.parse(req.body);

  const current = await prisma.userProfile.findUnique({ where: { userId: req.user.id } });
  const memory = { ...(current?.memory || {}), [key]: value };

  await prisma.userProfile.upsert({
    where: { userId: req.user.id },
    update: { memory },
    create: { userId: req.user.id, memory },
  });

  res.json({ ok: true, memory });
}));

// DELETE /api/me/memory/:key
router.delete('/memory/:key', asyncHandler(async (req, res) => {
  const current = await prisma.userProfile.findUnique({ where: { userId: req.user.id } });
  const memory = { ...(current?.memory || {}) };
  delete memory[req.params.key];

  await prisma.userProfile.upsert({
    where: { userId: req.user.id },
    update: { memory },
    create: { userId: req.user.id, memory },
  });

  res.json({ ok: true });
}));

export default router;
