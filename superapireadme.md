# Super Token API

Il **Super Token API** è una credenziale a livello di piattaforma che autentica
come **Super Admin di sistema**. A differenza delle normali API Key (legate a una
singola azienda/tenant), un super token può chiamare **qualsiasi endpoint di
qualsiasi tenant** e consultare l'elenco completo delle aziende.

> ⚠️ **Attenzione**: un super token bypassa completamente l'isolamento tra
> aziende. Trattalo come una password root. Chiunque lo possieda ha accesso
> totale a tutti i dati di tutti i tenant.

---

## Chi può gestirlo

Solo i **Super Admin** autenticati via login web possono **generare**,
**visualizzare** (prefisso e metadati) e **revocare** i super token.

- Un super token **non** può a sua volta creare o revocare altri super token.
- La chiave in chiaro viene mostrata **una sola volta**, al momento della
  generazione. In database è salvato solo l'hash SHA-256.

### Dove si gestisce

Pannello web → **Amministrazione → API Key** → sezione **"Super token API"**
(in alto, solo per Super Admin).

Da lì puoi:
- **Generare** un nuovo super token (assegnandogli un nome riconoscibile).
- **Vedere** l'elenco dei token con prefisso, ultima attività e stato.
- **Revocare** un token (lo disabilita immediatamente, conservando lo storico).
- **Eliminare** definitivamente un token.

---

## Formato del token

```
sphsuper_<64 caratteri esadecimali>
```

Il prefisso `sphsuper_` è ciò che distingue un super token da un access token
utente. Nelle liste viene mostrato solo il prefisso (es. `sphsuper_a1b2c3…`).

---

## Come usarlo

Invia il token nell'header `Authorization` come Bearer token:

```
Authorization: Bearer sphsuper_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 1. Elencare tutte le aziende (tenant)

```bash
curl https://<host>/api/tenants \
  -H "Authorization: Bearer $SUPER_TOKEN"
```

Restituisce tutte le aziende presenti sulla piattaforma.

### 2. Chiamare un endpoint di una specifica azienda

Per gli endpoint legati a un tenant, seleziona l'azienda di destinazione con
l'header **`X-Tenant-Id`** (stesso meccanismo usato dal Super Admin nel pannello
web). Il valore è l'`id` dell'azienda ottenuto da `GET /api/tenants`.

```bash
# Contatti dell'azienda con id "ckxyz..."
curl https://<host>/api/contacts \
  -H "Authorization: Bearer $SUPER_TOKEN" \
  -H "X-Tenant-Id: ckxyz..."
```

```bash
# Credenziali SIP di un'altra azienda
curl https://<host>/api/sip \
  -H "Authorization: Bearer $SUPER_TOKEN" \
  -H "X-Tenant-Id: ckabc..."
```

```bash
# Creare una risorsa in un tenant (POST con body JSON)
curl -X POST https://<host>/api/contacts \
  -H "Authorization: Bearer $SUPER_TOKEN" \
  -H "X-Tenant-Id: ckxyz..." \
  -H "Content-Type: application/json" \
  -d '{ "name": "Mario Rossi", "phone": "+39320..." }'
```

> Se ometti `X-Tenant-Id` su un endpoint che richiede un'azienda, la richiesta
> verrà rifiutata con `403 Nessuna azienda selezionata`. Aggiungi sempre
> l'header per gli endpoint tenant-scoped.

---

## Endpoint di gestione (solo login web)

Questi endpoint richiedono un Super Admin autenticato via JWT (non sono
utilizzabili con un super token):

| Metodo | Endpoint                       | Descrizione                          |
|--------|--------------------------------|--------------------------------------|
| GET    | `/api/super-tokens`            | Elenca i super token (no chiave).    |
| POST   | `/api/super-tokens`            | Genera un token. Ritorna `secret`.   |
| POST   | `/api/super-tokens/:id/revoke` | Revoca (disabilita) un token.        |
| DELETE | `/api/super-tokens/:id`        | Elimina definitivamente un token.    |

Esempio di creazione (con sessione Super Admin):

```bash
curl -X POST https://<host>/api/super-tokens \
  -H "Authorization: Bearer <ACCESS_TOKEN_SUPER_ADMIN>" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Integrazione interna" }'
```

Risposta (la chiave `secret` è mostrata solo qui):

```json
{
  "token": { "id": "ck...", "name": "Integrazione interna", "prefix": "sphsuper_a1b2c3", "createdAt": "..." },
  "secret": "sphsuper_a1b2c3..."
}
```

---

## Sicurezza e buone pratiche

- **Conserva il token in un secret manager**, mai nel codice o in repository.
- **Revoca subito** un token compromesso dalla sezione "Super token API".
- Usa **un token per integrazione** così da poterli revocare singolarmente.
- L'attività di ogni token è tracciata tramite il campo `lastUsedAt` e gli
  eventi di audit (`super-token.create`, `super-token.revoke`,
  `super-token.delete`).
- Le richieste effettuate con un super token risultano nell'audit con `userId`
  nullo (utente di sistema), distinguibili dalle azioni di utenti reali.
