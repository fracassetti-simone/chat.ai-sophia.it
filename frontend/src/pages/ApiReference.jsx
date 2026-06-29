import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check, KeyRound, ExternalLink } from 'lucide-react';

const BASE = 'https://api.ai-sophia.it';

function Badge({ method }) {
  const colors = { GET:'#16a34a', POST:'#2563eb', PATCH:'#ea580c', DELETE:'#dc2626', PUT:'#7c3aed' };
  return <span className="api-method" style={{ background: colors[method]||'#64748b' }}>{method}</span>;
}

function Code({ lang, children }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(children); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return (
    <div className="api-code-block">
      <div className="api-code-head">
        <span className="api-code-lang">{lang}</span>
        <button className="api-copy" onClick={copy}>{copied ? <><Check size={12}/> Copiato</> : <><Copy size={12}/> Copia</>}</button>
      </div>
      <pre><code>{children}</code></pre>
    </div>
  );
}

function Endpoint({ method, path, title, description, auth, params, body, response, example }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`api-endpoint${open?' open':''}`}>
      <button className="api-endpoint-head" onClick={() => setOpen(o=>!o)}>
        <Badge method={method}/>
        <code className="api-path">{path}</code>
        <span className="api-title">{title}</span>
        {auth && <span className="api-auth-badge">🔑 Auth</span>}
        {open ? <ChevronDown size={15} style={{marginLeft:'auto',color:'var(--gray-400)'}}/> : <ChevronRight size={15} style={{marginLeft:'auto',color:'var(--gray-400)'}}/>}
      </button>
      {open && (
        <div className="api-endpoint-body">
          {description && <p className="api-desc">{description}</p>}
          {auth && <div className="api-notice">Richiede header <code>Authorization: Bearer {'<token>'}</code>{auth === 'tenant' ? <> e <code>X-Tenant-Id: {'<tenantId>'}</code></> : ''}.</div>}
          {params && <><h4 className="api-section-title">Parametri query</h4><div className="api-params">{Object.entries(params).map(([k,v]) => <div key={k} className="api-param"><code>{k}</code><span>{v}</span></div>)}</div></>}
          {body && <><h4 className="api-section-title">Body (JSON)</h4><div className="api-params">{Object.entries(body).map(([k,v]) => <div key={k} className="api-param"><code>{k}</code><span>{v}</span></div>)}</div></>}
          {response && <><h4 className="api-section-title">Risposta</h4><Code lang="json">{JSON.stringify(response,null,2)}</Code></>}
          {example && <><h4 className="api-section-title">Esempio</h4><Code lang="bash">{example}</Code></>}
        </div>
      )}
    </div>
  );
}

function Section({ title, description, children }) {
  return (
    <section className="api-section">
      <h2 className="api-section-h2">{title}</h2>
      {description && <p className="api-section-desc">{description}</p>}
      {children}
    </section>
  );
}

export default function ApiReference() {
  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">Riferimento API</h1>
          <p className="page-subtitle">Documentazione completa delle REST API di Sophia. URL base: <code>{BASE}</code></p>
        </div>
        <a className="btn btn-outline" href="/apikeys" style={{textDecoration:'none'}}><KeyRound size={15}/> Gestisci API Key</a>
      </div>

      <div className="api-intro card panel">
        <h3 className="panel-title">Autenticazione</h3>
        <p>Tutte le chiamate autenticate richiedono un header <code>Authorization</code> con un Bearer token JWT ottenuto da <code>POST /api/auth/login</code>, oppure una API Key da <code>X-Api-Key</code>.</p>
        <p>Le route tenant-scoped richiedono anche <code>X-Tenant-Id</code>.</p>
        <Code lang="bash">{`# Con JWT
curl -H "Authorization: Bearer <token>" -H "X-Tenant-Id: <tenantId>" ${BASE}/api/...

# Con API Key
curl -H "X-Api-Key: sk_..." -H "X-Tenant-Id: <tenantId>" ${BASE}/api/...`}</Code>
      </div>

      <Section title="Autenticazione" description="Login, refresh token e gestione password.">
        <Endpoint method="POST" path="/api/auth/login" title="Login"
          body={{ email:'string — email utente', password:'string — password' }}
          response={{ accessToken:'string', refreshToken:'string', user:{ id:'string', email:'string', role:'string', tenantId:'string|null' } }}
          example={`curl -X POST ${BASE}/api/auth/login \\\n  -H "Content-Type: application/json" \\\n  -d '{"email":"admin@azienda.it","password":"password123"}'`} />
        <Endpoint method="POST" path="/api/auth/refresh" title="Refresh token"
          body={{ refreshToken:'string — refresh token ottenuto al login' }}
          response={{ accessToken:'string — nuovo access token' }} />
        <Endpoint method="POST" path="/api/auth/forgot-password" title="Richiesta reset password"
          description="Risponde sempre OK per non rivelare se l'email è registrata."
          body={{ email:'string' }} response={{ ok:true }} />
        <Endpoint method="POST" path="/api/auth/change-password" title="Cambia password" auth="user"
          body={{ currentPassword:'string', newPassword:'string (min 8 caratteri)' }}
          response={{ ok:true }} />
      </Section>

      <Section title="Conversazioni" description="Chat AI interne alla dashboard.">
        <Endpoint method="GET" path="/api/conversations" title="Lista conversazioni" auth="tenant"
          params={{ q:'string — ricerca per titolo' }}
          response={{ conversations:[{ id:'string', title:'string', updatedAt:'datetime' }] }} />
        <Endpoint method="POST" path="/api/conversations" title="Crea conversazione" auth="tenant"
          response={{ conversation:{ id:'string', title:'string' } }} />
        <Endpoint method="POST" path="/api/conversations/:id/chat" title="Invia messaggio (streaming SSE)" auth="tenant"
          description="Risponde in streaming Server-Sent Events. Ogni evento ha type=token|tool|done|error."
          body={{ content:'string — messaggio utente', documentIds:'string[] — allegati opzionali', isTraining:'boolean' }}
          example={`curl -N -X POST ${BASE}/api/conversations/CONV_ID/chat \\\n  -H "Authorization: Bearer TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: text/event-stream" \\\n  -d '{"content":"Ciao!"}'`} />
        <Endpoint method="DELETE" path="/api/conversations/:id" title="Elimina conversazione" auth="tenant" response={{ ok:true }} />
      </Section>

      <Section title="Widget / Chat esterne" description="Messaggi in ingresso da siti web o WhatsApp.">
        <Endpoint method="GET" path="/api/external-chats" title="Lista chat esterne" auth="tenant"
          params={{ source:'WHATSAPP|WIDGET', q:'ricerca' }}
          response={{ chats:[{ id:'string', externalId:'string', source:'string', displayName:'string', lastMessageAt:'datetime', unreadCount:'number' }] }} />
        <Endpoint method="GET" path="/api/external-chats/:id/messages" title="Messaggi di una chat" auth="tenant"
          response={{ messages:[{ id:'string', role:'customer|operator|ai', content:'string', createdAt:'datetime', attachments:'array' }] }} />
        <Endpoint method="POST" path="/api/external-chats/:id/reply" title="Rispondi manualmente" auth="tenant"
          body={{ content:'string' }} response={{ ok:true }} />
      </Section>

      <Section title="Rubrica" description="Gestione contatti CRM.">
        <Endpoint method="GET" path="/api/contacts" title="Lista contatti" auth="tenant"
          params={{ q:'ricerca fulltext', category:'filtro categoria', tag:'filtro tag' }}
          response={{ contacts:[{ id:'string', firstName:'string', lastName:'string', phone:'string', email:'string', company:'string', category:'string', tags:'string[]' }], categories:'string[]', tags:'string[]' }} />
        <Endpoint method="POST" path="/api/contacts" title="Crea contatto" auth="tenant"
          body={{ firstName:'string', lastName:'string', phone:'string (E.164 senza +)', email:'string', company:'string', category:'string', tags:'string[]', notes:'string', customFields:'object' }}
          response={{ contact:{ id:'string' } }} />
        <Endpoint method="PATCH" path="/api/contacts/:id" title="Aggiorna contatto" auth="tenant"
          body={{ '...':'qualsiasi campo del contatto (parziale)' }} response={{ contact:{ id:'string' } }} />
        <Endpoint method="DELETE" path="/api/contacts/:id" title="Elimina contatto" auth="tenant" response={{ ok:true }} />
      </Section>

      <Section title="Cloud documentale">
        <Endpoint method="GET" path="/api/cloud" title="Contenuto cartella" auth="tenant"
          params={{ folderId:'string — vuoto per la root' }}
          response={{ folders:'array', files:'array', breadcrumb:'array' }} />
        <Endpoint method="POST" path="/api/cloud/folders" title="Crea cartella" auth="tenant"
          body={{ name:'string', parentId:'string|null' }} response={{ folder:{ id:'string', name:'string' } }} />
        <Endpoint method="POST" path="/api/cloud/files" title="Upload file (multipart)" auth="tenant"
          description="Content-Type: multipart/form-data"
          body={{ file:'File binario', folderId:'string (opzionale)', tags:'JSON array di stringhe' }}
          response={{ file:{ id:'string', filename:'string', url:'string', downloadUrl:'string' } }} />
        <Endpoint method="GET" path="/api/cloud/search" title="Cerca file" auth="tenant"
          params={{ q:'parola chiave (nome o tag)' }} response={{ files:'array' }} />
      </Section>

      <Section title="Email">
        <Endpoint method="GET" path="/api/email/accounts" title="Lista account email" auth="tenant" response={{ accounts:'array' }} />
        <Endpoint method="POST" path="/api/email/accounts" title="Aggiungi account" auth="tenant"
          body={{ name:'string', email:'string', smtpHost:'string', smtpPort:'number (587)', smtpUser:'string', smtpPass:'string', imapHost:'string (opz)', imapUser:'string (opz)', imapPass:'string (opz)' }}
          response={{ account:{ id:'string' } }} />
        <Endpoint method="POST" path="/api/email/accounts/:id/sync" title="Sincronizza IMAP" auth="tenant"
          response={{ ok:true, newMessages:'number' }} />
        <Endpoint method="POST" path="/api/email/send" title="Invia nuova email" auth="tenant"
          body={{ accountId:'string', to:'string', subject:'string', text:'string', html:'string (opz)' }}
          response={{ ok:true, messageId:'string' }} />
        <Endpoint method="GET" path="/api/email/threads" title="Lista conversazioni email" auth="tenant"
          params={{ accountId:'string (opz)' }} response={{ threads:'array' }} />
        <Endpoint method="POST" path="/api/email/threads/:id/reply" title="Rispondi a thread" auth="tenant"
          body={{ text:'string', html:'string (opz)', attachmentDocIds:'string[]' }} response={{ ok:true }} />
        <Endpoint method="POST" path="/api/email/threads/:id/ai-reply" title="Risposta AI automatica" auth="tenant" response={{ ok:true, text:'string' }} />
      </Section>

      <Section title="Calendario">
        <Endpoint method="GET" path="/api/calendars" title="Lista calendari" auth="tenant"
          response={{ calendars:[{ id:'string', name:'string', color:'string', isDefault:'boolean', canEdit:'boolean' }] }} />
        <Endpoint method="POST" path="/api/calendars" title="Crea calendario" auth="tenant"
          body={{ name:'string', color:'string (hex, es. #2563eb)' }} response={{ calendar:{ id:'string' } }} />
        <Endpoint method="GET" path="/api/calendars/events" title="Lista eventi" auth="tenant"
          params={{ from:'ISO datetime', to:'ISO datetime', calendarId:'string (opz)' }}
          response={{ events:[{ id:'string', title:'string', startAt:'datetime', endAt:'datetime', allDay:'boolean', reminderMin:'number|null' }] }} />
        <Endpoint method="POST" path="/api/calendars/events" title="Crea evento" auth="tenant"
          body={{ calendarId:'string', title:'string', startAt:'datetime ISO', endAt:'datetime ISO', description:'string (opz)', location:'string (opz)', allDay:'boolean', reminderMin:'number (opz)', reminderCh:'dashboard|whatsapp|email' }}
          response={{ event:{ id:'string' } }} />
        <Endpoint method="PATCH" path="/api/calendars/events/:id" title="Aggiorna evento" auth="tenant"
          body={{ '...':'qualsiasi campo (parziale)' }} response={{ event:{ id:'string' } }} />
        <Endpoint method="DELETE" path="/api/calendars/events/:id" title="Elimina evento" auth="tenant" response={{ ok:true }} />
      </Section>

      <Section title="Automazioni">
        <Endpoint method="GET" path="/api/tasks" title="Lista automazioni" auth="tenant"
          response={{ tasks:[{ id:'string', kind:'ONCE|RECURRING', instruction:'string', runAt:'datetime', status:'ACTIVE|PAUSED|DONE|FAILED', intervalSeconds:'number|null' }] }} />
        <Endpoint method="POST" path="/api/tasks" title="Crea automazione" auth="tenant"
          body={{ kind:'ONCE|RECURRING', instruction:'string', runAt:'datetime ISO (solo ONCE)', intervalSeconds:'number secondi (solo RECURRING)', conversationId:'string (opz)' }}
          response={{ task:{ id:'string' } }} />
        <Endpoint method="PATCH" path="/api/tasks/:id" title="Pausa / Riattiva" auth="tenant"
          body={{ status:'ACTIVE|PAUSED' }} response={{ ok:true }} />
        <Endpoint method="DELETE" path="/api/tasks/:id" title="Elimina automazione" auth="tenant" response={{ ok:true }} />
      </Section>

      <Section title="Consumo token">
        <Endpoint method="GET" path="/api/usage/summary" title="Riepilogo consumi" auth="tenant"
          description="Solo Admin e Super Admin. Richiede X-Tenant-Id per scopo tenant; senza (solo Super Admin) restituisce vista globale."
          params={{ from:'ISO datetime', to:'ISO datetime' }}
          response={{ totals:{ inputTokens:'number', cachedInputTokens:'number', outputTokens:'number', costUsd:'number', calls:'number' }, series:'array giornaliero', bySource:'per canale', byTenant:'per azienda (solo Super Admin)' }} />
      </Section>

      <Section title="Agenti AI (Multi-agente)" description="Ogni tenant può avere più agenti AI, ognuno con il proprio addestramento e versioning indipendente. L'agente attivo per ogni conversazione o chat esterna si può cambiare in qualsiasi momento, anche via comando all'AI stessa.">
        <Endpoint method="GET" path="/api/agents" title="Lista agenti" auth="tenant"
          response={{ agents:[{ id:'string', name:'string', description:'string', avatar:'string|null', isDefault:'boolean', createdAt:'datetime', updatedAt:'datetime' }] }} />
        <Endpoint method="POST" path="/api/agents" title="Crea agente" auth="tenant"
          body={{ name:'string (obbligatorio)', description:'string', avatar:'emoji/url', isDefault:'boolean', mainPrompt:'string', personality:'string', rules:'string', context:'string', instructions:'string' }}
          response={{ agent:{ id:'string', name:'string' } }} />
        <Endpoint method="GET" path="/api/agents/:id" title="Dettaglio agente (config completa)" auth="tenant"
          response={{ agent:{ id:'string', mainPrompt:'string', personality:'string', rules:'string', context:'string', instructions:'string' } }} />
        <Endpoint method="PUT" path="/api/agents/:id" title="Salva configurazione (crea versione)" auth="tenant"
          description="Ogni salvataggio crea automaticamente una versione storica. Passa 'note' per etichettare la versione."
          body={{ mainPrompt:'string', personality:'string', rules:'string', context:'string', instructions:'string', note:'string (opzionale)' }}
          response={{ agent:{ id:'string', updatedAt:'datetime' } }} />
        <Endpoint method="PATCH" path="/api/agents/:id/meta" title="Modifica meta (nome/avatar/default)" auth="tenant"
          body={{ name:'string', description:'string', avatar:'string', isDefault:'boolean' }}
          response={{ agent:{ id:'string' } }} />
        <Endpoint method="DELETE" path="/api/agents/:id" title="Elimina agente" auth="tenant"
          description="Non è possibile eliminare l'agente predefinito." response={{ ok:true }} />
        <Endpoint method="GET" path="/api/agents/:id/versions" title="Lista versioni" auth="tenant"
          description="Ultimi 50 salvataggi dell'agente, in ordine decrescente."
          response={{ versions:[{ id:'string', mainPrompt:'string', note:'string|null', savedBy:'string|null', createdAt:'datetime' }] }} />
        <Endpoint method="POST" path="/api/agents/:id/versions/:vid/restore" title="Ripristina versione" auth="tenant"
          description="Ripristina una versione storica come configurazione corrente e crea una nuova versione di tracciamento."
          response={{ agent:{ id:'string', mainPrompt:'string' } }} />
        <Endpoint method="POST" path="/api/agents/:id/test" title="Testa agente" auth="tenant"
          body={{ message:'string', draft:'object (opzionale, override temporaneo non salvato)' }}
          response={{ answer:'string' }} />
        <Endpoint method="POST" path="/api/agents/assign/conversation/:cid" title="Assegna agente a conversazione interna" auth="tenant"
          body={{ agentId:'string' }} response={{ ok:true, agentId:'string', agentName:'string' }} />
        <Endpoint method="POST" path="/api/agents/assign/external-chat/:eid" title="Assegna agente a chat esterna (WA/widget)" auth="tenant"
          body={{ agentId:'string' }} response={{ ok:true, agentId:'string', agentName:'string' }}
          example={`# Cambia l'agente su una chat WhatsApp
curl -X POST \\
  -H "X-Api-Key: sk_..." -H "X-Tenant-Id: <id>" \\
  -H "Content-Type: application/json" \\
  -d '{"agentId":"<agentId>"}' \\
  ${BASE}/api/agents/assign/external-chat/<chatId>`} />
      </Section>

      <Section title="WebSocket — Aggiornamenti Agenti in tempo reale" description="Ricevi notifiche in tempo reale quando un agente viene creato, modificato, eliminato o quando l'agente attivo di una chat cambia.">
        <div className="api-endpoint open">
          <div className="api-endpoint-body" style={{ display: 'block' }}>
            <Code lang="javascript">{`import { io } from 'socket.io-client';
const socket = io('${BASE}', { auth: { token: '<accessToken>' } });

// Nuovo agente creato
socket.on('agent:created', ({ agent }) => console.log('Creato:', agent.name));

// Agente modificato (nome, avatar, configurazione)
socket.on('agent:updated', ({ agent }) => console.log('Aggiornato:', agent.id));

// Agente eliminato
socket.on('agent:deleted', ({ id }) => console.log('Eliminato:', id));

// Agente attivo cambiato in una conversazione o chat esterna
socket.on('agent:switched', ({ context, contextId, agentId, agentName }) => {
  // context: 'conversation' | 'external-chat'
  // contextId: id della conversazione o chat esterna
  console.log(\`Chat \${contextId}: ora usa \${agentName}\`);
});`}</Code>
          </div>
        </div>
      </Section>

      <Section title="Credenziali SIP" description="Accesso in sola lettura agli account SIP configurati per il tenant. Solo i Super Admin possono creare/modificare/eliminare account; tramite API key è disponibile solo la lettura (GET). Gli Admin del tenant vedono unicamente i numeri DID, senza password o dettagli tecnici.">
        <Endpoint method="GET" path="/api/sip" title="Lista account SIP" auth="tenant"
          description="Super Admin: restituisce tutti i campi di ogni account SIP incluse le credenziali. Admin: restituisce solo la lista dei DID (adminView: true). La stessa route è usabile con API key per integrazioni esterne in sola lettura."
          response={{ clients:[{
            id:'string',
            did:'string — numero DID (es. +39035578...)',
            internal:'string — interno/estensione',
            username:'string',
            password:'string (solo Super Admin)',
            host:'string — hostname o IP del server SIP',
            port:'number — default 5060',
            protocol:'UDP | TCP | TLS',
            useLocalIp:'boolean',
            label:'string|null — etichetta opzionale',
            createdAt:'datetime',
            updatedAt:'datetime',
          }], adminView:'boolean — true se la vista è ridotta (solo DID)' }}
          example={`# Con API Key (sola lettura):
curl -H "X-Api-Key: sk_..." \\
     -H "X-Tenant-Id: <tenantId>" \\
     ${BASE}/api/sip

# Risposta Super Admin:
{
  "clients": [
    {
      "id": "clx...",
      "did": "+39035578...",
      "internal": "200",
      "username": "user123",
      "password": "secret",
      "host": "sip.esempio.it",
      "port": 5060,
      "protocol": "UDP",
      "useLocalIp": false,
      "label": "Linea principale"
    }
  ]
}

# Risposta Admin (solo DID):
{
  "clients": [{ "id": "clx...", "did": "+39035578...", "label": "Linea principale" }],
  "adminView": true
}`} />
      </Section>

      <Section title="WebSocket — Aggiornamenti SIP in tempo reale" description="Connettiti al WebSocket di Sophia per ricevere notifiche istantanee sulle modifiche agli account SIP (aggiunta, modifica, eliminazione). Usa la stessa connessione Socket.io delle altre funzionalità.">
        <div className="api-endpoint open">
          <div className="api-endpoint-body" style={{ display: 'block' }}>
            <p className="api-desc">
              Usa <code>socket.io-client</code> per connetterti all'URL base dell'API con il token di autenticazione.
              Una volta connesso, riceverai automaticamente gli eventi SIP per il tuo tenant.
            </p>
            <Code lang="javascript">{`import { io } from 'socket.io-client';

const socket = io('${BASE}', {
  auth: { token: '<accessToken>' },  // JWT da POST /api/auth/login
});

// Account SIP aggiunto
socket.on('sip:created', ({ client }) => {
  console.log('Nuovo SIP:', client);
});

// Account SIP modificato
socket.on('sip:updated', ({ client }) => {
  console.log('SIP aggiornato:', client);
});

// Account SIP eliminato
socket.on('sip:deleted', ({ id }) => {
  console.log('SIP eliminato, id:', id);
});`}</Code>
            <h4 className="api-section-title">Struttura eventi</h4>
            <div className="api-params">
              <div className="api-param"><code>sip:created</code><span>{'{ client: SipClient }'} — emesso quando viene aggiunto un nuovo account SIP</span></div>
              <div className="api-param"><code>sip:updated</code><span>{'{ client: SipClient }'} — emesso quando un account SIP viene modificato</span></div>
              <div className="api-param"><code>sip:deleted</code><span>{'{ id: string }'} — emesso quando un account SIP viene eliminato (contiene solo l'id)</span></div>
            </div>
            <p className="api-desc" style={{ marginTop: 12, fontSize: 13 }}>
              Gli eventi vengono trasmessi solo ai client connessi con un token appartenente allo stesso tenant.
              La connessione richiede un access token valido (ottenuto da <code>POST /api/auth/login</code>).
            </p>
          </div>
        </div>
      </Section>
    </div>
  );
}
