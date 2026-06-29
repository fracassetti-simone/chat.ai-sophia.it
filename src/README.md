# Sophia (PH) — Piattaforma AI multi-tenant modulare

Fondamenta reali e funzionanti di una piattaforma SaaS AI multi-tenant: backend Node.js/Express
con architettura a plugin, autenticazione JWT, isolamento per azienda, motore AI con tool-calling
in streaming, e frontend React/Vite con interfaccia SaaS pulita.

---

## In tutta onestà: cosa è questo pacchetto

La specifica descrive un intero prodotto commerciale (mesi di lavoro di un team). In un singolo
passaggio **non è possibile** consegnare l'intera piattaforma testata e pronta alla produzione —
e la specifica stessa chiede "nessun mockup, ogni funzionalità realmente implementata". Per
rispettare quel principio ho costruito un **nucleo reale e verificato** invece di un'impalcatura
finta e più ampia.

### Implementato e verificato

**Backend (37 file, validati sintatticamente; architettura a plugin testata)**
- Multi-tenancy con isolamento dati per azienda
- Auth JWT con access + refresh token (rotazione), hashing Argon2id
- RBAC granulare (permessi `risorsa:azione`) con Super Admin / Admin / Utente
- **Architettura a plugin**: scoperta automatica dei moduli, nessuna modifica al core per aggiungerne
- Tre moduli di default reali: **Email** (SMTP multipli via nodemailer), **WhatsApp** (invio via
  Cloud API, con avviso versione iniziale), **Connetti API** (l'AI invoca solo endpoint autorizzati)
- Motore AI: assemblaggio del system prompt dall'Addestramento, capability dei moduli esposte come
  tool, **risposta in streaming** con ciclo di tool-calling
- Sezione Addestramento (prompt persistente), gestione API Key, configuratore Embed
- Upload e parsing documenti (PDF, DOCX, TXT, Markdown) + import documentazione API
- Sicurezza: Helmet, CORS, rate limit, validazione input (zod), audit log
- Migrazioni automatiche all'avvio e creazione del primo Super Admin

**Frontend (React + Vite, build di produzione verificata)**
- Design flat, minimale, primario blu + scala di grigi, icone Lucide, nessuna emoji
- Login, shell con sidebar moderna, dashboard live
- **Chat** completa: cronologia, ricerca, rinomina/elimina, streaming, Markdown, syntax highlighting,
  copia codice, allegati, microfono (riconoscimento vocale del browser)
- Pagine Addestramento, Moduli (con config SMTP/WhatsApp), Connetti API (tabella + import),
  Utenti, Aziende, API Key, Embed (configuratore + snippet), Impostazioni

### Da completare nelle iterazioni successive
Questi punti hanno il backend pronto ma meritano rifinitura UI/funzionale: editor avanzato della
tabella endpoint (header/query/body strutturati), assegnazione permessi per-utente nell'interfaccia,
servizio runtime pubblico del widget Embed (`/widget.js`) e l'autenticazione via API Key sulle
richieste in ingresso. Sono indicati come prossimi passi, non come funzioni "finte".

### Cosa richiede il tuo ambiente (non eseguibile in questa sandbox)
- **`prisma generate` / `migrate`**: l'host dei binari Prisma è bloccato dalla rete della sandbox;
  sul tuo computer (con internet) funziona normalmente.
- **PostgreSQL** in esecuzione (incluso `docker-compose.yml`).
- **Chiave OpenAI** nel `.env`. Imposta in `OPENAI_MODEL` l'**esatta stringa modello** fornita da
  OpenAI: il codice è agnostico rispetto al modello e non ha nomi hardcoded.

---

## Avvio rapido

```bash
# 1) Database
docker compose up -d db

# 2) Backend
cd backend
cp .env.example .env          # inserisci OPENAI_API_KEY e segreti JWT
npm install
npm run prisma:generate
npm run dev                   # crea schema + Super Admin, avvia su :4000

# 3) Frontend (altra shell)
cd frontend
npm install
npm run dev                   # avvia su :5173
```

Accedi con le credenziali iniziali: **simone@phi.it** / **Ciao123!**
(modificabile da Impostazioni). Come Super Admin, crea un'azienda da "Aziende", selezionala come
contesto attivo, poi usa Chat, Moduli, Addestramento, ecc.

---

## Architettura

```
sophia/
├─ backend/
│  ├─ prisma/schema.prisma        Modello dati multi-tenant
│  ├─ src/
│  │  ├─ config/                  Config validata (zod) + logger
│  │  ├─ db/                      Client Prisma + bootstrap (migrate + seed)
│  │  ├─ middleware/              auth, tenant scope, RBAC, errori
│  │  ├─ modules/                 ARCHITETTURA A PLUGIN
│  │  │  ├─ base.js               defineModule(), contratto capability
│  │  │  ├─ registry.js           scoperta + risoluzione capability per tenant
│  │  │  ├─ email/  whatsapp/  connect-api/
│  │  ├─ ai/                      OpenAI, system prompt, motore streaming
│  │  ├─ routes/                  REST per ogni risorsa
│  │  ├─ realtime/                Socket.io (stanze per tenant)
│  │  └─ services/                audit, estrazione testo, import doc API
│  └─ docker-compose.yml
└─ frontend/                      React + Vite (design system, pagine)
```

### Aggiungere un nuovo modulo (senza toccare il core)

Crea `backend/src/modules/<chiave>/index.js`:

```js
import { defineModule } from '../base.js';

export default defineModule({
  key: 'sms',
  name: 'SMS',
  description: 'Invia SMS.',
  defaultInstalled: false,
  capabilities: [{
    name: 'send',
    description: 'Invia un SMS a un numero.',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string' }, text: { type: 'string' } },
      required: ['to', 'text'],
    },
    async handler(ctx, args) {
      // ctx.tenantId, ctx.config, ctx.prisma
      return { ok: true };
    },
  }],
});
```

Al riavvio il registry lo scopre da solo e l'AI lo espone come tool `sms__send` ai tenant che
lo attivano. Il core non va modificato.

---

## Note di sicurezza
Le password sono hashate con Argon2id; i refresh token sono salvati solo come hash e ruotati a ogni
uso; le API Key sono mostrate in chiaro una sola volta. In produzione genera segreti JWT robusti
(`openssl rand -hex 48`) e usa HTTPS.
