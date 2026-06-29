import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, notFound, badRequest } from '../utils/http.js';
import { authenticate, tenantScope, requireTenant } from '../middleware/auth.js';
import { syncImap, sendEmailFromAccount, autoReplyToNew } from '../services/emailService.js';
import { config } from '../config/index.js';
import { runChat } from '../ai/engine.js';

const router = Router();
router.use(authenticate, tenantScope, requireTenant);
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ── Accounts ──────────────────────────────────────────────────────────────

router.get('/accounts', asyncHandler(async (req, res) => {
  const accounts = await prisma.emailAccount.findMany({
    where: { tenantId: req.tenantId },
    orderBy: { createdAt: 'asc' },
  });
  res.json({
    accounts: accounts.map(({ smtpPass, imapPass, ...a }) => ({
      ...a,
      hasSmtp: !!smtpPass,
      hasImap: !!(a.imapHost && imapPass),
    })),
  });
}));

const accountSchema = z.object({
  name:          z.string().trim().min(1).max(80),
  email:         z.string().email(),
  smtpHost:      z.string().trim().min(1),
  smtpPort:      z.number().int().optional().default(587),
  smtpSecure:    z.boolean().optional().default(false),
  smtpUser:      z.string().trim().min(1),
  smtpPass:      z.string().min(1),
  imapHost:      z.string().trim().optional().nullable(),
  imapPort:      z.number().int().optional().nullable(),
  imapSecure:    z.boolean().optional().default(true),
  imapUser:      z.string().trim().optional().nullable(),
  imapPass:      z.string().optional().nullable(),
  aiAutoReply:   z.boolean().optional(), // può essere undefined se la migrazione non è ancora applicata
  aiReplyFilter: z.array(z.string()).optional(),
});

router.post('/accounts', asyncHandler(async (req, res) => {
  const data = accountSchema.parse(req.body || {});
  const account = await prisma.emailAccount.create({ data: { tenantId: req.tenantId, ...data } });
  res.status(201).json({ account });
}));

router.patch('/accounts/:id', asyncHandler(async (req, res) => {
  const data = accountSchema.partial().parse(req.body || {});
  const { count } = await prisma.emailAccount.updateMany({
    where: { id: req.params.id, tenantId: req.tenantId },
    data,
  });
  if (!count) throw notFound('Account non trovato');
  res.json({ ok: true });
}));

router.delete('/accounts/:id', asyncHandler(async (req, res) => {
  const { count } = await prisma.emailAccount.deleteMany({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!count) throw notFound('Account non trovato');
  res.json({ ok: true });
}));

router.patch('/accounts/:id/signature', asyncHandler(async (req, res) => {
  const { signature } = z.object({ signature: z.string().max(20000) }).parse(req.body || {});
  const { count } = await prisma.emailAccount.updateMany({
    where: { id: req.params.id, tenantId: req.tenantId },
    data: { signature },
  });
  if (!count) throw notFound('Account non trovato');
  res.json({ ok: true });
}));

router.post('/accounts/:id/signature/image', logoUpload.single('image'), asyncHandler(async (req, res) => {
  const account = await prisma.emailAccount.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!account) throw notFound('Account non trovato');
  if (!req.file) throw badRequest('Nessun file ricevuto');
  const doc = await prisma.document.create({
    data: {
      tenant: { connect: { id: req.tenantId } },
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      extracted: '',
      data: req.file.buffer,
    },
  });
  const base = process.env.PUBLIC_API_URL || `http://localhost:${config.PORT}`;
  res.json({ url: `${base}/api/documents/${doc.id}/file` });
}));

// ── Sync IMAP ─────────────────────────────────────────────────────────────

router.post('/accounts/:id/sync', asyncHandler(async (req, res) => {
  const account = await prisma.emailAccount.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
  if (!account) throw notFound('Account non trovato');
  if (!account.imapHost) return res.status(400).json({ error: 'IMAP non configurato per questo account. Aggiorna le credenziali IMAP.' });

  let count = 0;
  let error = null;
  try {
    count = await syncImap(account);
  } catch (err) {
    error = err.message;
  }

  // Auto-reply in background (non blocca la risposta)
  autoReplyToNew(account, req.tenantId).catch(() => {});

  if (error) return res.status(500).json({ error: `Sync fallita: ${error}` });
  res.json({ ok: true, newMessages: count });
}));

// ── Threads ───────────────────────────────────────────────────────────────

router.get('/threads', asyncHandler(async (req, res) => {
  const where = { account: { tenantId: req.tenantId } };
  if (req.query.accountId) where.accountId = req.query.accountId;
  if (req.query.unread === 'true') where.isRead = false;
  if (req.query.contactId) where.contactId = req.query.contactId;
  if (req.query.q) {
    const q = req.query.q;
    where.OR = [
      { subject: { contains: q, mode: 'insensitive' } },
      { fromEmail: { contains: q, mode: 'insensitive' } },
      { fromName:  { contains: q, mode: 'insensitive' } },
    ];
  }

  const threads = await prisma.emailThread.findMany({
    where,
    orderBy: { lastMessageAt: 'desc' },
    take: 200,
    include: {
      account: { select: { name: true, email: true } },
      _count:  { select: { messages: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { bodyText: true, role: true, createdAt: true } },
    },
  });
  res.json({ threads });
}));

router.get('/threads/:id', asyncHandler(async (req, res) => {
  const thread = await prisma.emailThread.findFirst({
    where: { id: req.params.id, account: { tenantId: req.tenantId } },
    include: {
      account:  { select: { id: true, name: true, email: true, signature: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!thread) throw notFound('Thread non trovato');
  await prisma.emailThread.update({ where: { id: thread.id }, data: { isRead: true } });
  res.json({ thread });
}));

// ── Reply ─────────────────────────────────────────────────────────────────

router.post('/threads/:id/reply', asyncHandler(async (req, res) => {
  const { text, html, attachmentDocIds = [] } = z.object({
    text: z.string().min(1),
    html: z.string().optional(),
    attachmentDocIds: z.array(z.string()).optional(),
  }).parse(req.body || {});
  const thread = await prisma.emailThread.findFirst({
    where: { id: req.params.id, account: { tenantId: req.tenantId } },
    include: { account: true },
  });
  if (!thread) throw notFound('Thread non trovato');
  const result = await sendEmailFromAccount(thread.account, {
    threadId: thread.id,
    to: thread.fromEmail,
    subject: `Re: ${thread.subject}`,
    text, html, attachmentDocIds,
  });
  res.json(result);
}));

router.post('/threads/:id/ai-reply', asyncHandler(async (req, res) => {
  const thread = await prisma.emailThread.findFirst({
    where: { id: req.params.id, account: { tenantId: req.tenantId } },
    include: { account: true, messages: { orderBy: { createdAt: 'asc' }, take: 10 } },
  });
  if (!thread) throw notFound('Thread non trovato');

  const history = thread.messages.map(m => ({
    role: m.role === 'inbound' ? 'user' : 'assistant',
    content: `[Da ${m.fromEmail}]\n${m.bodyText}`,
  }));

  let aiText = '';
  await runChat({
    tenantId: req.tenantId,
    source: 'EMAIL',
    userRole: req.user.role,
    extraContext: `Rispondi a questa email. Mittente: ${thread.fromEmail}. Oggetto: ${thread.subject}. Scrivi solo il corpo, senza formule di apertura ridondanti.`,
    history,
    onToken: t => { aiText += t; },
  });

  if (!aiText) throw badRequest("L'AI non ha prodotto una risposta");

  const fullAccount = await prisma.emailAccount.findUnique({ where: { id: thread.account.id } });
  await sendEmailFromAccount(fullAccount, {
    threadId: thread.id,
    to: thread.fromEmail,
    subject: `Re: ${thread.subject}`,
    text: aiText,
    html: `<p>${aiText.replace(/\n/g, '<br>')}</p>`,
  });
  res.json({ ok: true, text: aiText });
}));

// ── Nuova email ───────────────────────────────────────────────────────────

router.post('/send', asyncHandler(async (req, res) => {
  const { accountId, to, subject, text, html, attachmentDocIds = [] } = z.object({
    accountId: z.string().min(1),
    to:        z.string().email(),
    subject:   z.string().min(1).max(500),
    text:      z.string().min(1),
    html:      z.string().optional(),
    attachmentDocIds: z.array(z.string()).optional(),
  }).parse(req.body || {});

  const account = await prisma.emailAccount.findFirst({ where: { id: accountId, tenantId: req.tenantId } });
  if (!account) throw notFound('Account non trovato');

  let thread = await prisma.emailThread.findFirst({
    where: { accountId, fromEmail: to, subject: { contains: subject.replace(/^Re:\s*/i, '').trim(), mode: 'insensitive' } },
    orderBy: { lastMessageAt: 'desc' },
  });
  if (!thread) {
    thread = await prisma.emailThread.create({
      data: { accountId, subject, fromEmail: to, fromName: to, isRead: true },
    });
  }
  const result = await sendEmailFromAccount(account, { threadId: thread.id, to, subject, text, html, attachmentDocIds });
  res.json({ ...result, threadId: thread.id });
}));

export default router;
