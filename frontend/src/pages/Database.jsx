/**
 * Database — v3
 * ✅ Nessun modal: schema editor e record editor sono schermate a schermo intero
 * ✅ Nessun <select> o <input type=checkbox> nativi — tutto custom
 * ✅ Chiave snake_case auto-generata mentre scrivi l'etichetta
 * ✅ Regex, min, max funzionanti
 * ✅ Colonna "Accessibile a" in tabella
 * ✅ Selezione utenti specifici con picker custom
 * ✅ page-head-row corretta nella vista record
 * ✅ Guard modulo non attivo
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Plus, Trash2, Pencil, Save, X, Search, ChevronLeft,
  Settings, Database as DbIcon, Eye, Check, Lock, Users, UserCheck,
  GripVertical, ChevronDown, ArrowLeft,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';

// ─── Costanti ─────────────────────────────────────────────────────────────────

const ACCESS_LEVELS = [
  { value: 'admin',          label: 'Solo admin',                  icon: Lock,      hint: 'Solo admin e super admin' },
  { value: 'admin_users',    label: 'Admin e tutti gli utenti',    icon: Users,     hint: 'Visibile a tutti gli utenti del tenant' },
  { value: 'admin_selected', label: 'Admin e utenti selezionati',  icon: UserCheck, hint: 'Scegli manualmente chi può accedere' },
];

const FIELD_TYPES = [
  { value: 'string',  label: 'Testo breve',      desc: 'Fino a ~255 caratteri, con regex opzionale' },
  { value: 'text',    label: 'Testo lungo',       desc: 'Paragrafi, note, descrizioni' },
  { value: 'integer', label: 'Numero intero',     desc: 'Es. 42, con min/max opzionali' },
  { value: 'decimal', label: 'Numero decimale',   desc: 'Es. 3.14, con min/max opzionali' },
  { value: 'boolean', label: 'Sì / No',           desc: 'Valore booleano' },
  { value: 'date',    label: 'Data',              desc: 'Formato YYYY-MM-DD' },
  { value: 'select',  label: 'Selezione opzioni', desc: 'Menu a scelta tra valori predefiniti' },
];

const COMMON_ICONS = [
  'people-outline','person-outline','business-outline','briefcase-outline',
  'cart-outline','server-outline','folder-outline','document-outline',
  'cube-outline','build-outline','home-outline','heart-outline',
  'star-outline','flag-outline','globe-outline','cash-outline',
  'car-outline','airplane-outline','barbell-outline','medkit-outline',
  'receipt-outline','pricetag-outline','stats-chart-outline','layers-outline',
  'library-outline','book-outline','calculator-outline','call-outline',
];

// ─── Utils ────────────────────────────────────────────────────────────────────

function IonIcon({ name, size = 18, style = {} }) {
  return <ion-icon name={name} style={{ fontSize: size, flexShrink: 0, display: 'inline-flex', ...style }} />;
}

function fmtDate(d) {
  return new Date(d).toLocaleString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function toSlug(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// ─── AccessBadge (solo display) ───────────────────────────────────────────────

function AccessBadge({ value }) {
  const a = ACCESS_LEVELS.find(x => x.value === value) || ACCESS_LEVELS[0];
  const Icon = a.icon;
  const colors = {
    admin:          { bg: 'var(--gray-100,#f3f4f6)', color: 'var(--text-muted,#6b7280)' },
    admin_users:    { bg: '#eff6ff', color: '#1d4ed8' },
    admin_selected: { bg: '#faf5ff', color: '#7e22ce' },
  };
  const c = colors[value] || colors.admin;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 500, background: c.bg, color: c.color }}>
      <Icon size={10} /> {a.label}
    </span>
  );
}

// ─── Custom Select (nessun <select> nativo) ───────────────────────────────────

function CustomSelect({ value, onChange, options, placeholder = 'Seleziona…' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const h = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '9px 12px', border: '1.5px solid var(--border)', borderRadius: 8,
          background: 'var(--surface)', cursor: 'pointer', fontSize: 14, color: selected ? 'var(--text)' : 'var(--text-muted)',
          transition: 'border-color .15s',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {selected ? (
            <>
              {selected.icon && <selected.icon size={14} />}
              {selected.label}
            </>
          ) : placeholder}
        </span>
        <ChevronDown size={14} style={{ color: 'var(--text-muted)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 400,
          background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 10,
          boxShadow: '0 8px 24px rgba(0,0,0,.12)', overflow: 'hidden',
        }}>
          {options.map(o => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onChange(o.value); setOpen(false); }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '11px 14px', border: 'none', background: o.value === value ? 'var(--primary-10,#eff6ff)' : 'transparent',
                cursor: 'pointer', textAlign: 'left', fontSize: 13,
                borderBottom: '1px solid var(--border)',
              }}
            >
              {o.icon && <o.icon size={15} style={{ color: o.value === value ? 'var(--primary)' : 'var(--text-muted)' }} />}
              <div>
                <div style={{ fontWeight: 500, color: 'var(--text)' }}>{o.label}</div>
                {o.desc && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{o.desc}</div>}
                {o.hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{o.hint}</div>}
              </div>
              {o.value === value && <Check size={14} style={{ marginLeft: 'auto', color: 'var(--primary)', flexShrink: 0 }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Custom Toggle (nessun <input type=checkbox> nativo) ──────────────────────

function Toggle({ checked, onChange, label, hint, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12, background: 'none',
        border: 'none', cursor: disabled ? 'default' : 'pointer', padding: 0, textAlign: 'left',
      }}
    >
      <div style={{
        width: 40, height: 22, borderRadius: 11, flexShrink: 0, marginTop: 1,
        background: checked ? 'var(--primary,#2563eb)' : 'var(--gray-300,#d1d5db)',
        transition: 'background .2s', position: 'relative',
        opacity: disabled ? 0.5 : 1,
      }}>
        <div style={{
          position: 'absolute', top: 3, left: checked ? 21 : 3,
          width: 16, height: 16, borderRadius: 8, background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,.2)', transition: 'left .2s',
        }} />
      </div>
      {(label || hint) && (
        <div>
          {label && <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{label}</div>}
          {hint && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>}
        </div>
      )}
    </button>
  );
}

// ─── Custom CheckBox singolo ──────────────────────────────────────────────────

function Checkbox({ checked, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, background: 'none',
        border: 'none', cursor: disabled ? 'default' : 'pointer', padding: 0, opacity: disabled ? 0.5 : 1,
      }}
    >
      <div style={{
        width: 18, height: 18, borderRadius: 4, flexShrink: 0,
        border: `2px solid ${checked ? 'var(--primary)' : 'var(--border)'}`,
        background: checked ? 'var(--primary)' : 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all .15s',
      }}>
        {checked && <Check size={11} style={{ color: '#fff' }} />}
      </div>
      {label && <span style={{ fontSize: 13, color: 'var(--text)' }}>{label}</span>}
    </button>
  );
}

// ─── IconPicker ───────────────────────────────────────────────────────────────

function IconPicker({ value, onChange }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const filtered = search.trim() ? COMMON_ICONS.filter(i => i.includes(search.toLowerCase())) : COMMON_ICONS;
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
          border: '1.5px solid var(--border)', borderRadius: 8, background: 'var(--surface)',
          cursor: 'pointer', fontSize: 13,
        }}
      >
        <IonIcon name={value || 'server-outline'} size={20} />
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{value || 'server-outline'}</span>
        <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 400,
          background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 10,
          boxShadow: '0 8px 24px rgba(0,0,0,.12)', width: 300, padding: 12,
        }}>
          <input
            className="input" placeholder="Cerca icona Ionicons…" value={search}
            onChange={e => setSearch(e.target.value)} style={{ marginBottom: 10 }}
            autoFocus
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
            {filtered.map(ic => (
              <button
                key={ic} type="button"
                onClick={() => { onChange(ic); setOpen(false); }}
                title={ic}
                style={{
                  width: 38, height: 38, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: `2px solid ${ic === value ? 'var(--primary)' : 'transparent'}`,
                  background: ic === value ? '#eff6ff' : 'transparent', cursor: 'pointer',
                }}
              >
                <IonIcon name={ic} size={18} />
              </button>
            ))}
            {!filtered.length && <p style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>Nessuna icona. Scrivi il nome esatto Ionicons.</p>}
          </div>
          {search && !COMMON_ICONS.includes(search) && (
            <button className="btn btn-outline btn-sm" style={{ marginTop: 8, width: '100%' }}
              onClick={() => { onChange(search); setOpen(false); }}>
              Usa "{search}"
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── AccessPicker custom (radio group) ───────────────────────────────────────

function AccessPicker({ value, onChange, label = 'Accessibile a', hint }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{label}</div>
      {hint && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>{hint}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {ACCESS_LEVELS.map(a => {
          const sel = value === a.value;
          const Icon = a.icon;
          return (
            <button
              key={a.value}
              type="button"
              onClick={() => onChange(a.value)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                border: `2px solid ${sel ? 'var(--primary)' : 'var(--border)'}`,
                borderRadius: 10, background: sel ? '#eff6ff' : 'var(--surface)',
                cursor: 'pointer', textAlign: 'left', transition: 'all .15s',
              }}
            >
              <Icon size={18} style={{ color: sel ? 'var(--primary)' : 'var(--text-muted)', flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: sel ? 'var(--primary)' : 'var(--text)' }}>{a.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{a.hint}</div>
              </div>
              <div style={{
                width: 18, height: 18, borderRadius: 9, border: `2px solid ${sel ? 'var(--primary)' : 'var(--border)'}`,
                background: sel ? 'var(--primary)' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {sel && <div style={{ width: 6, height: 6, borderRadius: 3, background: '#fff' }} />}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── UserPicker custom ────────────────────────────────────────────────────────

function UserPicker({ selected, onChange }) {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/db/users').then(({ users: u }) => { setUsers(u || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

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

// ─── FieldEditor — un campo dello schema ─────────────────────────────────────

function FieldEditor({ field, index, onChange, onRemove }) {
  const set = (k, v) => onChange(index, { ...field, [k]: v });
  const type = field.type || 'string';

  return (
    <div style={{
      background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 10,
    }}>
      {/* Header campo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <GripVertical size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
          {field.label || <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>Campo #{index + 1}</span>}
        </div>
        <button type="button" onClick={() => onRemove(index)}
          style={{ padding: '4px 8px', border: '1px solid var(--danger,#ef4444)', borderRadius: 6, background: 'transparent', color: 'var(--danger,#ef4444)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          <Trash2 size={12} /> Rimuovi
        </button>
      </div>

      {/* Etichetta + chiave */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Etichetta (nome visibile) *
          </label>
          <input
            className="input"
            placeholder="Es. Nome cliente"
            value={field.label || ''}
            onChange={e => {
              const label = e.target.value;
              // Auto-genera la chiave solo se non è stata modificata manualmente
              if (!field._nameTouched) {
                onChange(index, { ...field, label, name: toSlug(label) });
              } else {
                set('label', label);
              }
            }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Chiave snake_case (auto)
          </label>
          <input
            className="input"
            placeholder="nome_cliente"
            value={field.name || ''}
            style={{ fontFamily: 'monospace', fontSize: 13 }}
            onChange={e => onChange(index, { ...field, name: toSlug(e.target.value), _nameTouched: true })}
          />
        </div>
      </div>

      {/* Tipo */}
      <div style={{ marginBottom: 14 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Tipo di dato
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {FIELD_TYPES.map(ft => (
            <button
              key={ft.value}
              type="button"
              onClick={() => set('type', ft.value)}
              title={ft.desc}
              style={{
                padding: '8px 10px', borderRadius: 8, fontSize: 12, fontWeight: 500,
                border: `2px solid ${type === ft.value ? 'var(--primary)' : 'var(--border)'}`,
                background: type === ft.value ? '#eff6ff' : 'var(--surface)',
                color: type === ft.value ? 'var(--primary)' : 'var(--text)',
                cursor: 'pointer', transition: 'all .12s', textAlign: 'center',
              }}
            >
              {ft.label}
            </button>
          ))}
        </div>
      </div>

      {/* Validazione specifica per tipo */}
      {(type === 'string' || type === 'text') && (
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Regex di validazione <span style={{ fontWeight: 400, textTransform: 'none' }}>(opzionale — es. <code style={{ fontSize: 11 }}>^[A-Z]{2}</code>)</span>
          </label>
          <input
            className="input"
            placeholder="Es. ^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$ oppure lascia vuoto"
            value={field.regex || ''}
            style={{ fontFamily: 'monospace', fontSize: 13 }}
            onChange={e => set('regex', e.target.value)}
          />
        </div>
      )}

      {(type === 'integer' || type === 'decimal') && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Valore minimo <span style={{ fontWeight: 400, textTransform: 'none' }}>(opzionale)</span>
            </label>
            <input
              className="input" type="number"
              placeholder={type === 'integer' ? 'Es. 0' : 'Es. 0.0'}
              value={field.min ?? ''}
              step={type === 'decimal' ? 'any' : 1}
              onChange={e => set('min', e.target.value === '' ? null : Number(e.target.value))}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Valore massimo <span style={{ fontWeight: 400, textTransform: 'none' }}>(opzionale)</span>
            </label>
            <input
              className="input" type="number"
              placeholder={type === 'integer' ? 'Es. 9999' : 'Es. 999.99'}
              value={field.max ?? ''}
              step={type === 'decimal' ? 'any' : 1}
              onChange={e => set('max', e.target.value === '' ? null : Number(e.target.value))}
            />
          </div>
        </div>
      )}

      {type === 'select' && (
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Opzioni (separate da virgola)
          </label>
          <input
            className="input"
            placeholder="Es. Attivo, Sospeso, Archiviato, Bozza"
            value={(field.options || []).join(', ')}
            onChange={e => set('options', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
          />
          {(field.options || []).length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
              {(field.options || []).map(o => (
                <span key={o} style={{ padding: '2px 10px', background: 'var(--gray-100,#f3f4f6)', borderRadius: 12, fontSize: 12 }}>{o}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Obbligatorio */}
      <Toggle
        checked={!!field.required}
        onChange={v => set('required', v)}
        label="Campo obbligatorio"
        hint="Il record non può essere salvato senza questo valore"
      />
    </div>
  );
}

// ─── SchemaEditor — schermata a schermo intero ────────────────────────────────

function SchemaEditor({ schema, onBack, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState(schema?.name || '');
  const [description, setDescription] = useState(schema?.description || '');
  const [icon, setIcon] = useState(schema?.icon || 'server-outline');
  const [showInSidebar, setShowInSidebar] = useState(schema?.showInSidebar || false);
  const [accessLevel, setAccessLevel] = useState(schema?.accessLevel || 'admin');
  const [defaultRecordAccess, setDefaultRecordAccess] = useState(schema?.defaultRecordAccess || 'admin');
  const [fields, setFields] = useState(
    (schema?.fields || []).map(f => ({ ...f, _nameTouched: !!f.name }))
  );
  const [saving, setSaving] = useState(false);

  const addField = () => setFields(f => [
    ...f,
    { id: `f_${Date.now()}`, name: '', label: '', type: 'string', required: false, _nameTouched: false },
  ]);
  const updateField = (i, u) => setFields(f => f.map((x, j) => j === i ? u : x));
  const removeField = (i) => setFields(f => f.filter((_, j) => j !== i));

  const save = async () => {
    if (!name.trim()) return toast.error('Nome database obbligatorio');
    for (const f of fields) {
      if (!f.label?.trim()) return toast.error(`Campo #${fields.indexOf(f) + 1}: etichetta mancante`);
      if (!f.name?.trim()) return toast.error(`Campo "${f.label}": chiave mancante`);
    }
    const keys = fields.map(f => f.name);
    if (new Set(keys).size !== keys.length) return toast.error('Chiavi campo duplicate. Devono essere univoche.');

    setSaving(true);
    try {
      const body = { name, description, icon, showInSidebar, accessLevel, defaultRecordAccess, fields };
      if (schema?.id) {
        await api(`/db/schemas/${schema.id}`, { method: 'PATCH', body });
        toast.info('Database aggiornato');
      } else {
        await api('/db/schemas', { method: 'POST', body });
        toast.info('Database creato');
      }
      onSaved();
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      {/* Topbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, padding: '16px 0 20px',
        borderBottom: '1px solid var(--border)', marginBottom: 28,
      }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={15} /> Annulla
        </button>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
          <IonIcon name={icon || 'server-outline'} size={22} style={{ color: 'var(--primary)' }} />
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
            {schema?.id ? `Struttura — ${schema.name}` : 'Nuovo database'}
          </h1>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Save size={15} /> {saving ? 'Salvataggio…' : 'Salva database'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 32, alignItems: 'start' }}>
        {/* Colonna sinistra: informazioni e campi */}
        <div>
          {/* Info base */}
          <div style={{ background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 14, padding: 20, marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 16 }}>Informazioni</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Nome *</label>
                <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Es. Clienti, Fornitori, Prodotti…" />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Descrizione</label>
                <input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="Nota interna opzionale" />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Icona</label>
                <IconPicker value={icon} onChange={setIcon} />
              </div>
              <div style={{ paddingTop: 18 }}>
                <Toggle
                  checked={showInSidebar}
                  onChange={setShowInSidebar}
                  label="Mostra nella sidebar"
                  hint="Visibile sotto &quot;Dati&quot; nella barra laterale"
                />
              </div>
            </div>
          </div>

          {/* Campi */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>Campi del database</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Ogni campo definisce un tipo di dato e le regole di validazione</div>
              </div>
              <button className="btn btn-outline" onClick={addField} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Plus size={14} /> Aggiungi campo
              </button>
            </div>
            {fields.length === 0 && (
              <div style={{ textAlign: 'center', padding: '48px 0', border: '2px dashed var(--border)', borderRadius: 12, color: 'var(--text-muted)' }}>
                <DbIcon size={28} strokeWidth={1.5} style={{ marginBottom: 8 }} />
                <div style={{ fontSize: 14 }}>Nessun campo. Clicca "Aggiungi campo" per iniziare.</div>
              </div>
            )}
            {fields.map((f, i) => (
              <FieldEditor key={f.id || i} field={f} index={i} onChange={updateField} onRemove={removeField} />
            ))}
          </div>
        </div>

        {/* Colonna destra: accessibilità */}
        <div style={{ position: 'sticky', top: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 14, padding: 20, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 16 }}>Accesso al database</div>
            <AccessPicker
              value={accessLevel}
              onChange={setAccessLevel}
              label="Chi può vedere questo database"
            />
          </div>
          <div style={{ background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 14, padding: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 16 }}>Accesso predefinito record</div>
            <AccessPicker
              value={defaultRecordAccess}
              onChange={setDefaultRecordAccess}
              label="Accessibilità predefinita dei nuovi record"
              hint="Può essere cambiata singolarmente su ogni record"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── RecordEditor — schermata a schermo intero ────────────────────────────────

function RecordEditor({ record, schema, onBack, onSaved, canWrite }) {
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
  const fields = schema.fields || [];

  const [data, setData] = useState(() => {
    const init = {};
    for (const f of fields) init[f.id || f.name] = record?.data?.[f.id || f.name] ?? '';
    return init;
  });
  const [accessLevel, setAccessLevel] = useState(record?.accessLevel || schema.defaultRecordAccess || 'admin');
  const [accessUsers, setAccessUsers] = useState(record?.accessUsers || []);
  const [saving, setSaving] = useState(false);

  const set = (key, val) => setData(d => ({ ...d, [key]: val }));

  const save = async () => {
    setSaving(true);
    try {
      const body = { data, accessLevel, accessUsers: accessLevel === 'admin_selected' ? accessUsers : [] };
      if (record?.id) {
        await api(`/db/schemas/${schema.id}/records/${record.id}`, { method: 'PATCH', body });
        toast.info('Record aggiornato');
      } else {
        await api(`/db/schemas/${schema.id}/records`, { method: 'POST', body });
        toast.info('Record creato');
      }
      onSaved();
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  const title = record?.id
    ? (() => { const f = fields[0]; return f ? String(record.data?.[f.id || f.name] || 'Modifica record') : 'Modifica record'; })()
    : `Nuovo record — ${schema.name}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      {/* Topbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, padding: '16px 0 20px',
        borderBottom: '1px solid var(--border)', marginBottom: 28,
      }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={15} /> {schema.name}
        </button>
        <h1 style={{ flex: 1, fontSize: 20, fontWeight: 700, margin: 0 }}>{title}</h1>
        {canWrite && (
          <button className="btn btn-primary" onClick={save} disabled={saving} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Save size={15} /> {saving ? 'Salvataggio…' : 'Salva record'}
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 28, alignItems: 'start' }}>
        {/* Colonna sinistra: campi dati */}
        <div style={{ background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 14, padding: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 20 }}>Dati</div>
          {fields.map(f => {
            const key = f.id || f.name;
            const val = data[key] ?? '';
            return (
              <div className="field" key={key} style={{ marginBottom: 18 }}>
                <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 5 }}>
                  {f.label}
                  {f.required && <span style={{ color: 'var(--danger,#ef4444)', marginLeft: 4 }}>*</span>}
                  <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6, fontSize: 11 }}>
                    {FIELD_TYPES.find(t => t.value === f.type)?.label || f.type}
                  </span>
                </label>

                {f.type === 'text' && (
                  <textarea className="input" rows={4} value={val} disabled={!canWrite}
                    onChange={e => set(key, e.target.value)} style={{ resize: 'vertical' }} />
                )}
                {f.type === 'boolean' && (
                  <Toggle checked={val === true || val === 'true' || val === 1 || val === '1'}
                    onChange={v => set(key, v)} disabled={!canWrite}
                    label={val ? 'Sì' : 'No'} />
                )}
                {f.type === 'select' && (
                  <CustomSelect
                    value={val}
                    onChange={v => set(key, v)}
                    options={[{ value: '', label: '— seleziona —' }, ...(f.options || []).map(o => ({ value: o, label: o }))]}
                  />
                )}
                {f.type === 'date' && (
                  <input className="input" type="date" value={val} disabled={!canWrite}
                    onChange={e => set(key, e.target.value)} />
                )}
                {(f.type === 'integer' || f.type === 'decimal') && (
                  <>
                    <input className="input" type="number" value={val} disabled={!canWrite}
                      step={f.type === 'decimal' ? 'any' : 1}
                      min={f.min ?? undefined} max={f.max ?? undefined}
                      onChange={e => set(key, f.type === 'integer' ? parseInt(e.target.value, 10) : parseFloat(e.target.value))} />
                    {(f.min != null || f.max != null) && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                        {f.min != null && `Min: ${f.min}`}{f.min != null && f.max != null && '  ·  '}{f.max != null && `Max: ${f.max}`}
                      </div>
                    )}
                  </>
                )}
                {(f.type === 'string' || !f.type) && (
                  <>
                    <input className="input" type="text" value={val} disabled={!canWrite}
                      onChange={e => set(key, e.target.value)} />
                    {f.regex && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                        Formato: <code style={{ fontSize: 11 }}>{f.regex}</code>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {fields.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Nessun campo definito per questo database.</div>
          )}
        </div>

        {/* Colonna destra: accessibilità */}
        {(isAdmin && canWrite) ? (
          <div style={{ position: 'sticky', top: 20 }}>
            <div style={{ background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 14, padding: 20, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 16 }}>Accessibile a</div>
              <AccessPicker value={accessLevel} onChange={setAccessLevel} />
            </div>
            {accessLevel === 'admin_selected' && (
              <div style={{ background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 14, padding: 20 }}>
                <UserPicker selected={accessUsers} onChange={setAccessUsers} />
              </div>
            )}
          </div>
        ) : (
          <div style={{ background: 'var(--surface)', border: '1.5px solid var(--border)', borderRadius: 14, padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>ACCESSIBILE A</div>
            <AccessBadge value={accessLevel} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SchemaList ───────────────────────────────────────────────────────────────

function SchemaList({ onSelect, onNew }) {
  const modal = useModal();
  const toast = useToast();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  const [schemas, setSchemas] = useState(null);
  const [moduleConfig, setModuleConfig] = useState({});
  const canManage = isSuperAdmin || !!moduleConfig.adminCanCreate;

  const load = useCallback(async () => {
    try {
      const [{ schemas: s }, { modules: m }] = await Promise.all([api('/db/schemas'), api('/modules')]);
      setSchemas(s);
      setModuleConfig((m || []).find(x => x.key === 'database')?.config || {});
    } catch { setSchemas([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const h = () => load();
    window.addEventListener('sophia:db:schema:created', h);
    window.addEventListener('sophia:db:schema:updated', h);
    window.addEventListener('sophia:db:schema:deleted', h);
    return () => {
      window.removeEventListener('sophia:db:schema:created', h);
      window.removeEventListener('sophia:db:schema:updated', h);
      window.removeEventListener('sophia:db:schema:deleted', h);
    };
  }, [load]);

  const deleteSchema = async s => {
    const ok = await modal.confirm(`Eliminare "${s.name}" e tutti i suoi record?`, { danger: true });
    if (!ok) return;
    try { await api(`/db/schemas/${s.id}`, { method: 'DELETE' }); toast.info(`"${s.name}" eliminato`); load(); }
    catch (err) { toast.error(err.message); }
  };

  if (!schemas) return <div className="skeleton" style={{ height: 200 }} />;

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">Database</h1>
          <p className="page-subtitle">Database personalizzati del tenant con campi tipizzati, validazione e controllo degli accessi.</p>
        </div>
        {canManage && (
          <button className="btn btn-primary" onClick={onNew}>
            <Plus size={16} /> Nuovo database
          </button>
        )}
      </div>

      {schemas.length === 0 ? (
        <div className="card empty-state" style={{ marginTop: 24 }}>
          <div className="empty-icon"><DbIcon size={24} strokeWidth={1.75} /></div>
          <h3>Nessun database</h3>
          <p>Crea il primo database per archiviare dati strutturati accessibili all'AI.</p>
          {canManage && (
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={onNew}>
              <Plus size={16} /> Crea database
            </button>
          )}
        </div>
      ) : (
        <div className="flows-list" style={{ marginTop: 24 }}>
          {schemas.map(s => (
            <div key={s.id} className="flow-card card" style={{ cursor: 'pointer' }} onClick={() => onSelect(s)}>
              <div className="flow-header">
                <div className="flow-title-row">
                  <IonIcon name={s.icon || 'server-outline'} size={18} style={{ color: 'var(--primary)' }} />
                  <span className="flow-name">{s.name}</span>
                  {s.showInSidebar && <span className="badge badge-on" style={{ fontSize: 10 }}>Sidebar</span>}
                  <AccessBadge value={s.accessLevel} />
                  {s.description && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{s.description}</span>}
                </div>
                <div className="flow-actions" onClick={e => e.stopPropagation()}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{(s.fields || []).length} campi</span>
                  {canManage && (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => onSelect(s, 'edit')}>
                        <Settings size={13} /> Struttura
                      </button>
                      <button className="btn btn-danger icon-btn" onClick={() => deleteSchema(s)}>
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                  <button className="btn btn-primary btn-sm" onClick={() => onSelect(s)}>Apri →</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── RecordView — tabella record ──────────────────────────────────────────────

function RecordView({ initialSchema, onBack, onEditStructure }) {
  const toast = useToast();
  const modal = useModal();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  const [schema, setSchema] = useState(initialSchema);
  const [records, setRecords] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [moduleConfig, setModuleConfig] = useState({});
  const [screenRecord, setScreenRecord] = useState(null); // { record?, mode: 'new'|'edit'|'view' }
  const LIMIT = 50;

  const canWrite = isSuperAdmin || !!moduleConfig.adminCanWrite;
  const canManage = isSuperAdmin || !!moduleConfig.adminCanCreate;

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page, limit: LIMIT, ...(search ? { q: search } : {}) });
      const { records: r, total: t, schema: s } = await api(`/db/schemas/${schema.id}/records?${params}`);
      setRecords(r); setTotal(t);
      if (s) setSchema(prev => ({ ...prev, ...s }));
    } catch { setRecords([]); }
  }, [schema.id, page, search]);

  useEffect(() => {
    api('/modules').then(({ modules: m }) => setModuleConfig((m || []).find(x => x.key === 'database')?.config || {})).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const h = () => load();
    window.addEventListener('sophia:db:record:created', h);
    window.addEventListener('sophia:db:record:updated', h);
    window.addEventListener('sophia:db:record:deleted', h);
    return () => {
      window.removeEventListener('sophia:db:record:created', h);
      window.removeEventListener('sophia:db:record:updated', h);
      window.removeEventListener('sophia:db:record:deleted', h);
    };
  }, [load]);

  const deleteRecord = async r => {
    const f0 = (schema.fields || [])[0];
    const label = f0 ? String(r.data?.[f0.id || f0.name] || r.id) : r.id;
    const ok = await modal.confirm(`Eliminare il record "${label}"?`, { danger: true });
    if (!ok) return;
    try { await api(`/db/schemas/${schema.id}/records/${r.id}`, { method: 'DELETE' }); toast.info('Record eliminato'); load(); }
    catch (err) { toast.error(err.message); }
  };

  // Se è aperto un editor record → mostralo fullscreen
  if (screenRecord) {
    return (
      <RecordEditor
        record={screenRecord.record}
        schema={schema}
        onBack={() => { setScreenRecord(null); load(); }}
        onSaved={() => { setScreenRecord(null); load(); }}
        canWrite={screenRecord.mode !== 'view' && canWrite}
      />
    );
  }

  const fields = schema.fields || [];
  const tableFields = fields.slice(0, 4);

  return (
    <div>
      {/* Header — freccia a sinistra, nome a destra (nel titolo) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button
          className="btn btn-ghost"
          onClick={onBack}
          style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
        >
          <ChevronLeft size={16} />
          Database
        </button>
        <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
        <IonIcon name={schema.icon || 'server-outline'} size={20} style={{ color: 'var(--primary)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            {schema.name}
            <AccessBadge value={schema.accessLevel} />
          </h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>{total} record</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {canManage && (
            <button className="btn btn-ghost btn-sm" onClick={onEditStructure}>
              <Settings size={14} /> Struttura
            </button>
          )}
          {canWrite && (
            <button className="btn btn-primary" onClick={() => setScreenRecord({ mode: 'new' })}>
              <Plus size={15} /> Nuovo record
            </button>
          )}
        </div>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 380 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
          <input className="input" style={{ paddingLeft: 30 }} placeholder={`Cerca in ${schema.name}…`}
            value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
        </div>
      </div>

      {/* Table */}
      {!records ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : records.length === 0 ? (
        <div className="card empty-state">
          <DbIcon size={22} strokeWidth={1.75} />
          <h3>{search ? 'Nessun risultato' : 'Nessun record'}</h3>
          {!search && canWrite && (
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setScreenRecord({ mode: 'new' })}>
              <Plus size={14} /> Aggiungi il primo record
            </button>
          )}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--gray-50)', borderBottom: '1px solid var(--border)' }}>
                  {tableFields.map(f => (
                    <th key={f.id || f.name} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {f.label}
                    </th>
                  ))}
                  <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Accessibile a</th>
                  <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Aggiornato</th>
                  <th style={{ width: 110 }} />
                </tr>
              </thead>
              <tbody>
                {records.map((r, i) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--border)', background: i % 2 ? 'transparent' : 'rgba(0,0,0,.01)' }}>
                    {tableFields.map(f => {
                      const key = f.id || f.name;
                      const val = r.data?.[key];
                      return (
                        <td key={key} style={{ padding: '10px 14px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {f.type === 'boolean' ? (val ? <Check size={14} style={{ color: '#16a34a' }} /> : '—') : (val ?? '—')}
                        </td>
                      );
                    })}
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}><AccessBadge value={r.accessLevel} /></td>
                    <td style={{ padding: '10px 14px', color: 'var(--text-muted)', whiteSpace: 'nowrap', fontSize: 11 }}>{fmtDate(r.updatedAt)}</td>
                    <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setScreenRecord({ record: r, mode: 'view' })}><Eye size={13} /></button>
                        {canWrite && (
                          <>
                            <button className="btn btn-ghost btn-sm" onClick={() => setScreenRecord({ record: r, mode: 'edit' })}><Pencil size={13} /></button>
                            <button className="btn btn-danger icon-btn btn-sm" onClick={() => deleteRecord(r)}><Trash2 size={13} /></button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > LIMIT && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderTop: '1px solid var(--border)', fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted)' }}>{(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, total)} di {total}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost btn-sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prec</button>
                <button className="btn btn-ghost btn-sm" disabled={page * LIMIT >= total} onClick={() => setPage(p => p + 1)}>Succ →</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default function Database() {
  const { schemaId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  // Vista corrente: 'list' | 'records' | 'schema-new' | 'schema-edit'
  const [view, setView] = useState(schemaId ? 'records' : 'list');
  const [activeSchema, setActiveSchema] = useState(null);
  const [moduleActive, setModuleActive] = useState(null);

  useEffect(() => {
    if (isSuperAdmin) { setModuleActive(true); return; }
    api('/modules').then(({ modules: m }) => {
      const db = (m || []).find(x => x.key === 'database');
      setModuleActive(!!(db?.installed && db?.enabled));
    }).catch(() => setModuleActive(false));
  }, [isSuperAdmin]);

  useEffect(() => {
    if (!schemaId) { setView('list'); setActiveSchema(null); return; }
    if (moduleActive === null) return;
    api(`/db/schemas/${schemaId}`)
      .then(({ schema }) => { setActiveSchema(schema); setView('records'); })
      .catch(() => navigate('/database', { replace: true }));
  }, [schemaId, moduleActive, navigate]);

  if (moduleActive === null) return <div className="skeleton" style={{ height: 200 }} />;

  if (!moduleActive && !isSuperAdmin) {
    return (
      <div className="card empty-state" style={{ marginTop: 40 }}>
        <div className="empty-icon"><DbIcon size={24} strokeWidth={1.75} /></div>
        <h3>Modulo Database non attivo</h3>
        <p>Questo modulo non è attivo per il tuo tenant. Contatta il Super Admin per abilitarlo.</p>
      </div>
    );
  }

  // ── Schema editor (nuovo) ──
  if (view === 'schema-new') {
    return (
      <SchemaEditor
        onBack={() => setView('list')}
        onSaved={() => { setView('list'); }}
      />
    );
  }

  // ── Schema editor (modifica struttura) ──
  if (view === 'schema-edit' && activeSchema) {
    return (
      <SchemaEditor
        schema={activeSchema}
        onBack={() => setView(activeSchema ? 'records' : 'list')}
        onSaved={() => {
          // Ricarica schema aggiornato
          api(`/db/schemas/${activeSchema.id}`).then(({ schema: s }) => {
            setActiveSchema(s);
            setView('records');
          }).catch(() => setView('list'));
        }}
      />
    );
  }

  // ── Vista record ──
  if (view === 'records' && activeSchema) {
    return (
      <RecordView
        initialSchema={activeSchema}
        onBack={() => { setActiveSchema(null); setView('list'); navigate('/database'); }}
        onEditStructure={() => setView('schema-edit')}
      />
    );
  }

  // ── Lista schemi (default) ──
  return (
    <SchemaList
      onNew={() => setView('schema-new')}
      onSelect={(s, mode) => {
        setActiveSchema(s);
        navigate(`/database/${s.id}`);
        setView(mode === 'edit' ? 'schema-edit' : 'records');
      }}
    />
  );
}
