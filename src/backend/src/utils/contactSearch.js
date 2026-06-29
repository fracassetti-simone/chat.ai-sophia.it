// Costruisce la clausola di ricerca contatti tollerante ai nomi composti.
//
// Problema risolto: cercando "Simone Fracassetti" come stringa unica contro i
// singoli campi (firstName/lastName), un contatto con nome "Simone" e cognome
// "Fracassetti" non veniva trovato. Qui spezziamo la query in parole: ogni
// parola deve comparire in almeno un campo (AND tra parole, OR tra campi).

export function contactSearchWhere(query) {
  const tokens = String(query || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) return {};

  const perToken = tokens.map((tok) => {
    const or = [
      { firstName: { contains: tok, mode: 'insensitive' } },
      { lastName: { contains: tok, mode: 'insensitive' } },
      { company: { contains: tok, mode: 'insensitive' } },
      { email: { contains: tok, mode: 'insensitive' } },
      { city: { contains: tok, mode: 'insensitive' } },
    ];
    const digits = tok.replace(/\D/g, '');
    if (digits.length >= 3) or.push({ phone: { contains: digits } });
    return { OR: or };
  });

  return perToken.length === 1 ? perToken[0] : { AND: perToken };
}
