import { useEffect, useState } from 'react';
import { Plus, Trash2, Pause, Play, Zap, ChevronDown } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';

const TRIGGER_LABELS = {
  WA_MESSAGE_RECEIVED: 'Messaggio WhatsApp ricevuto',
  WA_FILE_RECEIVED: 'File / immagine WhatsApp ricevuta',
  WA_AUDIO_RECEIVED: 'Audio WhatsApp ricevuto',
  WIDGET_MESSAGE_RECEIVED: 'Messaggio widget (sito web)',
};

const TRIGGER_DESC = {
  WA_MESSAGE_RECEIVED: 'Scatta ogni volta che un contatto invia un messaggio testuale su WhatsApp.',
  WA_FILE_RECEIVED: 'Scatta quando arriva un documento, immagine o video su WhatsApp.',
  WA_AUDIO_RECEIVED: 'Scatta quando arriva un messaggio vocale su WhatsApp.',
  WIDGET_MESSAGE_RECEIVED: 'Scatta quando un visitatore scrive nella chat embed sul sito.',
};

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function FlowModal({ onClose, onSaved, triggers }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', trigger: triggers[0] || '', instruction: '', description: '' });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form.name.trim() || !form.instruction.trim()) return toast.error('Nome e istruzione sono obbligatori');
    setSaving(true);
    try {
      const { flow } = await api('/flows', { method: 'POST', body: form });
      onSaved(flow);
      onClose();
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Nuovo flusso</h2>
        <p className="page-subtitle" style={{ marginTop: -8, marginBottom: 16 }}>
          Un flusso si attiva automaticamente quando si verifica un evento specifico ed esegue l'istruzione AI configurata.
        </p>

        <div className="field">
          <label>Nome flusso</label>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Es. Rispondi ai file ricevuti" />
        </div>

        <div className="field">
          <label>Evento trigger</label>
          <select className="input" value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })}>
            {triggers.map((t) => (
              <option key={t} value={t}>{TRIGGER_LABELS[t] || t}</option>
            ))}
          </select>
          {form.trigger && <span className="field-hint">{TRIGGER_DESC[form.trigger]}</span>}
        </div>

        <div className="field">
          <label>Descrizione (opzionale)</label>
          <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Breve descrizione dello scopo" />
        </div>

        <div className="field">
          <label>Istruzione AI</label>
          <span className="field-hint">
            Scrivi cosa deve fare l'AI quando l'evento scatta. Il contesto dell'evento (mittente, tipo, contenuto) viene passato automaticamente.
          </span>
          <textarea className="input" rows={5} value={form.instruction}
            onChange={(e) => setForm({ ...form, instruction: e.target.value })}
            placeholder={'Es. Quando ricevi un file da un contatto, rispondi ringraziando e confermando che lo hai ricevuto. Se il file è un documento PDF, invia una conferma specificando il nome del file.'} />
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Salvataggio…' : 'Crea flusso'}</button>
        </div>
      </div>
    </div>
  );
}

export default function Flows() {
  const toast = useToast();
  const modal = useModal();
  const [flows, setFlows] = useState(null);
  const [triggers, setTriggers] = useState([]);
  const [showModal, setShowModal] = useState(false);

  const load = async () => {
    try {
      const { flows, triggers } = await api('/flows');
      setFlows(flows);
      setTriggers(triggers || []);
    } catch { setFlows([]); }
  };

  useEffect(() => { load(); }, []);

  const toggle = async (flow) => {
    try {
      const newStatus = flow.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
      await api(`/flows/${flow.id}`, { method: 'PATCH', body: { status: newStatus } });
      load();
    } catch (err) { toast.error(err.message); }
  };

  const remove = async (flow) => {
    const ok = await modal.confirm(`Eliminare il flusso "${flow.name}"?`, { danger: true });
    if (!ok) return;
    try {
      await api(`/flows/${flow.id}`, { method: 'DELETE' });
      setFlows((f) => f.filter((x) => x.id !== flow.id));
      toast.info('Flusso eliminato');
    } catch (err) { toast.error(err.message); }
  };

  if (!flows) return <div className="skeleton" style={{ height: 300 }} />;

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">Flussi</h1>
          <p className="page-subtitle">
            Automatizzazioni globali che si attivano su eventi WhatsApp o widget. Puoi crearli anche direttamente in chat dicendo ad esempio "quando qualcuno mi manda un file su WhatsApp fai questa cosa".
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          <Plus size={16} /> Nuovo flusso
        </button>
      </div>

      {flows.length === 0 && (
        <div className="card" style={{ padding: 40, textAlign: 'center', marginTop: 24 }}>
          <Zap size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
          <p style={{ fontWeight: 600, marginBottom: 6 }}>Nessun flusso configurato</p>
          <p className="page-subtitle">Crea il tuo primo flusso per automatizzare risposte o azioni su eventi in ingresso.</p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowModal(true)}>
            <Plus size={15} /> Crea flusso
          </button>
        </div>
      )}

      <div className="flows-list">
        {flows.map((flow) => (
          <div key={flow.id} className={`flow-card card ${flow.status === 'PAUSED' ? 'flow-paused' : ''}`}>
            <div className="flow-header">
              <div className="flow-title-row">
                <Zap size={15} className="flow-icon" />
                <span className="flow-name">{flow.name}</span>
                <span className={`badge ${flow.status === 'ACTIVE' ? 'badge-on' : 'badge-off'}`}>
                  {flow.status === 'ACTIVE' ? 'Attivo' : 'In pausa'}
                </span>
              </div>
              <div className="flow-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => toggle(flow)} title={flow.status === 'ACTIVE' ? 'Metti in pausa' : 'Riattiva'}>
                  {flow.status === 'ACTIVE' ? <Pause size={13} /> : <Play size={13} />}
                  {flow.status === 'ACTIVE' ? 'Pausa' : 'Riattiva'}
                </button>
                <button className="btn btn-danger icon-btn" onClick={() => remove(flow)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            <div className="flow-trigger">
              <Zap size={11} />
              <span>{TRIGGER_LABELS[flow.trigger] || flow.trigger}</span>
            </div>

            {flow.description && <p className="flow-desc">{flow.description}</p>}

            <details className="flow-instruction-details">
              <summary>
                <ChevronDown size={12} /> Istruzione AI
              </summary>
              <pre className="flow-instruction">{flow.instruction}</pre>
            </details>

            <div className="flow-meta">
              {flow.runCount > 0 && <span>Eseguito {flow.runCount} {flow.runCount === 1 ? 'volta' : 'volte'}</span>}
              {flow.lastRunAt && <span>· Ultima esecuzione: {formatDate(flow.lastRunAt)}</span>}
            </div>
          </div>
        ))}
      </div>

      {showModal && (
        <FlowModal
          onClose={() => setShowModal(false)}
          onSaved={(flow) => { setFlows((f) => [flow, ...f]); toast.info(`Flusso "${flow.name}" creato`); }}
          triggers={triggers}
        />
      )}
    </div>
  );
}
