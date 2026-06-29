import { useCallback, useEffect, useState } from 'react';
import {
  Phone, Plus, Trash2, Pencil, Save, X, Eye, EyeOff, Info,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';

const PROTOCOLS = ['UDP', 'TCP', 'TLS'];

const EMPTY_FORM = {
  did: '', internal: '', username: '', password: '',
  host: '', port: 5060, protocol: 'UDP', useLocalIp: false, label: '',
};

// ── Modale creazione/modifica ─────────────────────────────────────────────────
function SipModal({ client, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(client ? {
    did: client.did, internal: client.internal || '',
    username: client.username, password: client.password,
    host: client.host, port: client.port, protocol: client.protocol,
    useLocalIp: client.useLocalIp, label: client.label || '',
  } : { ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.did.trim())      return toast.error('DID obbligatorio');
    if (!form.username.trim()) return toast.error('Username obbligatorio');
    if (!form.password.trim()) return toast.error('Password obbligatoria');
    if (!form.host.trim())     return toast.error('Host obbligatorio');
    setSaving(true);
    try {
      const body = {
        ...form,
        port: Number(form.port) || 5060,
        label: form.label.trim() || null,
        internal: form.internal.trim(),
      };
      if (client) {
        await api(`/sip/${client.id}`, { method: 'PATCH', body });
        toast.info('Account SIP aggiornato');
      } else {
        await api('/sip', { method: 'POST', body });
        toast.info('Account SIP aggiunto');
      }
      onSaved();
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head-row">
          <h2 className="modal-title" style={{ margin: 0 }}>
            {client ? 'Modifica account SIP' : 'Nuovo account SIP'}
          </h2>
          <button className="btn btn-ghost icon-btn" onClick={onClose}><X size={18}/></button>
        </div>

        <div className="field">
          <label>Etichetta <span className="field-hint">— nome riconoscibile (opzionale)</span></label>
          <input className="input" value={form.label} onChange={e => set('label', e.target.value)}
            placeholder="Es. Linea principale ufficio" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="field">
            <label>DID <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input className="input" value={form.did} onChange={e => set('did', e.target.value)}
              placeholder="+39035..." />
          </div>
          <div className="field">
            <label>Interno</label>
            <input className="input" value={form.internal} onChange={e => set('internal', e.target.value)}
              placeholder="200" />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="field">
            <label>Username <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input className="input" value={form.username} onChange={e => set('username', e.target.value)}
              autoComplete="off" />
          </div>
          <div className="field">
            <label>Password <span style={{ color: 'var(--danger)' }}>*</span></label>
            <div style={{ position: 'relative' }}>
              <input className="input" type={showPwd ? 'text' : 'password'}
                value={form.password} onChange={e => set('password', e.target.value)}
                style={{ paddingRight: 36 }} autoComplete="new-password" />
              <button type="button"
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                onClick={() => setShowPwd(v => !v)}>
                {showPwd ? <EyeOff size={16}/> : <Eye size={16}/>}
              </button>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, alignItems: 'end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Host <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input className="input" value={form.host} onChange={e => set('host', e.target.value)}
              placeholder="sip.esempio.it" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Porta</label>
            <input className="input" type="number" value={form.port}
              onChange={e => set('port', e.target.value)} style={{ width: 90 }} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Protocollo</label>
            <select className="input" value={form.protocol} onChange={e => set('protocol', e.target.value)}
              style={{ width: 90 }}>
              {PROTOCOLS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 400 }}>
            <input type="checkbox" checked={form.useLocalIp} onChange={e => set('useLocalIp', e.target.checked)} />
            Usa IP locale
          </label>
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            <Save size={15}/> {saving ? 'Salvo…' : 'Salva'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Pagina principale ─────────────────────────────────────────────────────────
export default function SipCredentials() {
  const { user } = useAuth();
  const toast = useToast();
  const modal = useModal();

  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const isAdmin      = user?.role === 'ADMIN';

  const [clients, setClients]   = useState(null);   // null = caricamento
  const [adminView, setAdminView] = useState(false); // true se back-end ritorna vista DID-only
  const [editing, setEditing]   = useState(null);    // client da modificare
  const [showNew, setShowNew]   = useState(false);
  const [showPwds, setShowPwds] = useState({});      // { [id]: bool }

  const load = useCallback(async () => {
    try {
      const { clients: list, adminView: av } = await api('/sip');
      setClients(list);
      setAdminView(!!av);
    } catch { setClients([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Aggiornamenti realtime (Socket.io) ──────────────────────────────────
  useEffect(() => {
    const onCreated = (e) => {
      const { client } = e.detail || {};
      if (!client) return;
      setClients(prev => (prev ? [...prev, client] : [client]));
    };
    const onUpdated = (e) => {
      const { client } = e.detail || {};
      if (!client) return;
      setClients(prev => prev ? prev.map(c => c.id === client.id ? client : c) : [client]);
    };
    const onDeleted = (e) => {
      const { id } = e.detail || {};
      if (!id) return;
      setClients(prev => prev ? prev.filter(c => c.id !== id) : []);
    };
    window.addEventListener('sophia:sip:created', onCreated);
    window.addEventListener('sophia:sip:updated', onUpdated);
    window.addEventListener('sophia:sip:deleted', onDeleted);
    return () => {
      window.removeEventListener('sophia:sip:created', onCreated);
      window.removeEventListener('sophia:sip:updated', onUpdated);
      window.removeEventListener('sophia:sip:deleted', onDeleted);
    };
  }, []);

  const handleDelete = async (client) => {
    const ok = await modal.confirm(
      `Eliminare l'account SIP "${client.label || client.did}"?`,
      { danger: true },
    );
    if (!ok) return;
    try {
      await api(`/sip/${client.id}`, { method: 'DELETE' });
      toast.info('Account SIP eliminato');
      setClients(prev => prev.filter(c => c.id !== client.id));
    } catch (err) { toast.error(err.message); }
  };

  const togglePwd = (id) => setShowPwds(p => ({ ...p, [id]: !p[id] }));

  if (clients === null) return <div className="skeleton" style={{ height: 300 }}/>;

  // ── Vista ADMIN: solo DID ──────────────────────────────────────────────────
  if (isAdmin || adminView) {
    return (
      <div>
        <div className="page-head-row">
          <div>
            <h1 className="page-title">Numeri DID</h1>
            <p className="page-subtitle">I tuoi numeri di telefono SIP collegati.</p>
          </div>
        </div>

        {/* Box contatto assistenza */}
        <div className="card" style={{
          background: 'var(--blue-50,#eff6ff)', border: '1px solid var(--blue-200,#bfdbfe)',
          borderRadius: 12, padding: '16px 20px', marginBottom: 24,
          display: 'flex', gap: 12, alignItems: 'flex-start',
        }}>
          <Info size={18} style={{ color: 'var(--blue-600,#2563eb)', flexShrink: 0, marginTop: 2 }}/>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--blue-800,#1e40af)', marginBottom: 4 }}>
              Hai bisogno di assistenza o vuoi modificare le configurazioni?
            </div>
            <div style={{ fontSize: 13, color: 'var(--blue-700,#1d4ed8)', lineHeight: 1.5 }}>
              Contattaci a <a href="tel:+390355788880" style={{ fontWeight:600, color:'inherit' }}>+39 035 578 8880</a>{' '}
              oppure scrivi a <a href="mailto:sophia@phi.it" style={{ fontWeight:600, color:'inherit' }}>sophia@phi.it</a>
            </div>
          </div>
        </div>

        {clients.length === 0 ? (
          <div className="card empty-state">
            <div className="empty-icon"><Phone size={24} strokeWidth={1.75}/></div>
            <h3>Nessun numero DID</h3>
            <p>Nessun numero di telefono SIP configurato per questa azienda.</p>
          </div>
        ) : (
          <div className="flows-list">
            {clients.map(c => (
              <div key={c.id} className="flow-card card">
                <div className="flow-header">
                  <div className="flow-title-row">
                    <Phone size={15} className="flow-icon"/>
                    <span className="flow-name">{c.did}</span>
                    {c.label && <span className="badge badge-off">{c.label}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Vista SUPER_ADMIN: gestione completa ───────────────────────────────────
  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">Credenziali SIP</h1>
          <p className="page-subtitle">
            Account SIP del tenant. Modifiche visibili in tempo reale tramite WebSocket.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          <Plus size={16}/> Aggiungi account
        </button>
      </div>

      {clients.length === 0 ? (
        <div className="card empty-state" style={{ marginTop: 24 }}>
          <div className="empty-icon"><Phone size={24} strokeWidth={1.75}/></div>
          <h3>Nessun account SIP</h3>
          <p>Aggiungi le credenziali SIP del tenant per renderle accessibili tramite API.</p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowNew(true)}>
            <Plus size={16}/> Aggiungi account
          </button>
        </div>
      ) : (
        <div className="flows-list">
          {clients.map(c => (
            <div key={c.id} className="flow-card card">
              <div className="flow-header">
                <div className="flow-title-row">
                  <Phone size={15} className="flow-icon"/>
                  <span className="flow-name">{c.did}</span>
                  {c.label && <span className="badge badge-off">{c.label}</span>}
                  {c.internal && (
                    <span style={{ fontSize:12, color:'var(--text-muted)' }}>int. {c.internal}</span>
                  )}
                </div>
                <div className="flow-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(c)}>
                    <Pencil size={13}/> Modifica
                  </button>
                  <button className="btn btn-danger icon-btn" onClick={() => handleDelete(c)}>
                    <Trash2 size={13}/>
                  </button>
                </div>
              </div>

              {/* Dettagli tecnici */}
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px,1fr))',
                gap: '6px 16px', marginTop: 10, paddingTop: 10,
                borderTop: '1px solid var(--border)',
              }}>
                <SipField label="Username" value={c.username} />
                <SipField label="Password" value={c.password} secret
                  show={showPwds[c.id]} onToggle={() => togglePwd(c.id)} />
                <SipField label="Host" value={c.host} />
                <SipField label="Porta" value={String(c.port)} />
                <SipField label="Protocollo" value={c.protocol} />
                {c.useLocalIp && <SipField label="IP" value="Locale" />}
              </div>
            </div>
          ))}
        </div>
      )}

      {showNew && (
        <SipModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }}/>
      )}
      {editing && (
        <SipModal client={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }}/>
      )}
    </div>
  );
}

// ── Campo valore SIP con toggle password ─────────────────────────────────────
function SipField({ label, value, secret = false, show = false, onToggle }) {
  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text)' }}>
          {secret && !show ? '••••••••' : value}
        </span>
        {secret && (
          <button onClick={onToggle}
            style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', padding:0 }}>
            {show ? <EyeOff size={12}/> : <Eye size={12}/>}
          </button>
        )}
      </div>
    </div>
  );
}
