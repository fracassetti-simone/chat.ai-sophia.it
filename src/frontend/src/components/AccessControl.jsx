/**
 * AccessControl — componenti condivisi per il controllo accessi multi-audience.
 * Usato da Database (record/schema) e Cloud (cartelle).
 *
 * Modello: array di { audience: 'admin'|'users'|'selected'|'external', permission: 'read'|'write' }
 *  + accessUsers: string[] (id utenti) quando è presente l'audience 'selected'.
 */
import { useEffect, useState } from 'react';
import { Check, Lock, Users, UserCheck, Globe, Search, X, UserRound } from 'lucide-react';
import { api } from '../lib/api.js';

export const AUDIENCES = [
  { value: 'admin',    label: 'Admin',            icon: Lock,      hint: 'Admin e super admin' },
  { value: 'users',    label: 'Tutti gli utenti', icon: Users,     hint: 'Tutti gli utenti del tenant' },
  { value: 'selected', label: 'Utenti specifici', icon: UserCheck, hint: 'Scegli manualmente chi può accedere' },
  { value: 'external', label: 'Utenti esterni',   icon: Globe,     hint: 'Utenti del widget e dei canali esterni' },
];

// Audience speciale, disponibile solo per le cartelle collegate a un contatto:
// il contatto stesso, autenticato dal proprio numero di telefono su WhatsApp.
export const CONTACT_AUDIENCE = {
  value: 'contact', label: 'Utente del contatto', icon: UserRound,
  hint: 'Il contatto collegato, autenticato dal suo numero su WhatsApp',
};

export const PERMISSIONS = [
  { value: 'read',  label: 'Sola lettura' },
  { value: 'write', label: 'Tutto' },
];

export const AUD_META = Object.fromEntries([...AUDIENCES, CONTACT_AUDIENCE].map(a => [a.value, a]));

// Normalizza un array di accesso, mantenendo solo audience valide.
export function getAccess(obj) {
  if (Array.isArray(obj?.access) && obj.access.length) {
    return obj.access.filter(a => a && AUD_META[a.audience]);
  }
  // Default retro-compatibile: visibile a tutti gli utenti del tenant.
  return [{ audience: 'admin', permission: 'write' }, { audience: 'users', permission: 'write' }];
}

// ─── AccessBadge (solo display) ───────────────────────────────────────────────
export function AccessBadge({ access }) {
  const list = Array.isArray(access) && access.length ? access : getAccess({ access });
  const colors = {
    admin:    { bg: 'var(--gray-100,#f3f4f6)', color: 'var(--text-muted,#6b7280)' },
    users:    { bg: '#eff6ff', color: '#1d4ed8' },
    selected: { bg: '#faf5ff', color: '#7e22ce' },
    external: { bg: '#ecfdf5', color: '#047857' },
    contact:  { bg: '#fff7ed', color: '#c2410c' },
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {list.map(a => {
        const meta = AUD_META[a.audience] || AUD_META.admin;
        const Icon = meta.icon;
        const c = colors[a.audience] || colors.admin;
        return (
          <span key={a.audience} title={`${meta.label} — ${a.permission === 'write' ? 'tutto' : 'sola lettura'}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 500, background: c.bg, color: c.color }}>
            <Icon size={10} /> {meta.label}
            <span style={{ opacity: .7, fontWeight: 400 }}>· {a.permission === 'write' ? 'tutto' : 'lettura'}</span>
          </span>
        );
      })}
    </span>
  );
}

// ─── MultiAccessPicker — selezione multipla audience + permesso ───────────────
export function MultiAccessPicker({ value, onChange, label = 'Accessibile a', hint, showContact = false }) {
  const list = Array.isArray(value) ? value : [];
  const entryFor = aud => list.find(v => v.audience === aud);
  const audiences = showContact ? [...AUDIENCES, CONTACT_AUDIENCE] : AUDIENCES;

  const toggle = aud => {
    if (entryFor(aud)) onChange(list.filter(v => v.audience !== aud));
    else onChange([...list, { audience: aud, permission: aud === 'admin' ? 'write' : 'read' }]);
  };
  const setPerm = (aud, perm) => onChange(list.map(v => v.audience === aud ? { ...v, permission: perm } : v));

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
        {hint || 'Seleziona uno o più destinatari e, per ciascuno, il livello di permesso.'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {audiences.map(a => {
          const entry = entryFor(a.value);
          const sel = !!entry;
          const Icon = a.icon;
          const isAdmin = a.value === 'admin';
          return (
            <div
              key={a.value}
              style={{
                border: `2px solid ${sel ? 'var(--primary)' : 'var(--border)'}`,
                borderRadius: 10, background: sel ? '#eff6ff' : 'var(--surface)',
                transition: 'all .15s', overflow: 'hidden', opacity: isAdmin ? 0.85 : 1,
              }}
            >
              <button
                type="button"
                onClick={() => !isAdmin && toggle(a.value)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                  border: 'none', background: 'transparent', cursor: isAdmin ? 'default' : 'pointer', textAlign: 'left',
                }}
              >
                <Icon size={18} style={{ color: sel ? 'var(--primary)' : 'var(--text-muted)', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: sel ? 'var(--primary)' : 'var(--text)' }}>
                    {a.label}{isAdmin && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}> · sempre incluso</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{a.hint}</div>
                </div>
                <div style={{
                  width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                  border: `2px solid ${sel ? 'var(--primary)' : 'var(--border)'}`,
                  background: sel ? 'var(--primary)' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {sel && <Check size={11} style={{ color: '#fff' }} />}
                </div>
              </button>
              {sel && (
                <div style={{ display: 'flex', gap: 6, padding: '0 14px 12px 44px' }}>
                  {PERMISSIONS.map(p => {
                    const on = entry.permission === p.value;
                    return (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => setPerm(a.value, p.value)}
                        style={{
                          flex: 1, padding: '7px 10px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                          border: `1.5px solid ${on ? 'var(--primary)' : 'var(--border)'}`,
                          background: on ? 'var(--primary)' : 'var(--surface)',
                          color: on ? '#fff' : 'var(--text)', cursor: 'pointer', transition: 'all .12s',
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── UserPicker custom ────────────────────────────────────────────────────────
export function UserPicker({ selected, onChange, endpoint = '/db/users' }) {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api(endpoint).then(({ users: u }) => { setUsers(u || []); setLoading(false); }).catch(() => setLoading(false));
  }, [endpoint]);

  const filtered = users.filter(u =>
    !search.trim() ||
    (u.name || '').toLowerCase().includes(search.toLowerCase()) ||
    (u.email || '').toLowerCase().includes(search.toLowerCase())
  );

  const toggle = id => onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
        Utenti con accesso <span style={{ color: 'var(--primary)', fontWeight: 700 }}>({selected.length} selezionati)</span>
      </div>
      <div style={{ position: 'relative', marginBottom: 8 }}>
        <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
        <input className="input" style={{ paddingLeft: 30, fontSize: 13 }} placeholder="Cerca utenti…"
          value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div style={{ border: '1.5px solid var(--border)', borderRadius: 10, overflow: 'hidden', maxHeight: 300, overflowY: 'auto' }}>
        {loading && <div style={{ padding: '12px 14px', color: 'var(--text-muted)', fontSize: 13 }}>Caricamento…</div>}
        {!loading && !filtered.length && <div style={{ padding: '12px 14px', color: 'var(--text-muted)', fontSize: 13 }}>Nessun utente trovato.</div>}
        {filtered.map((u, i) => {
          const sel = selected.includes(u.id);
          return (
            <button
              key={u.id}
              type="button"
              onClick={() => toggle(u.id)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                padding: '11px 14px', border: 'none', borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
                background: sel ? '#eff6ff' : 'transparent', cursor: 'pointer', textAlign: 'left',
              }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: 16, flexShrink: 0,
                background: sel ? 'var(--primary)' : 'var(--gray-200,#e5e7eb)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 700, color: sel ? '#fff' : 'var(--text-muted)',
              }}>
                {(u.name || u.email).slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{u.name || u.email}</div>
                {u.name && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{u.email}</div>}
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{u.role}</div>
              </div>
              {sel && <Check size={16} style={{ color: 'var(--primary)', flexShrink: 0 }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── FolderAccessModal — crea/modifica cartella con controllo accessi ─────────
export function FolderAccessModal({ title, initialName = '', initialAccess, initialAccessUsers = [], isContact = false, onSave, onClose }) {
  const [name, setName] = useState(initialName);
  const [access, setAccess] = useState(
    Array.isArray(initialAccess) && initialAccess.length
      ? initialAccess
      : [{ audience: 'admin', permission: 'write' }, { audience: 'users', permission: 'write' }]
  );
  const [accessUsers, setAccessUsers] = useState(initialAccessUsers || []);
  const [saving, setSaving] = useState(false);
  const hasSelected = access.some(a => a.audience === 'selected');

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({ name: name.trim(), access, accessUsers: hasSelected ? accessUsers : [] });
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" style={{ maxWidth: 480, width: '100%' }} onClick={e => e.stopPropagation()}>
        <div className="modal-head-row">
          <h3 className="modal-title" style={{ margin: 0 }}>{title}</h3>
          <button className="btn btn-ghost icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }}>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', display: 'block', marginBottom: 6 }}>Nome cartella</label>
            <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Es. Fatture 2024"
              onKeyDown={e => { if (e.key === 'Enter') save(); }} />
          </div>
          <MultiAccessPicker value={access} onChange={setAccess} label="Chi può accedere a questa cartella"
            showContact={isContact}
            hint={isContact
              ? 'Gli admin hanno sempre accesso completo. "Utente del contatto" consente al contatto di vedere i propri file via WhatsApp.'
              : 'Gli admin hanno sempre accesso completo. Seleziona altri destinatari e il loro livello di permesso.'} />
          {hasSelected && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12 }}>Utenti specifici</div>
              <UserPicker selected={accessUsers} onChange={setAccessUsers} endpoint="/cloud/users" />
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-outline" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !name.trim()}>{saving ? 'Salvo…' : 'Salva'}</button>
        </div>
      </div>
    </div>
  );
}
