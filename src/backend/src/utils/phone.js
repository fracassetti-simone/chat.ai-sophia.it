// Normalizzazione numeri di telefono in formato E.164 senza "+".
//
// Accetta input "sporchi" come "+39 333 123 4567", "0039-333-1234567",
// "333 123 4567" e li riduce alla sola sequenza di cifre internazionale.
// Per i numeri italiani senza prefisso (es. "333..." o "0333...") aggiunge
// automaticamente il 39, così l'utente non deve preoccuparsi delle regole.

const DEFAULT_COUNTRY = '39'; // Italia

export function normalizePhone(raw, defaultCountry = DEFAULT_COUNTRY) {
  if (!raw) return '';
  let s = String(raw).trim();

  // Prefisso internazionale "00" → equivale a "+"
  if (s.startsWith('00')) s = '+' + s.slice(2);

  const hadPlus = s.startsWith('+');
  // Tieni solo le cifre
  let digits = s.replace(/\D/g, '');
  if (!digits) return '';

  if (hadPlus) return digits; // già internazionale

  // Numero italiano scritto come 0xxxxxxxxx (fisso) o 3xxxxxxxxx (mobile)
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  // Se non inizia già col prefisso paese, anteponilo
  if (!digits.startsWith(defaultCountry)) digits = defaultCountry + digits;
  return digits;
}

// Versione leggibile per la UI: +39 333 123 4567 (best-effort, italiano).
export function prettyPhone(e164) {
  if (!e164) return '';
  const d = String(e164).replace(/\D/g, '');
  if (d.startsWith('39') && d.length >= 11) {
    const rest = d.slice(2);
    return `+39 ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`.trim();
  }
  return '+' + d;
}
