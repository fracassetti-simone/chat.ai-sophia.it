# Come applicare questa patch

Estrai lo zip e copia i file nella cartella del tuo progetto Sophia,
rispettando la struttura delle cartelle.

## Struttura patch → destinazione nel progetto

```
patch/
├── frontend/src/
│   ├── pages/
│   │   ├── Chat.jsx         → frontend/src/pages/Chat.jsx        (SOSTITUISCI)
│   │   ├── Modules.jsx      → frontend/src/pages/Modules.jsx     (SOSTITUISCI)
│   │   └── Training.jsx     → frontend/src/pages/Training.jsx    (SOSTITUISCI)
│   ├── styles/
│   │   └── app.css          → frontend/src/styles/app.css        (SOSTITUISCI)
│   └── lib/
│       └── api.js           → frontend/src/lib/api.js            (SOSTITUISCI)
│
└── backend/
    ├── prisma/
    │   └── schema.prisma    → backend/prisma/schema.prisma       (SOSTITUISCI)
    └── src/
        ├── config/
        │   └── index.js     → backend/src/config/index.js        (SOSTITUISCI)
        ├── modules/
        │   └── gemini/
        │       └── index.js → backend/src/modules/gemini/index.js (NUOVO FILE)
        └── routes/
            ├── index.js         → backend/src/routes/index.js         (SOSTITUISCI)
            ├── embed.js         → backend/src/routes/embed.js          (SOSTITUISCI)
            ├── conversations.js → backend/src/routes/conversations.js  (SOSTITUISCI)
            ├── whatsapp.js      → backend/src/routes/whatsapp.js       (SOSTITUISCI)
            ├── phone.js             → backend/src/routes/phone.js          (NUOVO FILE)
            ├── whatsapp-chat.js     → backend/src/routes/whatsapp-chat.js  (NUOVO FILE)
            ├── gemini.js            → backend/src/routes/gemini.js         (NUOVO FILE)
            ├── training-docs.js     → backend/src/routes/training-docs.js  (NUOVO FILE)
            └── training-chat.js     → backend/src/routes/training-chat.js  (NUOVO FILE)
```

## Dopo aver copiato i file

### 1. Aggiorna il .env del backend

Apri `backend/.env` e aggiungi queste righe:

```
# Chiave OTP ai-sophia (per collegamento numero WhatsApp)
OTP_API_KEY=la-tua-chiave-da-otp.ai-sophia.it

# URL pubblico API (usato nello snippet embed)
PUBLIC_API_URL=https://api.ai-sophia.it
```

### 2. Migra il database

```bash
cd backend
npx prisma migrate dev --name add_phone_gemini_training
# oppure in produzione:
npx prisma migrate deploy
```

### 3. Riavvia backend e frontend

```bash
# Backend
cd backend && npm run dev

# Frontend (altra finestra)
cd frontend && npm run dev
```

## Note importanti

- **Gemini API Key**: NON va nel .env. Va configurata dal pannello
  Moduli → Gemini AI → Configura, per ogni tenant.

- **Modulo Gemini**: deve essere installato e attivato da un SUPER_ADMIN
  nella sezione Moduli. Solo dopo appare "Gemini AI" nella lista.

- **Allegati**: ora vengono mostrati come chip sopra la textarea.
  Clicca 🖇️ per allegare, la X per rimuovere. Il file viene caricato
  solo al momento dell'invio.

- **Chat WhatsApp sincronizzata**: appare in cima alla lista chat
  con bordo verde dopo aver collegato il numero da "Collega WhatsApp".
