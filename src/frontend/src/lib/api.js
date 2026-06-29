// Client API: gestione token, refresh automatico, streaming SSE.

const ACCESS = 'sophia.access';
const REFRESH = 'sophia.refresh';
const TENANT = 'sophia.tenant';

export const tokens = {
  get access() { return localStorage.getItem(ACCESS); },
  get refresh() { return localStorage.getItem(REFRESH); },
  get tenant() { return localStorage.getItem(TENANT); },
  set({ accessToken, refreshToken }) {
    if (accessToken) localStorage.setItem(ACCESS, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH, refreshToken);
  },
  setTenant(id) { id ? localStorage.setItem(TENANT, id) : localStorage.removeItem(TENANT); },
  clear() { [ACCESS, REFRESH, TENANT].forEach((k) => localStorage.removeItem(k)); },
};

function authHeaders(extra = {}) {
  const h = { ...extra };
  if (tokens.access) h.Authorization = `Bearer ${tokens.access}`;
  if (tokens.tenant) h['X-Tenant-Id'] = tokens.tenant;
  return h;
}

async function refreshAccess() {
  if (!tokens.refresh) return false;
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refresh }),
  });
  if (!res.ok) { tokens.clear(); return false; }
  tokens.set(await res.json());
  return true;
}

// Richiesta JSON con retry trasparente in caso di token scaduto (401).
export async function api(path, { method = 'GET', body, headers, retry = true } = {}) {
  const opts = {
    method,
    headers: authHeaders({ 'Content-Type': 'application/json', ...headers }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  let res = await fetch(`/api${path}`, opts);

  if (res.status === 401 && retry && (await refreshAccess())) {
    opts.headers = authHeaders({ 'Content-Type': 'application/json', ...headers });
    res = await fetch(`/api${path}`, opts);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Errore', res.status, data.details);
  return data;
}

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Upload multipart.
export async function upload(path, file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api${path}`, { method: 'POST', headers: authHeaders(), body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Upload fallito', res.status);
  return data;
}


// Upload media per chat esterna (con caption opzionale).
export async function uploadMedia(path, file, caption = '') {
  const form = new FormData();
  form.append('file', file);
  if (caption) form.append('caption', caption);
  const res = await fetch(`/api${path}`, { method: 'POST', headers: authHeaders(), body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Upload fallito', res.status);
  return data;
}

// Upload con campi aggiuntivi (es. cartella, etichette per il cloud).
export async function uploadFile(path, file, extra = {}) {
  const form = new FormData();
  form.append('file', file);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === '') continue;
    form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const res = await fetch(`/api${path}`, { method: 'POST', headers: authHeaders(), body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Upload fallito', res.status);
  return data;
}

// Come uploadFile ma con callback onProgress(0-100) per la barra di avanzamento.
export function uploadFileWithProgress(path, file, extra = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null || v === '') continue;
      form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    const h = authHeaders();
    for (const [k, v] of Object.entries(h)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(data.error || 'Upload fallito', xhr.status));
      } catch { reject(new ApiError('Risposta non valida', xhr.status)); }
    };
    xhr.onerror = () => reject(new ApiError('Errore di rete', 0));
    xhr.send(form);
  });
}

// Streaming della risposta AI via Server-Sent Events su una POST.
export async function streamMessage(conversationId, content, documentIds, { onToken, onTool, onDone, onError }) {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content, documentIds: documentIds || [] }),
  });
  if (!res.ok || !res.body) { onError?.(new Error('Streaming non disponibile')); return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const block of events) {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
      const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
      if (!dataLine) continue;
      const payload = JSON.parse(dataLine);
      if (event === 'token') onToken?.(payload.delta);
      else if (event === 'tool') onTool?.(payload);
      else if (event === 'done') onDone?.(payload);
      else if (event === 'error') onError?.(new Error(payload.message));
    }
  }
}

// ── Socket.io: ascolta eventi realtime ─────────────────────────────────────
let _socket = null;
let _reconnectTimer = null;

export function connectRealtime() {
  if (_socket?.connected || typeof window === 'undefined') return;
  clearTimeout(_reconnectTimer);

  import('socket.io-client').then(({ io }) => {
    if (_socket) { _socket.removeAllListeners(); _socket.disconnect(); }

    const accessToken = tokens.access;
    if (!accessToken) return; // non autenticato, non tentiamo

    _socket = io({
      auth: { token: accessToken },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
    });

    const dispatch = (name, detail) =>
      window.dispatchEvent(new CustomEvent(name, { detail }));

    _socket.on('task:executed', (payload) => {
      const dt = payload.executedAt
        ? new Date(payload.executedAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : new Date().toLocaleString('it-IT');
      dispatch('sophia:action', { label: payload.label || 'Azione eseguita', time: dt });
      dispatch('sophia:task:executed', payload);
    });

    _socket.on('whatsapp:message', (p) => dispatch('sophia:wa:message', p));

    _socket.on('external-chat:message', (p) => dispatch('sophia:ext-chat', p));
    _socket.on('external-chat:updated',  (p) => dispatch('sophia:ext-chat', { chatId: p.chatId }));
    _socket.on('external-chat:deleted',  (p) => dispatch('sophia:ext-chat-deleted', p));

    // ── PHI Compiler: modulo compilato ──────────────────────────────────
    _socket.on('compiler:form_completed', (p) => dispatch('sophia:compiler:completed', p));

    // ── Credenziali SIP: aggiornamenti in tempo reale ────────────────────
    _socket.on('sip:created', (p) => dispatch('sophia:sip:created', p));
    _socket.on('sip:updated', (p) => dispatch('sophia:sip:updated', p));
    _socket.on('sip:deleted', (p) => dispatch('sophia:sip:deleted', p));

    // ── Multi-agente: eventi in tempo reale ──────────────────────────────
    _socket.on('agent:created',  (p) => dispatch('sophia:agent:created', p));
    _socket.on('agent:updated',  (p) => dispatch('sophia:agent:updated', p));
    _socket.on('agent:deleted',  (p) => dispatch('sophia:agent:deleted', p));
    _socket.on('agent:switched', (p) => dispatch('sophia:agent:switched', p));

    // ── Modulo Database: eventi in tempo reale ───────────────────────────
    _socket.on('db:schema:created', (p) => dispatch('sophia:db:schema:created', p));
    _socket.on('db:schema:updated', (p) => dispatch('sophia:db:schema:updated', p));
    _socket.on('db:schema:deleted', (p) => dispatch('sophia:db:schema:deleted', p));
    _socket.on('db:record:created', (p) => dispatch('sophia:db:record:created', p));
    _socket.on('db:record:updated', (p) => dispatch('sophia:db:record:updated', p));
    _socket.on('db:record:deleted', (p) => dispatch('sophia:db:record:deleted', p));

    _socket.on('disconnect', () => {
      _reconnectTimer = setTimeout(connectRealtime, 5000);
    });
  }).catch(() => {
    _reconnectTimer = setTimeout(connectRealtime, 8000);
  });
}
