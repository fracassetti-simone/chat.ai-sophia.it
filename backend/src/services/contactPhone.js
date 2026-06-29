import { prisma } from '../db/prisma.js';
import { normalizePhone } from '../utils/phone.js';
import { logger } from '../config/logger.js';

/**
 * Trova un contatto a partire da QUALSIASI numero collegato (ContactPhone),
 * non solo dal campo legacy Contact.phone. Questo è il punto centrale che
 * garantisce che "scrivere su WhatsApp da numeri diversi collegati allo
 * stesso contatto" funzioni ovunque nel prodotto.
 *
 * @param {string} tenantId
 * @param {string} rawPhone - numero in qualsiasi formato (verrà normalizzato)
 * @returns {Promise<object|null>} il Contact (con `phones` incluso) o null
 */
export async function findContactByPhone(tenantId, rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;

  const link = await prisma.contactPhone.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
    include: { contact: { include: { phones: true } } },
  });
  if (link) return link.contact;

  // Fallback per dati legacy non ancora migrati in ContactPhone
  // (es. contatti creati prima di questa modifica e non ancora sincronizzati).
  const legacy = await prisma.contact.findFirst({
    where: { tenantId, phone },
    include: { phones: true },
  });
  return legacy;
}

/**
 * Collega un numero a un contatto esistente (crea la riga ContactPhone se non
 * esiste già). Se il numero risulta già collegato a un ALTRO contatto, non lo
 * sposta automaticamente — evita di "rubare" un numero da un altro contatto
 * per errore. Restituisce { ok, reason? }.
 */
export async function attachPhoneToContact(tenantId, contactId, rawPhone, { label = null, isPrimary = false } = {}) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, reason: 'empty' };

  const existing = await prisma.contactPhone.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
  });
  if (existing && existing.contactId !== contactId) {
    return { ok: false, reason: 'taken', contactId: existing.contactId };
  }
  if (existing) {
    if (isPrimary) await setPrimaryPhone(tenantId, contactId, phone);
    return { ok: true, phoneId: existing.id, alreadyLinked: true };
  }

  const created = await prisma.contactPhone.create({
    data: { tenantId, contactId, phone, label, isPrimary },
  });

  if (isPrimary) await setPrimaryPhone(tenantId, contactId, phone);
  await syncLegacyPrimaryPhone(contactId);

  return { ok: true, phoneId: created.id };
}

/** Imposta un numero come principale per il contatto (uno solo per contatto). */
export async function setPrimaryPhone(tenantId, contactId, rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return;
  await prisma.contactPhone.updateMany({ where: { contactId }, data: { isPrimary: false } });
  await prisma.contactPhone.updateMany({
    where: { tenantId, contactId, phone },
    data: { isPrimary: true },
  });
  await syncLegacyPrimaryPhone(contactId);
}

export async function removePhoneFromContact(tenantId, contactId, rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, reason: 'empty' };
  const { count } = await prisma.contactPhone.deleteMany({ where: { tenantId, contactId, phone } });
  await syncLegacyPrimaryPhone(contactId);
  return { ok: count > 0 };
}

/**
 * Mantiene sincronizzato il campo legacy Contact.phone con il numero
 * principale (o il primo disponibile) tra quelli collegati, per compatibilità
 * con tutto il codice/AI che ancora legge `contact.phone` come comodo
 * "numero di riferimento" da mostrare in liste/prompt.
 */
export async function syncLegacyPrimaryPhone(contactId) {
  try {
    const phones = await prisma.contactPhone.findMany({
      where: { contactId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      take: 1,
    });
    await prisma.contact.update({
      where: { id: contactId },
      data: { phone: phones[0]?.phone || null },
    });
  } catch (err) {
    logger.warn({ err: err.message, contactId }, 'Sync numero principale contatto fallita');
  }
}

/**
 * Crea (se serve) il contatto collegato a un numero che scrive per la prima
 * volta (tipicamente dal webhook WhatsApp), oppure restituisce quello già
 * esistente — riconosciuto anche se il numero è uno dei numeri secondari.
 */
export async function findOrCreateContactByPhone(tenantId, rawPhone, extra = {}) {
  const existing = await findContactByPhone(tenantId, rawPhone);
  if (existing) return existing;

  const phone = normalizePhone(rawPhone);
  const created = await prisma.contact.create({
    data: { tenantId, phone, source: extra.source || 'whatsapp', ...extra.data },
  });
  await prisma.contactPhone.create({
    data: { tenantId, contactId: created.id, phone, isPrimary: true, label: extra.label || null },
  });
  return { ...created, phones: [{ phone, isPrimary: true }] };
}
