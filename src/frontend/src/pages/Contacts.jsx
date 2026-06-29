import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  UserPlus, Search, Trash2, Save, MessageCircle, Plus, X, Mail, Phone, Building2, Tag,
  MapPin, ChevronRight, Users as UsersIcon, FolderOpen,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';

const EMPTY = {
  firstName: '', lastName: '', phone: '', email: '', company: '', jobRole: '',
  city: '', address: '', category: '', preferences: '', notes: '', tags: [], customFields: {},
};

function initials(c) {
  const a = (c.firstName || c.company || c.phone || c.email || '?').trim()[0] || '?';
  const b = (c.lastName || '').trim()[0] || '';
  return (a + b).toUpperCase();
}

function prettyPhone(p) {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  if (d.startsWith('39') && d.length >= 11) {
    const r = d.slice(2);
    return `+39 ${r.slice(0, 3)} ${r.slice(3, 6)} ${r.slice(6)}`.trim();
  }
  return '+' + d;
}

export default function Contacts() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [editing, setEditing] = useState(null);
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const openId = searchParams.get('open');
    const searchQ = searchParams.get('q');
    if (searchQ) setQ(searchQ);
    if (openId && data) {
      const contact = data.contacts.find(c => c.id === openId);
      if (contact) { setEditing(contact); return; }
      // Se non è in lista (es. paginazione), caricalo via API
      api(`/contacts/${openId}`).then(r => setEditing(r.contact)).catch(() => {});
    }
  }, [searchParams, data]);

  const load = () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (category) params.set('category', category);
    if (tag) params.set('tag', tag);
    const qs = params.toString();
    return api(`/contacts${qs ? `?${qs}` : ''}`).then(setData).catch(() => setData({ contacts: [], categories: [], tags: [] }));
  };

  // Debounce ricerca
  useEffect(() => {
    const t = setTimeout(load, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category, tag]);

  const contacts = data?.contacts || [];
  const categories = data?.categories || [];
  const tags = data?.tags || [];

  const grouped = useMemo(() => {
    const map = new Map();
    for (const c of contacts) {
      const key = c.category || 'Senza categoria';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [contacts]);

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">Rubrica</h1>
          <p className="page-subtitle">I contatti dell'azienda, anche quelli raccolti automaticamente dalle conversazioni.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY })}>
          <UserPlus size={16} /> Nuovo contatto
        </button>
      </div>

      <div className="contacts-toolbar card">
        <div className="search-box">
          <Search size={16} className="search-ico" />
          <input
            className="search-inp"
            placeholder="Cerca per nome, telefono, email o azienda"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="input filter-sel" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Tutte le categorie</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input filter-sel" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">Tutte le etichette</option>
          {tags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {!data ? (
        <div className="skeleton" style={{ height: 280, marginTop: 16 }} />
      ) : contacts.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-icon"><UsersIcon size={24} strokeWidth={1.75} /></div>
          <h3>Nessun contatto</h3>
          <p>Aggiungi il primo contatto, oppure lascia che si popolino da soli dalle conversazioni WhatsApp.</p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setEditing({ ...EMPTY })}>
            <UserPlus size={16} /> Nuovo contatto
          </button>
        </div>
      ) : (
        <div className="contacts-groups">
          {grouped.map(([cat, list]) => (
            <section key={cat} className="contacts-group">
              <div className="contacts-group-head">
                <span>{cat}</span>
                <span className="contacts-group-count">{list.length}</span>
              </div>
              <div className="card contacts-list">
                {list.map((c) => (
                  <button key={c.id} className="contact-row" onClick={() => setEditing(c)}>
                    <span className="contact-avatar">{initials(c)}</span>
                    <span className="contact-main">
                      <span className="contact-name">{c.displayName}</span>
                      <span className="contact-sub">
                        {c.company && <span><Building2 size={12} /> {c.company}</span>}
                        {c.phone && <span><Phone size={12} /> {prettyPhone(c.phone)}</span>}
                        {c.email && <span><Mail size={12} /> {c.email}</span>}
                      </span>
                    </span>
                    {c.tags?.length > 0 && (
                      <span className="contact-tags">
                        {c.tags.slice(0, 2).map((t) => <span key={t} className="tag-chip sm">{t}</span>)}
                      </span>
                    )}
                    <ChevronRight size={16} className="contact-chev" />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {editing && (
        <ContactEditor
          contact={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function ContactEditor({ contact, categories, onClose, onSaved }) {
  const toast = useToast();
  const modal = useModal();
  const navigate = useNavigate();
  const isNew = !contact.id;
  const [form, setForm] = useState({
    ...EMPTY,
    ...contact,
    tags: contact.tags || [],
    customFields: contact.customFields || {},
  });
  const [tagInput, setTagInput] = useState('');
  const [custom, setCustom] = useState(
    Object.entries(contact.customFields || {}).map(([key, value]) => ({ key, value: String(value) }))
  );
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !form.tags.includes(t)) set('tags', [...form.tags, t]);
    setTagInput('');
  };
  const removeTag = (t) => set('tags', form.tags.filter((x) => x !== t));

  const save = async () => {
    setSaving(true);
    const customFields = {};
    for (const { key, value } of custom) {
      if (key.trim()) customFields[key.trim()] = value;
    }
    const body = { ...form, customFields };
    if (!body.email) delete body.email; // evita validazione email vuota
    try {
      if (isNew) await api('/contacts', { method: 'POST', body });
      else await api(`/contacts/${contact.id}`, { method: 'PATCH', body });
      toast.info(isNew ? 'Contatto creato' : 'Contatto aggiornato');
      onSaved();
    } catch (err) {
      toast.error(err.message);
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = await modal.confirm('Eliminare questo contatto?', { danger: true });
    if (!ok) return;
    try { await api(`/contacts/${contact.id}`, { method: 'DELETE' }); toast.info('Contatto eliminato'); onSaved(); }
    catch (err) { toast.error(err.message); }
  };

  const openDocuments = async () => {
    try {
      const { folderId } = await api(`/cloud/contact/${contact.id}/folder`, { method: 'POST' });
      navigate(`/cloud?folder=${folderId}`);
    } catch (err) { toast.error(err.message); }
  };

  const writeWhatsApp = async () => {
    const d = String(form.phone || '').replace(/\D/g, '');
    if (!d) { toast.error('Aggiungi un numero di telefono per scrivere su WhatsApp.'); return; }
    try {
      // Crea o apre una chat esterna con questo numero, poi naviga
      const { chat } = await api('/external-chats', { method: 'POST', body: { phone: d, displayName: form.displayName || form.firstName || form.company || d } });
      navigate(`/external-chats/${chat.id}`);
      onClose();
    } catch (err) {
      toast.error('Impossibile aprire la chat WhatsApp: ' + err.message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card contact-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head-row">
          <h2 className="modal-title" style={{ margin: 0 }}>
            <span className="contact-avatar lg">{initials(form)}</span>
            {isNew ? 'Nuovo contatto' : (form.displayName || 'Contatto')}
          </h2>
          <button className="btn btn-ghost icon-btn" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="form-grid">
          <Field label="Nome"><input className="input" value={form.firstName || ''} onChange={(e) => set('firstName', e.target.value)} /></Field>
          <Field label="Cognome"><input className="input" value={form.lastName || ''} onChange={(e) => set('lastName', e.target.value)} /></Field>
          <Field label="Telefono" hint="Internazionale, anche con + o spazi">
            <input className="input" value={form.phone || ''} onChange={(e) => set('phone', e.target.value)} placeholder="+39 333 123 4567" />
          </Field>
          <Field label="Email"><input className="input" type="email" value={form.email || ''} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="Azienda"><input className="input" value={form.company || ''} onChange={(e) => set('company', e.target.value)} /></Field>
          <Field label="Ruolo"><input className="input" value={form.jobRole || ''} onChange={(e) => set('jobRole', e.target.value)} /></Field>
          <Field label="Città"><input className="input" value={form.city || ''} onChange={(e) => set('city', e.target.value)} /></Field>
          <Field label="Categoria" hint="Es. Clienti, Fornitori">
            <input className="input" list="contact-cats" value={form.category || ''} onChange={(e) => set('category', e.target.value)} />
            <datalist id="contact-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Indirizzo" full><input className="input" value={form.address || ''} onChange={(e) => set('address', e.target.value)} /></Field>
        </div>

        <Field label="Etichette">
          <div className="tag-editor">
            {form.tags.map((t) => (
              <span key={t} className="tag-chip">{t}<button onClick={() => removeTag(t)}><X size={12} /></button></span>
            ))}
            <input
              className="tag-input"
              placeholder="Aggiungi etichetta"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
              onBlur={addTag}
            />
          </div>
        </Field>

        <Field label="Preferenze"><textarea className="input" rows={2} value={form.preferences || ''} onChange={(e) => set('preferences', e.target.value)} /></Field>
        <Field label="Note"><textarea className="input" rows={3} value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} /></Field>

        <Field label="Campi personalizzati">
          <div className="custom-fields">
            {custom.map((row, i) => (
              <div key={i} className="custom-row">
                <input className="input" placeholder="Etichetta" value={row.key}
                  onChange={(e) => setCustom(custom.map((r, j) => j === i ? { ...r, key: e.target.value } : r))} />
                <input className="input" placeholder="Valore" value={row.value}
                  onChange={(e) => setCustom(custom.map((r, j) => j === i ? { ...r, value: e.target.value } : r))} />
                <button className="btn btn-ghost icon-btn" onClick={() => setCustom(custom.filter((_, j) => j !== i))}><Trash2 size={15} /></button>
              </div>
            ))}
            <button className="btn btn-outline btn-sm" onClick={() => setCustom([...custom, { key: '', value: '' }])}>
              <Plus size={14} /> Aggiungi campo
            </button>
          </div>
        </Field>

        <div className="contact-modal-foot">
          <div className="foot-left">
            {!isNew && <button className="btn btn-danger" onClick={remove}><Trash2 size={16} /> Elimina</button>}
          </div>
          <div className="foot-right">
            {!isNew && <button className="btn btn-outline" onClick={openDocuments}><FolderOpen size={16} /> Documenti</button>}
            {form.phone && <button className="btn btn-outline wa-btn" onClick={writeWhatsApp}><MessageCircle size={16} /> Scrivi su WhatsApp</button>}
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              <Save size={16} /> {saving ? 'Salvo…' : 'Salva'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, full, children }) {
  return (
    <div className={`field${full ? ' field-full' : ''}`}>
      <label>{label}{hint && <span className="field-hint"> — {hint}</span>}</label>
      {children}
    </div>
  );
}
