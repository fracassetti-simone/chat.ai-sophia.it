import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Pause, Play, Clock, RefreshCw, Calendar as CalIcon, X, Save, Zap, Pencil, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';

const DAYS = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
const MONTHS = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const pad = n => String(n).padStart(2,'0');

function DateTimePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const btnRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [viewM, setViewM] = useState(() => { const d = value ? new Date(value) : new Date(); return { year: d.getFullYear(), month: d.getMonth() }; });
  const date = value ? new Date(value) : null;
  const selDate = date ? `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}` : '';
  const selHour = date ? date.getHours() : 9;
  const selMin  = date ? Math.floor(date.getMinutes()/5)*5 : 0;

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target) && !btnRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const openPicker = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + window.scrollY + 6, left: Math.min(r.left, window.innerWidth - 300) });
    }
    setOpen(o => !o);
  };

  const prevMonth = () => setViewM(v => { const m=v.month===0?11:v.month-1; return {month:m,year:m===11?v.year-1:v.year}; });
  const nextMonth = () => setViewM(v => { const m=(v.month+1)%12; return {month:m,year:m===0?v.year+1:v.year}; });

  const pick = (d, h=selHour, m=selMin) => {
    const dt = new Date(`${d}T${pad(h)}:${pad(m)}:00`);
    onChange(dt.toISOString());
  };

  const daysInMonth = new Date(viewM.year, viewM.month+1, 0).getDate();
  const firstDow = new Date(viewM.year, viewM.month, 1).getDay();
  const cells = [];
  for (let i=0;i<firstDow;i++) cells.push(null);
  for (let d=1;d<=daysInMonth;d++) cells.push(d);

  const label = date ? date.toLocaleString('it-IT',{day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Seleziona data e ora';
  const safeDate = selDate || `${viewM.year}-${pad(viewM.month+1)}-01`;

  return (
    <>
      <button type="button" className="dp-trigger input" ref={btnRef} onClick={openPicker}>
        <CalIcon size={14} className="dp-icon"/> {label}
      </button>
      {open && (
        <div className="dp-popover-fixed card" style={{ top: pos.top, left: pos.left }} ref={ref}>
          <div className="dp-head">
            <button type="button" className="dp-nav" onClick={prevMonth}><ChevronLeft size={14}/></button>
            <span className="dp-title">{MONTHS[viewM.month]} {viewM.year}</span>
            <button type="button" className="dp-nav" onClick={nextMonth}><ChevronRight size={14}/></button>
          </div>
          <div className="dp-grid">
            {['D','L','M','M','G','V','S'].map((d,i)=><div key={i} className="dp-dow">{d}</div>)}
            {cells.map((d,i) => d===null ? <div key={i}/> : (
              <button key={i} type="button"
                className={`dp-day${selDate===`${viewM.year}-${pad(viewM.month+1)}-${pad(d)}`?' selected':''}`}
                onClick={() => pick(`${viewM.year}-${pad(viewM.month+1)}-${pad(d)}`)}>
                {d}
              </button>
            ))}
          </div>
          <div className="dp-time-row">
            <Clock size={13} style={{ color:'var(--gray-400)',flexShrink:0 }}/>
            <span style={{fontSize:12,color:'var(--text-muted)'}}>Ora</span>
            <select className="input time-sel" value={selHour} onChange={e => pick(safeDate, +e.target.value, selMin)}>
              {HOURS.map(h=><option key={h} value={h}>{pad(h)}</option>)}
            </select>
            <span className="time-sep">:</span>
            <select className="input time-sel" value={selMin} onChange={e => pick(safeDate, selHour, +e.target.value)}>
              {[0,5,10,15,20,25,30,35,40,45,50,55].map(m=><option key={m} value={m}>{pad(m)}</option>)}
            </select>
            <button className="btn btn-primary btn-sm" style={{marginLeft:'auto'}} onClick={() => setOpen(false)}>OK</button>
          </div>
        </div>
      )}
    </>
  );
}

function NewTaskModal({ conversations, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ kind:'ONCE', instruction:'', runAt:'', intervalSeconds:3600, conversationId:'' });
  const [saving, setSaving] = useState(false);
  const set = (k,v) => setForm(f=>({...f,[k]:v}));

  const save = async () => {
    if (!form.instruction.trim()) return toast.error('Inserisci un\'istruzione');
    if (form.kind === 'ONCE' && !form.runAt) return toast.error('Seleziona data e ora');
    setSaving(true);
    try {
      const body = { kind: form.kind, instruction: form.instruction };
      if (form.kind === 'ONCE') body.runAt = form.runAt;
      if (form.kind === 'RECURRING') body.intervalSeconds = form.intervalSeconds;
      if (form.conversationId) body.conversationId = form.conversationId;
      await api('/tasks', { method: 'POST', body });
      toast.info('Automazione creata'); onSaved();
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head-row">
          <h2 className="modal-title" style={{ margin: 0 }}>Nuova automazione</h2>
          <button className="btn btn-ghost icon-btn" onClick={onClose}><X size={18}/></button>
        </div>

        <div className="seg" style={{ marginBottom: 16 }}>
          <button className={`seg-btn${form.kind==='ONCE'?' active':''}`} onClick={()=>set('kind','ONCE')}><Clock size={14}/> Una volta</button>
          <button className={`seg-btn${form.kind==='RECURRING'?' active':''}`} onClick={()=>set('kind','RECURRING')}><RefreshCw size={14}/> Ricorrente</button>
        </div>

        <div className="field">
          <label>Istruzione per l'AI</label>
          <span className="field-hint">Descrivi cosa deve fare. Puoi includere nomi di contatti, testi da inviare, azioni da eseguire.</span>
          <textarea className="input" rows={4} value={form.instruction} onChange={e=>set('instruction',e.target.value)} placeholder={form.kind==='ONCE'?'Invia un messaggio WhatsApp a Mario Rossi ricordandogli l\'appuntamento di domani alle 15.':'Ogni giorno alle 9 controlla le email in arrivo e rispondi a quelle urgenti.'}/>
        </div>

        {form.kind === 'ONCE' && (
          <div className="field">
            <label>Data e ora di esecuzione</label>
            <DateTimePicker value={form.runAt} onChange={v=>set('runAt',v)}/>
          </div>
        )}

        {form.kind === 'RECURRING' && (
          <div className="field">
            <label>Intervallo</label>
            <select className="input" value={form.intervalSeconds} onChange={e=>set('intervalSeconds',+e.target.value)}>
              {[[60,'Ogni minuto'],[300,'Ogni 5 minuti'],[900,'Ogni 15 minuti'],[1800,'Ogni 30 minuti'],[3600,'Ogni ora'],[7200,'Ogni 2 ore'],[21600,'Ogni 6 ore'],[43200,'Ogni 12 ore'],[86400,'Ogni giorno'],[604800,'Ogni settimana']].map(([v,l])=>(<option key={v} value={v}>{l}</option>))}
            </select>
          </div>
        )}

        {conversations?.length > 0 && (
          <div className="field">
            <label>Chat collegata <span className="field-hint">— la risposta dell'AI apparirà in questa chat</span></label>
            <select className="input" value={form.conversationId} onChange={e=>set('conversationId',e.target.value)}>
              <option value="">Nessuna</option>
              {conversations.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </div>
        )}

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}><Save size={15}/> {saving?'Creo…':'Crea'}</button>
        </div>
      </div>
    </div>
  );
}

export default function Automations() {
  const toast = useToast();
  const modal = useModal();
  const [tasks, setTasks] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => {
    api('/tasks').then(r => setTasks(r.tasks || [])).catch(() => setTasks([]));
    api('/conversations').then(r => setConversations(r.conversations || [])).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (task) => {
    const newStatus = task.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: newStatus } }); load(); }
    catch (err) { toast.error(err.message); }
  };

  const remove = async (task) => {
    const ok = await modal.confirm(`Eliminare questa automazione?`, { danger: true });
    if (!ok) return;
    try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); load(); toast.info('Automazione eliminata'); }
    catch (err) { toast.error(err.message); }
  };

  if (!tasks) return <div className="skeleton" style={{ height: 300 }}/>;

  const grouped = { ONCE: tasks.filter(t=>t.kind==='ONCE'), RECURRING: tasks.filter(t=>t.kind==='RECURRING') };

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">Automazioni</h1>
          <p className="page-subtitle">Azioni programmate una volta o ricorrenti, eseguite dall'AI anche a browser chiuso.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}><Plus size={16}/> Nuova automazione</button>
      </div>

      {tasks.length === 0 ? (
        <div className="card empty-state" style={{ marginTop: 24 }}>
          <div className="empty-icon"><Zap size={24} strokeWidth={1.75}/></div>
          <h3>Nessuna automazione</h3>
          <p>Crea una azione programmata una sola volta ("avvisa Mario domani alle 10") o ricorrente ("ogni giorno alle 9 controlla le email").</p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowNew(true)}><Plus size={16}/> Crea automazione</button>
        </div>
      ) : (
        <>
          {grouped.ONCE.length > 0 && (
            <section style={{ marginBottom: 24 }}>
              <h2 className="cloud-section-title"><Clock size={14}/> Una volta</h2>
              <div className="flows-list">
                {grouped.ONCE.map(t => <TaskCard key={t.id} task={t} onToggle={toggle} onDelete={remove} onEdit={setEditing}/>)}
              </div>
            </section>
          )}
          {grouped.RECURRING.length > 0 && (
            <section>
              <h2 className="cloud-section-title"><RefreshCw size={14}/> Ricorrenti</h2>
              <div className="flows-list">
                {grouped.RECURRING.map(t => <TaskCard key={t.id} task={t} onToggle={toggle} onDelete={remove} onEdit={setEditing}/>)}
              </div>
            </section>
          )}
        </>
      )}

      {showNew && <NewTaskModal conversations={conversations} onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }}/>}
      {editing && <EditTaskModal task={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }}/>}
    </div>
  );
}

function EditTaskModal({ task, onClose, onSaved }) {
  const toast = useToast();
  const [instruction, setInstruction] = useState(task.instruction || '');
  const [runAt, setRunAt] = useState(task.runAt ? new Date(task.runAt).toISOString() : '');
  const [intervalSeconds, setIntervalSeconds] = useState(task.intervalSeconds || 3600);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!instruction.trim()) return toast.error('Inserisci un\'istruzione');
    if (task.kind === 'ONCE' && !runAt) return toast.error('Seleziona data e ora');
    setSaving(true);
    try {
      const body = { instruction };
      if (task.kind === 'ONCE') body.runAt = runAt;
      if (task.kind === 'RECURRING') body.intervalSeconds = intervalSeconds;
      await api(`/tasks/${task.id}/edit`, { method: 'PATCH', body });
      toast.info('Automazione aggiornata'); onSaved();
    } catch (err) { toast.error(err.message); setSaving(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head-row">
          <h2 className="modal-title" style={{ margin: 0 }}>Modifica automazione</h2>
          <button className="btn btn-ghost icon-btn" onClick={onClose}><X size={18}/></button>
        </div>
        <div className="field">
          <label>Istruzione</label>
          <textarea className="input" rows={4} value={instruction} onChange={e => setInstruction(e.target.value)}/>
        </div>
        {task.kind === 'ONCE' && (
          <div className="field">
            <label>Data e ora di esecuzione</label>
            <DateTimePicker value={runAt} onChange={setRunAt}/>
          </div>
        )}
        {task.kind === 'RECURRING' && (
          <div className="field">
            <label>Intervallo</label>
            <select className="input" value={intervalSeconds} onChange={e => setIntervalSeconds(+e.target.value)}>
              {[[60,'Ogni minuto'],[300,'Ogni 5 min'],[900,'Ogni 15 min'],[1800,'Ogni 30 min'],[3600,'Ogni ora'],[7200,'Ogni 2 ore'],[21600,'Ogni 6 ore'],[43200,'Ogni 12 ore'],[86400,'Ogni giorno'],[604800,'Ogni settimana']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        )}
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}><Save size={15}/> {saving ? 'Salvo…' : 'Salva'}</button>
        </div>
      </div>
    </div>
  );
}

function intervalLabel(seconds) {
  if (!seconds) return 'Intervallo sconosciuto';
  if (seconds < 60) return `Ogni ${seconds} secondi`;
  if (seconds < 3600) return `Ogni ${Math.round(seconds / 60)} minuti`;
  if (seconds < 86400) return `Ogni ${Math.round(seconds / 3600)} ore`;
  if (seconds < 604800) return `Ogni ${Math.round(seconds / 86400)} giorni`;
  return `Ogni ${Math.round(seconds / 604800)} settimane`;
}

function TaskCard({ task, onToggle, onDelete, onEdit }) {
  const STATUS_COLOR = { ACTIVE:'badge-on', PAUSED:'badge-off', DONE:'badge-on', FAILED:'badge-off' };
  const STATUS_LABEL = { ACTIVE:'Attivo', PAUSED:'In pausa', DONE:'Completato', FAILED:'Fallito' };
  return (
    <div className={`flow-card card${task.status==='PAUSED'||task.status==='DONE'?' flow-paused':''}`}>
      <div className="flow-header">
        <div className="flow-title-row">
          {task.kind==='ONCE' ? <Clock size={14} className="flow-icon"/> : <RefreshCw size={14} className="flow-icon"/>}
          <span className="flow-name">{task.instruction.slice(0,70)}{task.instruction.length>70?'…':''}</span>
          <span className={`badge ${STATUS_COLOR[task.status]||'badge-off'}`}>{STATUS_LABEL[task.status]||task.status}</span>
        </div>
        <div className="flow-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => onEdit(task)}><Pencil size={13}/> Modifica</button>
          {(task.status==='ACTIVE'||task.status==='PAUSED') && (
            <button className="btn btn-ghost btn-sm" onClick={() => onToggle(task)}>
              {task.status==='ACTIVE' ? <><Pause size={13}/> Pausa</> : <><Play size={13}/> Riattiva</>}
            </button>
          )}
          <button className="btn btn-danger icon-btn" onClick={() => onDelete(task)}><Trash2 size={13}/></button>
        </div>
      </div>
      <div className="flow-trigger">
        {task.kind==='ONCE'
          ? <><Clock size={11}/> Programmata per: {new Date(task.runAt).toLocaleString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}</>
          : <><RefreshCw size={11}/> {intervalLabel(task.intervalSeconds)}</>
        }
      </div>
      {task.lastRunAt && <div className="flow-meta">Ultima esecuzione: {new Date(task.lastRunAt).toLocaleString('it-IT',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>}
    </div>
  );
}
