/**
 * migrate_contact_phones.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Migrazione ONE-SHOT: popola la tabella ContactPhone a partire dai contatti
 * esistenti in Contact.phone, normalizzando tutti i numeri nel formato
 * canonico "+39 375 713 9771" (con + e spazi).
 *
 * Eseguire UNA SOLA VOLTA dopo il deploy che introduce il modello ContactPhone:
 *
 *   node backend/scripts/migrate_contact_phones.js
 *
 * Lo script è idempotente: usa upsert, quindi può essere eseguito più volte
 * senza creare duplicati.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { PrismaClient } from '@prisma/client';

// ── Importa la logica di normalizzazione inline (evita dipendenze da path
//    relativi che cambiano a seconda di dove si lancia lo script).
const DEFAULT_COUNTRY = '39';

function toDigits(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (s.startsWith('00')) s = '+' + s.slice(2);
  const hadPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (hadPlus) return digits;
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  if (!digits.startsWith(DEFAULT_COUNTRY)) digits = DEFAULT_COUNTRY + digits;
  return digits;
}

function normalizePhone(raw) {
  const digits = toDigits(raw);
  if (!digits) return '';
  if (digits.startsWith(DEFAULT_COUNTRY) && digits.length >= 11) {
    const rest = digits.slice(2);
    const a = rest.slice(0, 3);
    const b = rest.slice(3, 6);
    const c = rest.slice(6);
    return `+39 ${a}${b ? ' ' + b : ''}${c ? ' ' + c : ''}`.trim();
  }
  return '+' + digits;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const prisma = new PrismaClient();

async function main() {
  console.log('=== Migrazione ContactPhone ===\n');

  // Leggi tutti i contatti con phone non vuoto
  const contacts = await prisma.contact.findMany({
    where: {
      phone: { not: null },
      NOT: { phone: '' },
    },
    select: { id: true, tenantId: true, phone: true },
  });

  console.log(`Trovati ${contacts.length} contatti con campo phone.`);

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const c of contacts) {
    const canonical = normalizePhone(c.phone);
    if (!canonical) {
      console.warn(`  ⚠ Contatto ${c.id}: phone "${c.phone}" non normalizzabile — saltato`);
      skipped++;
      continue;
    }

    try {
      await prisma.contactPhone.upsert({
        where: {
          tenantId_phone: { tenantId: c.tenantId, phone: canonical },
        },
        update: {}, // già esiste → nessun aggiornamento necessario
        create: {
          tenantId: c.tenantId,
          contactId: c.id,
          phone: canonical,
          isPrimary: true,
        },
      });

      // Aggiorna anche Contact.phone nel nuovo formato canonico
      if (c.phone !== canonical) {
        await prisma.contact.update({
          where: { id: c.id },
          data: { phone: canonical },
        });
      }

      created++;
    } catch (err) {
      console.error(`  ✗ Contatto ${c.id} (${c.phone}): ${err.message}`);
      errors++;
    }
  }

  console.log(`\nRisultato:`);
  console.log(`  ✓ Creati/aggiornati: ${created}`);
  console.log(`  ⚠ Saltati (numero non valido): ${skipped}`);
  console.log(`  ✗ Errori: ${errors}`);
  console.log('\nMigrazione completata.');
}

main()
  .catch((err) => { console.error('Errore fatale:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
