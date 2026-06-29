import { prisma } from '../db/prisma.js';

export async function buildSystemPrompt(tenantId, userId = null, isTraining = false, extraContext = null, agentId = null, agentOverride = null) {
  // ── Carica la configurazione dell'agente ────────────────────────────────────
  // Priorità: agentOverride (draft temporaneo per test) > agentId (agente in DB) > TrainingConfig legacy
  let agentData = null;

  if (agentOverride && typeof agentOverride === 'object') {
    // Draft passato direttamente (es. da /test senza salvare)
    agentData = agentOverride;
  } else if (agentId) {
    try {
      agentData = await prisma.agent.findFirst({ where: { id: agentId, tenantId } });
    } catch { /* non blocca */ }
  }

  // Se non c'è un agente specifico, cerca l'agente di default del tenant
  if (!agentData) {
    try {
      agentData = await prisma.agent.findFirst({ where: { tenantId, isDefault: true } });
    } catch { /* non blocca */ }
  }

  // Fallback: TrainingConfig legacy
  let t = null;
  if (!agentData) {
    try {
      t = await prisma.trainingConfig.findUnique({ where: { tenantId } });
    } catch { /* non blocca */ }
  }

  // Usa agentData o TrainingConfig legacy
  const config = agentData || t;

  const sections = [];

  // Prompt di addestramento: usa agentData se disponibile, altrimenti TrainingConfig legacy
  const profile = userId ? await prisma.userProfile.findUnique({ where: { userId } }).catch(() => null) : null;

  // Nome agente per il contesto
  const agentName = agentData?.name || null;

  if (config) {
    if (config.mainPrompt)   sections.push(config.mainPrompt);
    if (config.personality)  sections.push(`Personalità:\n${config.personality}`);
    if (config.rules)        sections.push(`Regole da rispettare sempre:\n${config.rules}`);
    if (config.context)      sections.push(`Contesto:\n${config.context}`);
    if (config.instructions) sections.push(`Istruzioni permanenti:\n${config.instructions}`);
  }

  if (!sections.length) {
    sections.push(`Sei ${agentName || 'Sophia'}, un assistente intelligente, utile e professionale.`);
  }

  // Se c'è un nome agente, iniettalo come istruzione di identità
  if (agentName) {
    sections[0] = `[Sei ${agentName}]\n${sections[0]}`;
  }

  // Istruzioni operative sui tool
  sections.push(`[ISTRUZIONI OPERATIVE — OBBLIGATORIE]

MODULI PDF (compiler): per inviare moduli PDF ai contatti usa compiler__send_form (prima usa compiler__list_forms per trovare il formId, poi specifica contactCategory o contactIds e il canale). Per vedere le compilazioni ricevute usa compiler__get_submissions.
Se l'utente dice "quando compila mandami X" o "dopo la compilazione fai Y" o "inviami la conferma quando ha finito": usa il campo onCompleted di send_form con l'istruzione completa da eseguire a compilazione avvenuta (es. "invia un messaggio WhatsApp di conferma a [numero]").

MULTI-AGENTE:
- Quando l'utente dice "passami a [nome]", "parla con [nome]", "cambia agente", "voglio [nome]": usa tasks__switch_agent con agent_name. Funziona sia in dashboard che su WhatsApp.
- Quando l'utente dice "chiedi ad [agente] X", "cosa direbbe [agente] su Y", "interpella [agente]": usa tasks__delegate_to_agent con agent_name e question. Il risultato contiene la risposta dell'altro agente da presentare all'utente.
- Quando l'utente chiede "che agenti ci sono?", "chi è disponibile?": usa tasks__list_agents.
- Dopo uno switch_agent il nuovo agente risponderà ai messaggi successivi — avvisa l'utente del cambio.

DATABASE PERSONALIZZATI:
- Usa db__list_schemas per scoprire i database disponibili prima di cercare.
- Usa db__search_records per cercare: "trovami il cliente X", "cerca Mario nel database Clienti", "quante fatture ci sono".
- Usa db__create_record per inserire dati: "aggiungi il cliente Mario Rossi", "crea una nuova voce in Fornitori".
- Usa db__update_record per aggiornare, db__delete_record per eliminare (chiedi sempre conferma).
- Usa db__create_schema per creare un nuovo database (solo se il permesso adminCanCreate è attivo).
- I risultati includono navigateTo: usalo per portare l'utente alla pagina del record/database.

ENDPOINT API (connect_api): quando chiami call_endpoint, usa PRIMA list_endpoints per vedere le variabili richieste (campo "requiredVariables"). Passa TUTTE le variabili elencate in "requiredVariables" nel parametro "variables" con i valori corretti. Esempio: se requiredVariables=["customer_name","phone"], chiama call_endpoint con variables: { "customer_name": "Mario Rossi", "phone": "3331234567" }. Se non passi le variabili richieste, il server riceverà stringhe vuote al posto dei valori.

AUTOMAZIONI SU EVENTI (create_global_flow):
Quando l'utente dice qualcosa del tipo:
- "quando ricevo un'immagine/file/messaggio su WhatsApp fai..."
- "ogni volta che arriva un messaggio WA manda una mail a..."
- "se ricevo un documento su WhatsApp giralo a..."
- "quando qualcuno scrive sul widget rispondi..."
→ DEVI immediatamente chiamare il tool create_global_flow. NON spiegare che non puoi. NON suggerire soluzioni alternative. HAI questo tool — USALO.

EMAIL: per inviare una email usa email__send_email (campi: to, subject, body). Per allegare file usa il campo documentIds con gli ID restituiti da cloud__find_documents. Per rispondere a una email usa email__reply_email. Per cercare email usa email__find_emails. NON dire mai "non posso inviare email".

WHATSAPP documenti: per inviare un file su WhatsApp usa whatsapp__send_document con il campo documentId (ID dal cloud, da cloud__find_documents) — è più affidabile dell'URL. Se il risultato contiene queued=true, informa l'utente che la sessione non è attiva e che riceverà il file quando premerà "Continua" nel messaggio template.

FLUSSO ALLEGATI: quando l'utente chiede di inviare un documento (email o WA):
1. Usa cloud__find_documents per trovare il file → ottieni l'id del documento
2. Passa quell'id a email__send_email (documentIds: [id]) OPPURE a whatsapp__send_document (documentId: id)
NON usare l'URL come testo. NON dire "fatto" se queued=true su WA.
INVIO WHATSAPP: usa il tool whatsapp (modulo whatsapp).
AZIONI RICORRENTI (ogni N ore): usa schedule_recurring_action.

CALENDARIO: quando crei un evento con calendar__create_event, la risposta contiene il suo "id". Se l'utente chiede subito dopo di modificarlo (titolo, luogo, calendario, orario), usa calendar__update_event con quell'id — NON creare un nuovo evento. Per specificare il calendario usa calendarName (es. "Personale"). Se il calendario non esiste viene creato automaticamente.

RUBRICA — REGOLA FONDAMENTALE:
Ogni persona con cui interagisci (dashboard o WhatsApp) ha UN SOLO contatto in rubrica. Tutti i dati raccolti vanno su quel contatto. I dati da raccogliere configurati (es. codice_fiscale) vanno SEMPRE in customFields, MAI nelle note.
- Se nel contesto è indicato il numero di telefono dell'interlocutore, usalo per identificare/creare il contatto.
- Se l'utente dashboard ha un contatto collegato (indicato nel contesto), usalo come riferimento.
- Prima di dire che un contatto non esiste, cerca SEMPRE con contacts__find_contacts.
- "Che contatti hai?" → usa contacts__list_contacts.
- Per salvare dati raccolti → contacts__save_contact con customFields: { "chiave": "valore" }.

DOCUMENTI (cloud__find_documents):
- "la mia carta identità", "i miei documenti" → NON passare contactName (il sistema usa il tuo contatto automaticamente).
- "i documenti di Mario", "le fatture di Stefano" → passa contactName.
- Per inviare file: usa whatsapp__send_document o allega a email. Mai incollare URL come testo.

PERMESSI DOCUMENTI (cloud__grant_folder_access — solo admin in dashboard):
- "garantisci/dai accesso ai file/documenti di [contatto] all'utente [nome]", "fai vedere i documenti di X a Y" → usa cloud__grant_folder_access con contactName e userName (permission "read" o "write").
- "togli/revoca l'accesso ai documenti di X a Y" → stessa tool con revoke=true.

GENERAZIONE IMMAGINI (images__generate): genera l'immagine e mostra inline con markdown: ![immagine](URL).
INVIO IMMAGINE SU WHATSAPP: usa whatsapp__send_image con l'URL restituito.

REGOLA ASSOLUTA: mai dire "non posso automatizzare" o "non ho accesso a". Se il tool esiste nel contesto, usalo.`);

  // ── Ora corrente (fix definitivo del timezone) ─────────────────────────────
  // Usa longOffset che ritorna "GMT+02:00" — formato stabile e parsabile
  {
    const now = new Date();
    const tzLong = new Intl.DateTimeFormat('en', {
      timeZone: 'Europe/Rome',
      timeZoneName: 'longOffset',
    }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value || 'GMT+02:00';
    // tzLong = "GMT+02:00" → estraiamo "+02:00"
    const tzStr = tzLong.replace('GMT', '') || '+02:00';

    const nowItaly = now.toLocaleString('it-IT', {
      timeZone: 'Europe/Rome',
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    // Costruisce ISO con offset corretto: "2026-06-28T19:57:00+02:00"
    const romeParts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Rome',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).format(now);
    const romeIso = romeParts.replace(' ', 'T') + tzStr;

    sections.push(`[Data e ora corrente]
Ora italiana: ${nowItaly}
ISO con timezone: ${romeIso}
Offset: ${tzStr}

IMPORTANTE per tasks__schedule_once: il campo run_at DEVE essere ISO 8601 con timezone esplicito.
Esempio — se sono le 19:57 e l'utente dice "tra 2 minuti": run_at = "${
  (() => {
    const t2 = new Date(now.getTime() + 2 * 60000);
    const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(t2);
    return p.replace(' ', 'T') + tzStr;
  })()
}"
Non usare mai Z (UTC) per orari italiani.`);
  }

  // ── Contesto utente / contatto collegato ───────────────────────────────────
  if (!isTraining) {
    const ctxParts = [];

    // Numero WA dell'utente dashboard (per "mandami su WhatsApp")
    if (profile?.whatsappNumber) {
      ctxParts.push(`Numero WhatsApp dell'utente: ${profile.whatsappNumber} — usalo come destinatario predefinito.`);
    }

    // Contatto in rubrica collegato all'utente dashboard
    if (profile?.contactId) {
      try {
        const contact = await prisma.contact.findUnique({ where: { id: profile.contactId } });
        if (contact) {
          const fields = [];
          if (contact.firstName || contact.lastName) fields.push(`Nome: ${[contact.firstName, contact.lastName].filter(Boolean).join(' ')}`);
          if (contact.email)    fields.push(`Email: ${contact.email}`);
          if (contact.phone)    fields.push(`Telefono: ${contact.phone}`);
          if (contact.company)  fields.push(`Azienda: ${contact.company}`);
          if (contact.jobRole)  fields.push(`Ruolo: ${contact.jobRole}`);
          if (contact.city)     fields.push(`Città: ${contact.city}`);
          // Campi personalizzati (include dati da raccogliere come codice_fiscale)
          if (contact.customFields && typeof contact.customFields === 'object') {
            const cf = contact.customFields;
            for (const [k, v] of Object.entries(cf)) {
              if (v) fields.push(`${k}: ${v}`);
            }
          }
          if (contact.notes) fields.push(`Note: ${contact.notes}`);
          ctxParts.push(`Contatto in rubrica dell'utente (ID: ${contact.id}):\n${fields.join('\n')}\n→ Quando l'utente fornisce nuovi dati, aggiorna QUESTO contatto (usa l'ID sopra o il telefono/email per identificarlo).`);
        }
      } catch { /* non blocca */ }
    }

    if (ctxParts.length) {
      sections.push(`[Utente corrente]\n${ctxParts.join('\n\n')}`);
    }
  }

  // ── Campi da raccogliere ────────────────────────────────────────────────────
  if (tenantId) {
    try {
      const fields = await prisma.collectField.findMany({
        where: { tenantId, active: true },
        orderBy: { order: 'asc' },
      });
      if (fields.length > 0) {
        const fieldList = fields.map(f =>
          `- ${f.label} (chiave: ${f.key}${f.required ? ', OBBLIGATORIO' : ''})${f.description ? ': ' + f.description : ''}`
        ).join('\n');
        sections.push(`[DATI DA RACCOGLIERE]
Raccogli questi dati durante la conversazione in modo naturale. Salvali SEMPRE in contacts__save_contact nel campo customFields come oggetto JSON: { "${fields[0]?.key || 'chiave'}": "valore" }.
NON metterli nelle note. Un campo alla volta, non chiedere tutto insieme.

Campi da raccogliere:
${fieldList}`);
      }
    } catch { /* non blocca */ }
  }

  // ── Lista agenti disponibili (per switch/delegate) ─────────────────────────
  if (tenantId && !isTraining) {
    try {
      const availableAgents = await prisma.agent.findMany({
        where: { tenantId },
        select: { id: true, name: true, description: true, isDefault: true },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      });
      if (availableAgents.length > 1) {
        const agentList = availableAgents.map(a =>
          `- ${a.name}${a.description ? ` (${a.description})` : ''}${a.isDefault ? ' [predefinito]' : ''}`
        ).join('\n');
        sections.push(`[AGENTI DISPONIBILI]\nPuoi switchare o delegare a questi agenti con tasks__switch_agent / tasks__delegate_to_agent:\n${agentList}`);
      }
    } catch { /* non blocca */ }
  }

  if (extraContext && typeof extraContext === 'string' && extraContext.trim()) {
    sections.push(`[Contesto della conversazione]\n${extraContext.trim()}`);
  }

  return sections.join('\n\n');
}
