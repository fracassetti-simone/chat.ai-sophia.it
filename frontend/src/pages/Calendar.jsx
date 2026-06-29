import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, X, Trash2, Save, Bell, MapPin, AlignLeft, Calendar as CalIcon } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';

const DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const MONTHS = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function pad(n) { return String(n).padStart(2, '0'); }
function toDateInput(d) { const dt = new Date(d); return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`; }
function toTimeInput(d) { const dt = new Date(d); return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`; }
function parseDateTime(dateStr, timeStr) { return new Date(`${dateStr}T${timeStr}:00`); }

// ── Custom Date Picker ────────────────────────────────────────────────────
function DatePicker({ value, onChange, label }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const date = value ? new Date(value + 'T00:00:00') : new Date();
  const [view, setView] = useState({ year: date.getFullYear(), month: date.getMonth() });

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  const firstDay = new Date(view.year, view.month, 1).getDay();
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const select = (d) => {
    onChange(`${view.year}-${pad(view.month + 1)}-${pad(d)}`);
    setOpen(false);
  };

  const displayVal = value ? new Date(value + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' }) : 'Seleziona data';

  return (
    <div className="datepicker-wrap" ref={ref}>
      {label && <label className="dp-label">{label}</label>}
      <button type="button" className="dp-trigger input" onClick={() => setOpen(o => !o)}>
        <CalIcon size={15} className="dp-icon" />{displayVal}
      </button>
      {open && (
        <div className="dp-popover card">
          <div className="dp-head">
            <button type="button" className="dp-nav" onClick={() => setView(v => { const m = v.month === 0 ? 11 : v.month - 1; return { month: m, year: m === 11 ? v.year - 1 : v.year }; })}><ChevronLeft size={15}/></button>
            <span className="dp-title">{MONTHS[view.month]} {view.year}</span>
            <button type="button" className="dp-nav" onClick={() => setView(v => { const m = (v.month + 1) % 12; return { month: m, year: m === 0 ? v.year + 1 : v.year }; })}><ChevronRight size={15}/></button>
          </div>
          <div className="dp-grid">
            {['D','L','M','M','G','V','S'].map((d,i) => <div key={i} className="dp-dow">{d}</div>)}
            {cells.map((d, i) => d === null
              ? <div key={i} />
              : <button key={i} type="button"
                  className={`dp-day${value === `${view.year}-${pad(view.month+1)}-${pad(d)}` ? ' selected' : ''}`}
                  onClick={() => select(d)}>{d}</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Custom Time Picker ─────────────────────────────────────────────────────
function TimePicker({ value, onChange, label }) {
  const [h, m] = (value || '09:00').split(':').map(Number);
  const setH = (v) => onChange(`${pad(v)}:${pad(m)}`);
  const setM = (v) => onChange(`${pad(h)}:${pad(v)}`);
  return (
    <div className="timepicker-wrap">
      {label && <label className="dp-label">{label}</label>}
      <div className="timepicker-row">
        <select className="input time-sel" value={h} onChange={e => setH(Number(e.target.value))}>
          {HOURS.map(i => <option key={i} value={i}>{pad(i)}</option>)}
        </select>
        <span className="time-sep">:</span>
        <select className="input time-sel" value={m} onChange={e => setM(Number(e.target.value))}>
          {[0,5,10,15,20,25,30,35,40,45,50,55].map(i => <option key={i} value={i}>{pad(i)}</option>)}
        </select>
      </div>
    </div>
  );
}

// ── Event Form Modal ───────────────────────────────────────────────────────
function EventModal({ event, calendars, defaultDate, onClose, onSaved }) {
  const toast = useToast();
  const modal = useModal();
  const isNew = !event?.id;

  const initDate = defaultDate ? toDateInput(defaultDate) : toDateInput(new Date());
  const initTime = defaultDate ? toTimeInput(defaultDate) : '09:00';
  const endTime = defaultDate ? toTimeInput(new Date(defaultDate.getTime() + 60*60000)) : '10:00';

  const [form, setForm] = useState({
    calendarId: calendars[0]?.id || '',
    title: '',
    description: '',
    location: '',
    startDate: initDate,
    startTime: initTime,
    endDate: initDate,
    endTime,
    allDay: false,
    reminderMin: '',
    reminderCh: 'dashboard',
    ...(event ? {
      calendarId: event.calendarId,
      title: event.title,
      description: event.description || '',
      location: event.location || '',
      startDate: toDateInput(event.startAt),
      startTime: toTimeInput(event.startAt),
      endDate: toDateInput(event.endAt),
      endTime: toTimeInput(event.endAt),
      allDay: event.allDay,
      reminderMin: event.reminderMin ?? '',
      reminderCh: event.reminderCh || 'dashboard',
    } : {}),
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.title.trim()) { toast.error('Inserisci un titolo'); return; }
    if (!form.calendarId) { toast.error('Seleziona un calendario'); return; }
    setSaving(true);
    const body = {
      calendarId: form.calendarId,
      title: form.title.trim(),
      description: form.description || null,
      location: form.location || null,
      startAt: parseDateTime(form.startDate, form.allDay ? '00:00' : form.startTime).toISOString(),
      endAt: parseDateTime(form.endDate, form.allDay ? '23:59' : form.endTime).toISOString(),
      allDay: form.allDay,
      reminderMin: form.reminderMin !== '' ? Number(form.reminderMin) : null,
      reminderCh: form.reminderCh || null,
    };
    try {
      if (isNew) await api('/calendars/events', { method: 'POST', body });
      else await api(`/calendars/events/${event.id}`, { method: 'PATCH', body });
      toast.info(isNew ? 'Evento creato' : 'Evento aggiornato');
      onSaved();
    } catch (err) { toast.error(err.message); setSaving(false); }
  };

  const remove = async () => {
    const ok = await modal.confirm(`Eliminare "${form.title}"?`, { danger: true });
    if (!ok) return;
    try {
      await api(`/calendars/events/${event.id}`, { method: 'DELETE' });
      toast.info('Evento eliminato'); onSaved();
    } catch (err) { toast.error(err.message); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card event-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head-row">
          <h2 className="modal-title" style={{ margin: 0 }}>{isNew ? 'Nuovo evento' : 'Modifica evento'}</h2>
          <button className="btn btn-ghost icon-btn" onClick={onClose}><X size={18}/></button>
        </div>

        <div className="field"><label>Titolo</label>
          <input className="input" placeholder="Aggiungi titolo" value={form.title} onChange={e => set('title', e.target.value)} autoFocus />
        </div>

        {calendars.length > 1 && (
          <div className="field"><label>Calendario</label>
            <select className="input" value={form.calendarId} onChange={e => set('calendarId', e.target.value)}>
              {calendars.filter(c => c.canEdit).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        <label className="toggle-row" style={{ marginBottom: 12 }}>
          <span>Tutto il giorno</span>
          <input type="checkbox" checked={form.allDay} onChange={e => set('allDay', e.target.checked)} />
        </label>

        <div className="form-grid">
          <DatePicker label="Data inizio" value={form.startDate} onChange={v => set('startDate', v)} />
          {!form.allDay && <TimePicker label="Ora inizio" value={form.startTime} onChange={v => set('startTime', v)} />}
          <DatePicker label="Data fine" value={form.endDate} onChange={v => set('endDate', v)} />
          {!form.allDay && <TimePicker label="Ora fine" value={form.endTime} onChange={v => set('endTime', v)} />}
        </div>

        <div className="field"><label><MapPin size={13}/> Luogo</label>
          <input className="input" placeholder="Aggiungi luogo" value={form.location} onChange={e => set('location', e.target.value)} />
        </div>
        <div className="field"><label><AlignLeft size={13}/> Descrizione</label>
          <textarea className="input" rows={2} placeholder="Aggiungi note" value={form.description} onChange={e => set('description', e.target.value)} />
        </div>

        <div className="form-grid">
          <div className="field"><label><Bell size={13}/> Promemoria (min prima)</label>
            <select className="input" value={form.reminderMin} onChange={e => set('reminderMin', e.target.value)}>
              <option value="">Nessuno</option>
              {[5,10,15,30,60,120,1440].map(m => <option key={m} value={m}>{m < 60 ? `${m} min` : m < 1440 ? `${m/60} ore` : '1 giorno'}</option>)}
            </select>
          </div>
          {form.reminderMin !== '' && (
            <div className="field"><label>Canale avviso</label>
              <select className="input" value={form.reminderCh} onChange={e => set('reminderCh', e.target.value)}>
                <option value="dashboard">Dashboard</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Email</option>
              </select>
            </div>
          )}
        </div>

        <div className="contact-modal-foot">
          <div className="foot-left">{!isNew && <button className="btn btn-danger" onClick={remove}><Trash2 size={15}/> Elimina</button>}</div>
          <div className="foot-right">
            <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}><Save size={15}/> {saving ? 'Salvo…' : 'Salva'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Calendar ─────────────────────────────────────────────────────────
export default function Calendar() {
  const toast = useToast();
  const modal = useModal();
  const [view, setView] = useState('month'); // month | week | day
  const [today] = useState(() => new Date());
  const [cursor, setCursor] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; });
  const [calendars, setCalendars] = useState([]);
  const [events, setEvents] = useState([]);
  const [editing, setEditing] = useState(null); // null | {} (new) | event
  const [defaultDate, setDefaultDate] = useState(null);
  const [hiddenCals, setHiddenCals] = useState(new Set());

  const loadCals = useCallback(() => api('/calendars').then(r => setCalendars(r.calendars)).catch(() => {}), []);

  const loadEvents = useCallback(() => {
    let from, to;
    if (view === 'month') {
      from = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      to = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59);
    } else if (view === 'week') {
      const dow = cursor.getDay();
      from = new Date(cursor); from.setDate(cursor.getDate() - dow); from.setHours(0,0,0,0);
      to = new Date(from); to.setDate(from.getDate() + 6); to.setHours(23,59,59);
    } else {
      from = new Date(cursor); from.setHours(0,0,0,0);
      to = new Date(cursor); to.setHours(23,59,59);
    }
    api(`/calendars/events?from=${from.toISOString()}&to=${to.toISOString()}`)
      .then(r => setEvents(r.events))
      .catch(() => {});
  }, [cursor, view]);

  useEffect(() => { loadCals(); }, [loadCals]);
  useEffect(() => { loadEvents(); }, [loadEvents]);

  const visibleEvents = useMemo(() =>
    events.filter(e => !hiddenCals.has(e.calendarId)),
  [events, hiddenCals]);

  const nav = (dir) => {
    setCursor(c => {
      const d = new Date(c);
      if (view === 'month') d.setMonth(d.getMonth() + dir);
      else if (view === 'week') d.setDate(d.getDate() + dir * 7);
      else d.setDate(d.getDate() + dir);
      return d;
    });
  };

  const [showNewCal, setShowNewCal] = useState(false);
  const [newCalName, setNewCalName] = useState('');
  const [newCalColor, setNewCalColor] = useState('#2563eb');

  const openNew = (date) => { setDefaultDate(date || new Date()); setEditing({}); };
  const openEdit = (ev) => { setDefaultDate(null); setEditing(ev); };
  const onSaved = () => { setEditing(null); loadEvents(); loadCals(); };

  const title = view === 'month'
    ? `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`
    : view === 'week'
      ? `Settimana del ${cursor.toLocaleDateString('it-IT', { day: '2-digit', month: 'long' })}`
      : cursor.toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

  const toggleCal = (id) => setHiddenCals(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const createCal = async () => {
    if (!newCalName.trim()) return;
    try {
      await api('/calendars', { method: 'POST', body: { name: newCalName.trim(), color: newCalColor } });
      loadCals(); toast.info('Calendario creato');
      setShowNewCal(false); setNewCalName(''); setNewCalColor('#2563eb');
    } catch (err) { toast.error(err.message); }
  };

  return (
    <div className="cal-layout">
      {/* Sidebar calendari */}
      <aside className="cal-sidebar">
        <button className="btn btn-primary cal-new-btn" onClick={() => openNew(today)}><Plus size={15}/> Nuovo evento</button>
        <div className="cal-sidebar-section">
          <div className="cal-sidebar-head">
            <span>Calendari</span>
            <button className="icon-btn-sm" title="Nuovo calendario" onClick={() => setShowNewCal(s => !s)}><Plus size={14}/></button>
          </div>
          {showNewCal && (
            <div className="cal-new-form">
              <input className="input" autoFocus placeholder="Nome" value={newCalName} onChange={e => setNewCalName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createCal()} />
              <div className="cal-color-row">
                {['#2563eb','#16a34a','#dc2626','#9333ea','#ea580c','#0891b2','#65a30d','#be185d'].map(c => (
                  <button key={c} className={`cal-color-dot${newCalColor === c ? ' selected' : ''}`} style={{ background: c }} onClick={() => setNewCalColor(c)} />
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-primary btn-sm" onClick={createCal}>Crea</button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setShowNewCal(false); setNewCalName(''); }}>Annulla</button>
              </div>
            </div>
          )}
          {calendars.map(cal => (
            <label key={cal.id} className="cal-toggle-row">
              <span className="cal-dot" style={{ background: cal.color }} />
              <span className="cal-toggle-name">{cal.name}</span>
              <input type="checkbox" checked={!hiddenCals.has(cal.id)} onChange={() => toggleCal(cal.id)} />
            </label>
          ))}
        </div>
      </aside>

      {/* Area principale */}
      <div className="cal-main">
        <div className="cal-topbar">
          <div className="cal-nav">
            <button className="btn btn-ghost" onClick={() => setCursor(view === 'month' ? new Date(today.getFullYear(), today.getMonth(), 1) : new Date(today))}>Oggi</button>
            <button className="btn btn-ghost icon-btn" onClick={() => nav(-1)}><ChevronLeft size={18}/></button>
            <button className="btn btn-ghost icon-btn" onClick={() => nav(1)}><ChevronRight size={18}/></button>
          </div>
          <h2 className="cal-title">{title}</h2>
          <div className="seg">
            {['month','week','day'].map(v => (
              <button key={v} className={`seg-btn${view === v ? ' active' : ''}`} onClick={() => { setView(v); if (v === 'week') { const d = new Date(today); d.setDate(d.getDate() - d.getDay()); setCursor(d); } else setCursor(new Date(today.getFullYear(), today.getMonth(), 1)); }}>
                {v === 'month' ? 'Mese' : v === 'week' ? 'Settimana' : 'Giorno'}
              </button>
            ))}
          </div>
        </div>

        <div className="cal-body">
          {view === 'month' && <MonthView cursor={cursor} today={today} events={visibleEvents} onDayClick={openNew} onEventClick={openEdit} />}
          {view === 'week' && <WeekView cursor={cursor} today={today} events={visibleEvents} onSlotClick={openNew} onEventClick={openEdit} />}
          {view === 'day'  && <DayView  cursor={cursor} today={today} events={visibleEvents} onSlotClick={openNew} onEventClick={openEdit} />}
        </div>
      </div>

      {editing !== null && (
        <EventModal
          event={editing?.id ? editing : null}
          calendars={calendars}
          defaultDate={defaultDate}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

// ── Month view ────────────────────────────────────────────────────────────
function MonthView({ cursor, today, events, onDayClick, onEventClick }) {
  const year = cursor.getFullYear(), month = cursor.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  const evForDay = (d) => {
    if (!d) return [];
    return events.filter(e => {
      const s = new Date(e.startAt); const end = new Date(e.endAt);
      const dayStart = new Date(d); dayStart.setHours(0,0,0,0);
      const dayEnd = new Date(d); dayEnd.setHours(23,59,59);
      return s <= dayEnd && end >= dayStart;
    });
  };

  const isToday = (d) => d && d.toDateString() === today.toDateString();

  return (
    <div className="month-grid">
      {DAYS.map(d => <div key={d} className="month-dow">{d}</div>)}
      {cells.map((d, i) => (
        <div key={i} className={`month-cell${!d ? ' empty' : ''}${isToday(d) ? ' today' : ''}`} onClick={() => d && onDayClick(d)}>
          {d && <span className="month-day-num">{d.getDate()}</span>}
          {evForDay(d).slice(0, 3).map(ev => (
            <button key={ev.id} className="month-event" style={{ background: ev.calendar?.color || '#2563eb' }}
              onClick={e => { e.stopPropagation(); onEventClick(ev); }}>
              {ev.title}
            </button>
          ))}
          {evForDay(d).length > 3 && <span className="month-more">+{evForDay(d).length - 3} altri</span>}
        </div>
      ))}
    </div>
  );
}

// ── Week view ─────────────────────────────────────────────────────────────
function WeekView({ cursor, today, events, onSlotClick, onEventClick }) {
  const weekDays = [];
  for (let i = 0; i < 7; i++) { const d = new Date(cursor); d.setDate(cursor.getDate() - cursor.getDay() + i); weekDays.push(d); }

  const isToday = (d) => d.toDateString() === today.toDateString();
  const evForDay = (d) => events.filter(e => new Date(e.startAt).toDateString() === d.toDateString());

  return (
    <div className="week-grid">
      <div className="week-time-col"><div className="week-corner" /></div>
      {weekDays.map((d, i) => (
        <div key={i} className={`week-day-head${isToday(d) ? ' today' : ''}`}>
          <span className="week-dow">{DAYS[d.getDay()]}</span>
          <span className={`week-day-num${isToday(d) ? ' today' : ''}`}>{d.getDate()}</span>
        </div>
      ))}
      {HOURS.map(h => (
        <>
          <div key={`t${h}`} className="week-time-cell">{h > 0 && `${pad(h)}:00`}</div>
          {weekDays.map((d, di) => (
            <div key={`${h}-${di}`} className="week-slot" onClick={() => { const dt = new Date(d); dt.setHours(h, 0, 0, 0); onSlotClick(dt); }}>
              {evForDay(d).filter(e => new Date(e.startAt).getHours() === h).map(ev => (
                <button key={ev.id} className="week-event" style={{ background: ev.calendar?.color || '#2563eb' }}
                  onClick={e => { e.stopPropagation(); onEventClick(ev); }}>
                  {new Date(ev.startAt).getHours()}:{pad(new Date(ev.startAt).getMinutes())} {ev.title}
                </button>
              ))}
            </div>
          ))}
        </>
      ))}
    </div>
  );
}

// ── Day view ──────────────────────────────────────────────────────────────
function DayView({ cursor, today, events, onSlotClick, onEventClick }) {
  const isToday = cursor.toDateString() === today.toDateString();
  const dayEvents = events.filter(e => new Date(e.startAt).toDateString() === cursor.toDateString());

  return (
    <div className="day-grid">
      <div className={`day-grid-head${isToday ? ' today' : ''}`}>
        <span className="week-dow">{DAYS[cursor.getDay()]}</span>
        <span className={`week-day-num lg${isToday ? ' today' : ''}`}>{cursor.getDate()}</span>
      </div>
      <div className="day-scroll">
        {HOURS.map(h => (
          <div key={h} className="day-hour-row" onClick={() => { const dt = new Date(cursor); dt.setHours(h, 0, 0, 0); onSlotClick(dt); }}>
            <div className="day-hour-label">{pad(h)}:00</div>
            <div className="day-hour-events">
              {dayEvents.filter(e => new Date(e.startAt).getHours() === h).map(ev => (
                <button key={ev.id} className="day-event" style={{ borderLeftColor: ev.calendar?.color || '#2563eb' }}
                  onClick={e => { e.stopPropagation(); onEventClick(ev); }}>
                  <span className="day-event-time">{new Date(ev.startAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="day-event-title">{ev.title}</span>
                  {ev.location && <span className="day-event-loc"><MapPin size={11}/> {ev.location}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
