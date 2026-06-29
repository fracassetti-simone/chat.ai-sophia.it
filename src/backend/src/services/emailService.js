import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';

export function stripQuotedReply(text = '') {
  if (!text) return '';
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^>/.test(t)) break;
    if (/^On .{10,} wrote:/i.test(t)) break;
    if (/^-{3,} ?original message ?-{3,}/i.test(t)) break;
    if (/^From:\s/i.test(t) && out.length > 2) break;
    if (/^_{5,}/.test(t)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * Cerca il contatto in rubrica per indirizzo email.
 */
async function findContactByEmail(tenantId, email) {
  if (!email) return null;
  try {
    return await prisma.contact.findFirst({
      where: { tenantId, email: { equals: email.toLowerCase(), mode: 'insensitive' } },
      select: { id: true },
    });
  } catch { return null; }
}

/**
 * Sincronizza la casella IMAP — scarica tutti i messaggi non ancora in DB.
 * Collega automaticamente i thread ai contatti in rubrica.
 * Restituisce il numero di nuovi messaggi.
 */
export async function syncImap(account) {
  if (!account.imapHost || !account.imapUser || !account.imapPass) {
    logger.warn({ accountId: account.id }, 'IMAP: configurazione incompleta');
    return 0;
  }

  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort || 993,
    secure: account.imapSecure ?? true,
    auth: { user: account.imapUser, pass: account.imapPass },
    logger: false,
    socketTimeout: 30000,
    greetTimeout: 15000,
  });

  client.on('error', (err) => {
    logger.warn({ err: err.message, code: err.code, accountId: account.id }, 'IMAP: errore (gestito)');
  });

  let count = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true });
      const total = status.messages || 0;
      if (total === 0) return 0;

      // Scarica tutti i messaggi (non solo gli ultimi 50)
      const range = `1:${total}`;

      for await (const msg of client.fetch(range, { envelope: true, source: true })) {
        try {
          const dl = await client.download(String(msg.seq));
          const chunks = [];
          for await (const chunk of dl.content) chunks.push(chunk);
          const parsed = await simpleParser(Buffer.concat(chunks));

          const messageId = parsed.messageId || `seq-${msg.seq}-${account.id}`;
          const exists = await prisma.emailMessage.findFirst({ where: { messageId } });
          if (exists) continue;

          const rawSubject = parsed.subject || '(senza oggetto)';
          const baseSubject = rawSubject.replace(/^(Re|Fwd|R|I):\s*/i, '').trim();
          const fromEmail = (parsed.from?.value?.[0]?.address || '').toLowerCase();
          const fromName  = parsed.from?.value?.[0]?.name || '';
          const toEmail   = parsed.to?.value?.[0]?.address || account.email;
          const date      = parsed.date ? new Date(parsed.date) : new Date();
          const inReplyTo = parsed.inReplyTo || null;

          // Raggruppa in thread per subject normalizzato E mittente
          let thread = await prisma.emailThread.findFirst({
            where: {
              accountId: account.id,
              fromEmail,
              subject: { equals: baseSubject, mode: 'insensitive' },
            },
            orderBy: { lastMessageAt: 'desc' },
          });

          if (!thread) {
            // Prova a trovare un thread con In-Reply-To
            if (inReplyTo) {
              const parentMsg = await prisma.emailMessage.findFirst({ where: { messageId: inReplyTo } });
              if (parentMsg) {
                thread = await prisma.emailThread.findUnique({ where: { id: parentMsg.threadId } });
              }
            }
          }

          if (!thread) {
            // Cerca contatto in rubrica per collegamento automatico
            const contact = await findContactByEmail(account.tenantId, fromEmail);
            thread = await prisma.emailThread.create({
              data: {
                accountId: account.id,
                subject: baseSubject,
                fromEmail,
                fromName: fromName || fromEmail,
                contactId: contact?.id || null,
              },
            });
          } else if (!thread.contactId) {
            // Prova a collegare il contatto se non è già collegato
            const contact = await findContactByEmail(account.tenantId, fromEmail);
            if (contact) {
              await prisma.emailThread.update({
                where: { id: thread.id },
                data: { contactId: contact.id },
              });
            }
          }

          const rawText = parsed.text || '';
          const bodyText = stripQuotedReply(rawText) || rawText.slice(0, 5000);

          const attachments = (parsed.attachments || []).map(a => ({
            filename: a.filename || 'allegato',
            mimeType: a.contentType || 'application/octet-stream',
            size: a.size || 0,
          }));

          await prisma.emailMessage.create({
            data: {
              threadId: thread.id,
              role: 'inbound',
              fromEmail,
              fromName: fromName || fromEmail,
              toEmail,
              subject: rawSubject,
              bodyText: bodyText || '',
              bodyHtml: parsed.html || null,
              attachments,
              messageId,
            },
          });

          await prisma.emailThread.update({
            where: { id: thread.id },
            data: { lastMessageAt: date, isRead: false },
          });

          count++;
        } catch (msgErr) {
          logger.warn({ err: msgErr.message }, 'IMAP: errore messaggio (ignorato)');
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    let hint = '';
    if (err.authenticationFailed || err.message?.includes('auth')) {
      hint = 'Credenziali errate. Per Gmail usa App Password.';
    } else if (err.code === 'ETIMEOUT' || err.code === 'ECONNREFUSED') {
      hint = 'Host non raggiungibile. Per Gmail: imap.gmail.com:993 SSL.';
    }
    logger.error({ err: err.message, code: err.code, accountId: account.id, hint }, 'IMAP sync fallita');
    return 0;
  } finally {
    try { client.close(); } catch {}
  }

  try {
    await prisma.emailAccount.update({ where: { id: account.id }, data: { lastSyncAt: new Date() } });
  } catch {}

  return count;
}

/**
 * Invia email via SMTP e salva nel thread.
 */
export async function sendEmailFromAccount(account, { threadId, to, subject, html, text, attachmentDocIds = [] }) {
  const nodemailer = (await import('nodemailer')).default;
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort || 587,
    secure: account.smtpSecure || false,
    auth: { user: account.smtpUser, pass: account.smtpPass },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });

  const attachments = [];
  for (const docId of attachmentDocIds) {
    try {
      const doc = await prisma.document.findFirst({ where: { id: docId } });
      if (doc?.data) attachments.push({ filename: doc.filename, content: doc.data, contentType: doc.mimeType });
    } catch {}
  }

  const fullHtml = account.signature
    ? `${html || text || ''}<br><br><div class="email-signature">${account.signature}</div>`
    : (html || text || '');

  let info;
  try {
    info = await transporter.sendMail({
      from: `${account.name} <${account.email}>`,
      to, subject,
      text: text || '',
      html: fullHtml,
      attachments,
    });
  } catch (err) {
    const hint = err.code === 'EAUTH' ? ' Per Gmail usa smtp.gmail.com:587 con App Password.' : '';
    throw new Error(`Invio email fallito: ${err.message}${hint}`);
  }

  if (threadId) {
    try {
      await prisma.emailMessage.create({
        data: {
          threadId,
          role: 'outbound',
          fromEmail: account.email,
          fromName: account.name,
          toEmail: to,
          subject,
          bodyText: text || '',
          bodyHtml: fullHtml,
          attachments: attachmentDocIds.map(id => ({ docId: id })),
          messageId: info.messageId || '',
        },
      });
      await prisma.emailThread.update({ where: { id: threadId }, data: { lastMessageAt: new Date() } });
    } catch (err) {
      logger.warn({ err: err.message }, 'Email inviata ma salvataggio thread fallito');
    }
  }
  return { ok: true, messageId: info.messageId };
}

/**
 * Risposta AI automatica ai nuovi messaggi.
 * Rispetta il filtro indirizzi e la flag aiAutoReply dell'account.
 */
export async function autoReplyToNew(account, tenantId) {
  if (!account.aiAutoReply) return;
  const filterList = Array.isArray(account.aiReplyFilter) ? account.aiReplyFilter.map(e => e.toLowerCase()) : [];

  const unread = await prisma.emailMessage.findMany({
    where: { thread: { accountId: account.id }, role: 'inbound' },
    include: { thread: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  const { runChat } = await import('../ai/engine.js');

  for (const msg of unread) {
    // Salta se c'è già una risposta
    const replied = await prisma.emailMessage.findFirst({
      where: { threadId: msg.threadId, role: { in: ['outbound', 'ai'] } },
    });
    if (replied) continue;

    // Rispetta il filtro
    if (filterList.length > 0 && filterList.some(f => msg.fromEmail.includes(f))) continue;

    let aiText = '';
    try {
      await runChat({
        tenantId,
        source: 'EMAIL',
        extraContext: `Rispondi automaticamente a un'email. Mittente: ${msg.fromEmail}. Oggetto: ${msg.thread.subject}. Scrivi solo il corpo, in italiano, senza ridondanze.`,
        history: [{ role: 'user', content: msg.bodyText }],
        onToken: t => { aiText += t; },
      });
    } catch { continue; }
    if (!aiText) continue;

    const fullAccount = await prisma.emailAccount.findUnique({ where: { id: account.id } });
    if (!fullAccount?.smtpHost) continue;

    await sendEmailFromAccount(fullAccount, {
      threadId: msg.threadId,
      to: msg.fromEmail,
      subject: `Re: ${msg.thread.subject}`,
      text: aiText,
      html: `<p>${aiText.replace(/\n/g, '<br>')}</p>`,
    });
  }
}
