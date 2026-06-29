import { useEffect, useState } from 'react';
import { Plus, Trash2, GripVertical, Save, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';

const TYPE_LABELS = { text: 'Testo', email: 'Email', phone: 'Telefono', number: 'Numero', date: 'Data', boolean: 'Sì/No' };

const EMPTY = { label: '', key: '', description: '', fieldType: 'text', required: false, active: true };

function toKey(label) { return label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''); }

export default function CollectFields() {
  const toast = useToast();
  const modal = useModal();
  const [fields, setFields] = useState(null);
  const [editing, setEditing] = useState(null); // null | field | {}
  const [dragging, setDragging] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => api('/collect-fields').then(r => setFields(r.fields)).catch(() => setFields([]));
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing.label?.trim()) return toast.error('Inserisci un nome per il campo');
    if (!editing.key?.trim()) return toast.error('Inserisci una chiave');
    setSaving(true);
    try {
      if (editing.id) await api(`/collect-fields/${editing.id}`, { method: 'PATCH', body: editing });
      else await api('/collect-fields', { method: 'POST', body: editing });
      toast.info(editing.id ? 'Campo aggiornato' : 'Campo aggiunto');
      setEditing(null); load();
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  const remove = async (f) => {
    const ok = await modal.confirm(`Eliminare il campo "${f.label}"?`, { danger: true });
    if (!ok) return;
    try { await api(`/collect-fields/${f.id}`, { method: 'DELETE' }); load(); toast.info('Campo eliminato'); }
    catch (err) { toast.error(err.message); }
  };

  // Drag to reorder
  const onDragStart = (f) => setDragging(f.id);
  const onDragOver = (e, targetId) => {
    e.preventDefault();
    if (!dragging || dragging === targetId) return;
    setFields(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(x => x.id === dragging);
      const toIdx   = arr.findIndex(x => x.id === targetId);
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return arr;
    });
  };
  const onDrop = async () => {
    setDragging(null);
    try { await api('/collect-fields/reorder', { method: 'PATCH', body: { ids: fields.map(f => f.id) } }); }
    catch { load(); }
  };

  if (!fields) return <div className="skeleton" style={{height:300}}/>;

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">Dati da raccogliere</h1>
          <p className="page-subtitle">Scegli quali informazioni l'AI deve cercare di raccogliere dagli utenti durante le conversazioni, per aggiornare automaticamente la rubrica.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY })}><Plus size={16}/> Aggiungi campo</button>
      </div>

      {fields.length === 0 ? (
        <div className="card empty-state" style={{marginTop:24}}>
          <div className="empty-icon"><Plus size={24} strokeWidth={1.75}/></div>
          <h3>Nessun campo configurato</h3>
          <p>Aggiungi i campi che vuoi raccogliere: nome, email, azienda, preferenze… L'AI li chiederà in modo naturale durante le conversazioni.</p>
          <button className="btn btn-primary" style={{marginTop:16}} onClick={() => setEditing({ ...EMPTY })}><Plus size={16}/> Aggiungi campo</button>
        </div>
      ) : (
        <div className="card collect-table">
          <div className="collect-header">
            <span/>
            <span>Nome campo</span>
            <span>Chiave</span>
            <span>Tipo</span>
            <span>Obbligatorio</span>
            <span>Attivo</span>
            <span/>
          </div>
          {fields.map(f => (
            <div
              key={f.id}
              className={`collect-row${dragging===f.id?' dragging':''}`}
              draggable
              onDragStart={() => onDragStart(f)}
              onDragOver={e => onDragOver(e, f.id)}
              onDrop={onDrop}
            >
              <span className="collect-drag"><GripVertical size={16}/></span>
              <span className="collect-label" onClick={() => setEditing(f)}>{f.label}</span>
              <span className="collect-key"><code>{f.key}</code></span>
              <span className="collect-type">{TYPE_LABELS[f.fieldType] || f.fieldType}</span>
              <span>{f.required ? '✓' : '—'}</span>
              <span>
                <label className="toggle-row" style={{gap:6}}>
                  <input type="checkbox" checked={f.active} onChange={async e => {
                    await api(`/collect-fields/${f.id}`, { method: 'PATCH', body: { active: e.target.checked } });
                    load();
                  }}/>
                </label>
              </span>
              <span className="collect-actions">
                <button className="icon-btn-sm danger" onClick={() => remove(f)}><Trash2 size={14}/></button>
              </span>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal card" style={{maxWidth:480}} onClick={e => e.stopPropagation()}>
            <div className="modal-head-row">
              <h2 className="modal-title" style={{margin:0}}>{editing.id ? 'Modifica campo' : 'Nuovo campo'}</h2>
              <button className="btn btn-ghost icon-btn" onClick={() => setEditing(null)}><X size={18}/></button>
            </div>
            <div className="field"><label>Nome visualizzato</label>
              <input className="input" value={editing.label||''} onChange={e => setEditing(f => ({ ...f, label: e.target.value, key: f.id ? f.key : toKey(e.target.value) }))} placeholder="Es. Email"/>
            </div>
            <div className="field"><label>Chiave interna <span className="field-hint">— lettere minuscole, numeri, underscore</span></label>
              <input className="input" value={editing.key||''} onChange={e => setEditing(f => ({ ...f, key: e.target.value }))} placeholder="es. email"/>
            </div>
            <div className="field"><label>Istruzione per l'AI</label>
              <input className="input" value={editing.description||''} onChange={e => setEditing(f => ({ ...f, description: e.target.value }))} placeholder="Es. Chiedi l'indirizzo email per inviare il preventivo"/>
            </div>
            <div className="form-grid">
              <div className="field"><label>Tipo</label>
                <select className="input" value={editing.fieldType||'text'} onChange={e => setEditing(f => ({ ...f, fieldType: e.target.value }))}>
                  {Object.entries(TYPE_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="field" style={{justifyContent:'flex-end'}}>
                <label className="toggle-row"><span>Obbligatorio</span><input type="checkbox" checked={!!editing.required} onChange={e => setEditing(f => ({ ...f, required: e.target.checked }))}/></label>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>Annulla</button>
              <button className="btn btn-primary" onClick={save} disabled={saving}><Save size={15}/> {saving?'Salvo…':'Salva'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
