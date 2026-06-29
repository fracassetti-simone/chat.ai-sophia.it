import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Check, Save, Upload, Trash2, FileText,
  Loader2, User, MessageSquare, BookOpen, Puzzle, FlaskConical, Rocket, Settings,
  Plus, Bot, Pencil, X, Clock, RotateCcw, ChevronDown, ChevronUp, Star,
} from 'lucide-react';
import { api, upload } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const STEPS = [
  { id: 'identity',  label: 'Identità',      icon: User,          desc: 'Chi è il tuo assistente?' },
  { id: 'tone',      label: 'Tono',           icon: MessageSquare, desc: 'Come comunica?' },
  { id: 'rules',     label: 'Regole',         icon: Settings,      desc: 'Cosa non deve mai fare?' },
  { id: 'knowledge', label: 'Conoscenza',     icon: BookOpen,      desc: "Cosa sa dell'azienda?" },
  { id: 'documents', label: 'Documenti',      icon: FileText,      desc: 'Manuali e file di supporto' },
  { id: 'channels',  label: 'Canali',         icon: Puzzle,        desc: 'Dove opera?' },
  { id: 'test',      label: 'Test',           icon: FlaskConical,  desc: 'Prova la configurazione' },
  { id: 'publish',   label: 'Pubblica',       icon: Rocket,        desc: 'Salva e attiva' },
];

function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function fmtDate(d) {
  return new Date(d).toLocaleString('it-IT', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ── Step Identity ─────────────────────────────────────────────────────────────
function StepIdentity({ form, setForm }) {
  return (
    <div className="wizard-fields">
      <div className="field">
        <label>Ruolo e scopo dell'assistente</label>
        <span className="field-hint">Descrive chi è e cosa fa. Questo è il fondamento di tutto il comportamento.</span>
        <textarea className="input" rows={5} value={form.mainPrompt || ''} onChange={e => setForm(f => ({ ...f, mainPrompt: e.target.value }))}
          placeholder="Sei Sophia, assistente virtuale di PHI Informatica. Il tuo compito principale è rispondere alle domande dei clienti." />
      </div>
    </div>
  );
}

function StepTone({ form, setForm }) {
  return (
    <div className="wizard-fields">
      <div className="field">
        <label>Personalità e tono di voce</label>
        <span className="field-hint">Come si esprime, quanto è formale, che emozioni trasmette.</span>
        <textarea className="input" rows={4} value={form.personality || ''} onChange={e => setForm(f => ({ ...f, personality: e.target.value }))}
          placeholder="Parla in modo cordiale e professionale. Usa un tono empatico ma efficiente. Usa il lei." />
      </div>
      <div className="field">
        <label>Istruzioni permanenti</label>
        <span className="field-hint">Comportamenti sempre attivi, indipendentemente dalla domanda.</span>
        <textarea className="input" rows={3} value={form.instructions || ''} onChange={e => setForm(f => ({ ...f, instructions: e.target.value }))}
          placeholder="Rispondi sempre in italiano. Non menzionare mai competitor." />
      </div>
    </div>
  );
}

function StepRules({ form, setForm }) {
  return (
    <div className="wizard-fields">
      <div className="field">
        <label>Regole e vincoli</label>
        <span className="field-hint">Cosa non deve mai fare o dire. Limiti di argomento o comportamento.</span>
        <textarea className="input" rows={5} value={form.rules || ''} onChange={e => setForm(f => ({ ...f, rules: e.target.value }))}
          placeholder="Non fornire informazioni sui prezzi senza aver verificato la disponibilità." />
      </div>
    </div>
  );
}

function StepKnowledge({ form, setForm }) {
  return (
    <div className="wizard-fields">
      <div className="field">
        <label>Contesto aziendale</label>
        <span className="field-hint">Informazioni sull'azienda, i prodotti, i servizi, gli orari.</span>
        <textarea className="input" rows={8} value={form.context || ''} onChange={e => setForm(f => ({ ...f, context: e.target.value }))}
          placeholder="Acme Srl è specializzata in soluzioni B2B per la logistica. Sede: Milano, via Roma 12." />
      </div>
    </div>
  );
}

function StepDocuments({ trainingDocs, setTrainingDocs, geminiEnabled }) {
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef();

  const uploadDoc = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true);
    try {
      const { document } = await upload('/training-docs', file);
      setTrainingDocs(d => [document, ...d]);
      toast.info(`"${file.name}" caricato`);
    } catch (err) { toast.error(err.message); } finally { setUploading(false); e.target.value = ''; }
  };

  const deleteDoc = async (id) => {
    try {
      await api(`/training-docs/${id}`, { method: 'DELETE' });
      setTrainingDocs(d => d.filter(doc => doc.id !== id));
      toast.info('Documento eliminato');
    } catch (err) { toast.error(err.message); }
  };

  return (
    <div className="wizard-fields">
      {!geminiEnabled && (
        <div className="notice" style={{ marginBottom: 16 }}>
          Il caricamento di manuali richiede il modulo <strong>Gemini AI</strong> attivo nella sezione Moduli.
        </div>
      )}
      <button className="btn btn-outline" style={{ opacity: geminiEnabled ? 1 : 0.5 }}
        onClick={() => geminiEnabled && fileRef.current?.click()} disabled={uploading}>
        {uploading ? <><Loader2 size={15} className="spin"/> Caricamento…</> : <><Upload size={15}/> Carica documento</>}
      </button>
      <input ref={fileRef} type="file" hidden accept=".pdf,.docx,.txt,.md" onChange={uploadDoc}/>
      {trainingDocs.length > 0 && (
        <div className="training-docs-list" style={{ marginTop: 16 }}>
          {trainingDocs.map(doc => (
            <div key={doc.id} className="training-doc-item">
              <FileText size={16} style={{ color: 'var(--primary)', flexShrink: 0 }}/>
              <span className="training-doc-name">{doc.filename}</span>
              <span className="training-doc-size">{fmtBytes(doc.sizeBytes)}</span>
              <button className="btn btn-danger icon-btn" onClick={() => deleteDoc(doc.id)}><Trash2 size={14}/></button>
            </div>
          ))}
        </div>
      )}
      {!trainingDocs.length && <p className="empty small" style={{ marginTop: 16 }}>Nessun documento caricato.</p>}
    </div>
  );
}

function StepChannels({ modules }) {
  return (
    <div className="wizard-fields">
      <p className="page-subtitle">I canali e i moduli attivi determinano cosa può fare l'assistente. Gestiscili dalla sezione <strong>Moduli</strong>.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
        {(modules || []).map(m => (
          <div key={m.key} className={`wizard-module-chip${m.enabled && m.installed ? ' active' : ''}`}>
            <span className={`badge ${m.enabled && m.installed ? 'badge-on' : 'badge-off'}`} style={{ fontSize: 10 }}/>
            {m.name}
          </div>
        ))}
      </div>
    </div>
  );
}

function StepTest({ agentId, form }) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim(); setInput(''); setLoading(true);
    setMessages(m => [...m, { role: 'user', content: userMsg }]);
    try {
      const draft = { mainPrompt: form.mainPrompt, personality: form.personality, rules: form.rules, context: form.context, instructions: form.instructions };
      let res;
      if (agentId) {
        res = await api(`/agents/${agentId}/test`, { method: 'POST', body: { message: userMsg, draft } });
      } else {
        res = await api('/training/test', { method: 'POST', body: { message: userMsg, draft } });
      }
      setMessages(m => [...m, { role: 'assistant', content: res.answer }]);
    } catch (err) {
      setMessages(m => [...m, { role: 'assistant', content: `Errore: ${err.message}` }]);
    } finally { setLoading(false); }
  };

  return (
    <div className="wizard-fields">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 200, maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 8 }}>
        {!messages.length && <p className="empty small" style={{ margin: 'auto' }}>Invia un messaggio per testare l'agente con la configurazione corrente (non salvata).</p>}
        {messages.map((m, i) => (
          <div key={i} className={`wizard-test-msg wizard-test-msg-${m.role}`}>
            <strong>{m.role === 'user' ? 'Tu' : 'Agente'}</strong>
            <div>{m.content}</div>
          </div>
        ))}
        {loading && <div className="wizard-test-msg wizard-test-msg-ai"><strong>Agente</strong><div className="typing"><span/><span/><span/></div></div>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input className="input" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="Scrivi un messaggio di test…"/>
        <button className="btn btn-primary" onClick={send} disabled={loading || !input.trim()}>Invia</button>
      </div>
    </div>
  );
}

// ── Step Pubblica + Versioning ────────────────────────────────────────────────
function StepPublish({ onSave, saving, saved, versions, onRestore, onSaveWithNote }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const modal = useModal();

  const handleRestore = async (v) => {
    const ok = await modal.confirm(
      `Ripristinare la versione del ${fmtDate(v.createdAt)}${v.note ? ` ("${v.note}")` : ''}? Le modifiche non salvate andranno perse.`,
    );
    if (ok) onRestore(v);
  };

  return (
    <div className="wizard-fields">
      <div style={{ textAlign: 'center', padding: '16px 0 24px' }}>
        {saved
          ? <>
              <div className="wizard-done-icon"><Check size={32}/></div>
              <h3 style={{ marginTop: 16, fontSize: 20, fontWeight: 700 }}>Configurazione salvata</h3>
              <p className="page-subtitle" style={{ marginTop: 8 }}>L'agente è aggiornato su tutti i canali.</p>
            </>
          : <>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
                <Rocket size={44} strokeWidth={1.4} style={{ color: 'var(--primary)' }}/>
              </div>
              <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Pronto a pubblicare?</h3>
              <p className="page-subtitle">Salva la configurazione per applicare tutte le modifiche all'agente.</p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 20, flexWrap: 'wrap' }}>
                <button className="btn btn-primary" style={{ padding: '12px 32px', fontSize: 15 }} onClick={onSave} disabled={saving}>
                  {saving ? <><Loader2 size={16} className="spin"/> Salvo…</> : <><Save size={16}/> Salva e attiva</>}
                </button>
                <button className="btn btn-outline" onClick={() => setNoteOpen(v => !v)}>
                  <Pencil size={14}/> Salva con nota
                </button>
              </div>
              {noteOpen && (
                <div style={{ marginTop: 16, display: 'flex', gap: 8, maxWidth: 480, margin: '16px auto 0' }}>
                  <input className="input" value={note} onChange={e => setNote(e.target.value)}
                    placeholder="Es. Aggiornato regole GDPR, corretto tono…" style={{ flex: 1 }}/>
                  <button className="btn btn-primary" onClick={() => { onSaveWithNote(note); setNote(''); setNoteOpen(false); }} disabled={saving}>
                    <Save size={14}/>
                  </button>
                </div>
              )}
            </>
        }
      </div>

      {/* Versioning */}
      {versions?.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 20 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Clock size={14}/> Cronologia versioni ({versions.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {versions.map((v, i) => (
              <div key={v.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                background: i === 0 ? 'var(--primary-10, #eff6ff)' : 'var(--gray-50)',
                borderRadius: 8, border: `1px solid ${i === 0 ? 'var(--primary-200, #bfdbfe)' : 'var(--border)'}`,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: i === 0 ? 600 : 400, color: 'var(--text)' }}>
                    {i === 0 && <span style={{ color: 'var(--primary)', marginRight: 6 }}>● Attuale</span>}
                    {fmtDate(v.createdAt)}
                  </div>
                  {v.note && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, fontStyle: 'italic' }}>
                      "{v.note}"
                    </div>
                  )}
                </div>
                {i > 0 && (
                  <button className="btn btn-outline btn-sm" onClick={() => handleRestore(v)}>
                    <RotateCcw size={12}/> Ripristina
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Modale creazione/modifica agente ─────────────────────────────────────────
const AVATARS = ['🤖', '👩', '👨', '🧑', '💼', '🎯', '📞', '🛒', '🏥', '⚖️', '🔧', '📋'];

function AgentModal({ agent, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: agent?.name || '',
    description: agent?.description || '',
    avatar: agent?.avatar || '🤖',
    isDefault: agent?.isDefault || false,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) return toast.error('Nome obbligatorio');
    setSaving(true);
    try {
      if (agent) {
        await api(`/agents/${agent.id}/meta`, { method: 'PATCH', body: form });
        toast.info('Agente aggiornato');
      } else {
        await api('/agents', { method: 'POST', body: form });
        toast.info('Agente creato');
      }
      onSaved();
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head-row">
          <h2 className="modal-title" style={{ margin: 0 }}>{agent ? 'Modifica agente' : 'Nuovo agente'}</h2>
          <button className="btn btn-ghost icon-btn" onClick={onClose}><X size={18}/></button>
        </div>

        <div className="field">
          <label>Avatar</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {AVATARS.map(a => (
              <button key={a} type="button"
                style={{
                  fontSize: 22, width: 40, height: 40, borderRadius: 8, cursor: 'pointer',
                  border: `2px solid ${form.avatar === a ? 'var(--primary)' : 'var(--border)'}`,
                  background: form.avatar === a ? 'var(--primary-10, #eff6ff)' : 'transparent',
                }}
                onClick={() => set('avatar', a)}>{a}</button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Nome <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input className="input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Es. Assistente Vendite" />
        </div>

        <div className="field">
          <label>Descrizione <span className="field-hint">— nota interna</span></label>
          <input className="input" value={form.description} onChange={e => set('description', e.target.value)} placeholder="Es. Gestisce le richieste commerciali" />
        </div>

        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 400 }}>
            <input type="checkbox" checked={form.isDefault} onChange={e => set('isDefault', e.target.checked)} />
            Agente predefinito <span className="field-hint">— risponde di default se non ne è assegnato un altro</span>
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

// ── Wizard per agente singolo ─────────────────────────────────────────────────
function AgentWizard({ agent, onBack, onAgentSaved }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    mainPrompt: agent.mainPrompt || '', personality: agent.personality || '',
    rules: agent.rules || '', context: agent.context || '', instructions: agent.instructions || '',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [versions, setVersions] = useState([]);
  const [geminiEnabled, setGeminiEnabled] = useState(false);
  const [trainingDocs, setTrainingDocs] = useState([]);
  const [modules, setModules] = useState([]);

  const loadVersions = useCallback(async () => {
    try { const r = await api(`/agents/${agent.id}/versions`); setVersions(r.versions || []); } catch {}
  }, [agent.id]);

  useEffect(() => {
    loadVersions();
    api('/modules').then(({ modules: m }) => {
      setModules(m);
      setGeminiEnabled(!!(m.find(x => x.key === 'gemini')?.enabled && m.find(x => x.key === 'gemini')?.installed));
    }).catch(() => {});
    api('/training-docs').then(({ documents }) => setTrainingDocs(documents)).catch(() => {});
  }, [loadVersions]);

  const saveWithNote = async (note) => {
    setSaving(true); setSaved(false);
    try {
      await api(`/agents/${agent.id}`, { method: 'PUT', body: { ...form, note: note || null } });
      toast.info('Configurazione salvata');
      setSaved(true);
      loadVersions();
      onAgentSaved?.();
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  const restore = async (v) => {
    try {
      const { agent: updated } = await api(`/agents/${agent.id}/versions/${v.id}/restore`, { method: 'POST', body: {} });
      setForm({
        mainPrompt: updated.mainPrompt, personality: updated.personality,
        rules: updated.rules, context: updated.context, instructions: updated.instructions,
      });
      toast.info('Versione ripristinata');
      setSaved(false);
      loadVersions();
    } catch (err) { toast.error(err.message); }
  };

  const stepContent = () => {
    switch (STEPS[step].id) {
      case 'identity':  return <StepIdentity form={form} setForm={setForm}/>;
      case 'tone':      return <StepTone form={form} setForm={setForm}/>;
      case 'rules':     return <StepRules form={form} setForm={setForm}/>;
      case 'knowledge': return <StepKnowledge form={form} setForm={setForm}/>;
      case 'documents': return <StepDocuments trainingDocs={trainingDocs} setTrainingDocs={setTrainingDocs} geminiEnabled={geminiEnabled}/>;
      case 'channels':  return <StepChannels modules={modules}/>;
      case 'test':      return <StepTest agentId={agent.id} form={form}/>;
      case 'publish':   return <StepPublish onSave={() => saveWithNote(null)} saving={saving} saved={saved} versions={versions} onRestore={restore} onSaveWithNote={saveWithNote}/>;
      default:          return null;
    }
  };

  return (
    <div className="wizard-layout">
      <aside className="wizard-sidebar">
        <button className="btn btn-ghost btn-sm" style={{ marginBottom: 12, justifyContent: 'flex-start' }} onClick={onBack}>
          <ChevronLeft size={14}/> Tutti gli agenti
        </button>
        <div className="wizard-sidebar-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 20 }}>{agent.avatar || '🤖'}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</span>
          {agent.isDefault && <Star size={12} style={{ color: 'var(--primary)', flexShrink: 0 }}/>}
        </div>
        {STEPS.map((s, i) => (
          <button key={s.id} className={`wizard-step-btn${i === step ? ' active' : ''}${i < step ? ' done' : ''}`} onClick={() => setStep(i)}>
            <span className="wizard-step-num">
              {i < step ? <Check size={14}/> : <s.icon size={14}/>}
            </span>
            <span className="wizard-step-info">
              <span className="wizard-step-label">{s.label}</span>
              <span className="wizard-step-desc">{s.desc}</span>
            </span>
          </button>
        ))}
      </aside>

      <div className="wizard-content">
        <div className="wizard-header">
          <div>
            <h1 className="wizard-title">{STEPS[step].label}</h1>
            <p className="page-subtitle">{STEPS[step].desc}</p>
          </div>
          <button className="btn btn-outline" onClick={() => saveWithNote(null)} disabled={saving}>
            <Save size={15}/> {saving ? 'Salvo…' : 'Salva'}
          </button>
        </div>
        <div className="wizard-body card">{stepContent()}</div>
        <div className="wizard-nav">
          <button className="btn btn-ghost" onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0}>
            <ChevronLeft size={16}/> Indietro
          </button>
          <span className="wizard-progress">{step + 1} di {STEPS.length}</span>
          <button className="btn btn-primary" onClick={() => { if (step === STEPS.length - 1) saveWithNote(null); else setStep(s => Math.min(STEPS.length - 1, s + 1)); }}>
            {step === STEPS.length - 1 ? <><Save size={15}/> Salva</> : <>Avanti <ChevronRight size={16}/></>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Lista agenti ──────────────────────────────────────────────────────────────
export default function Training() {
  const toast = useToast();
  const modal = useModal();
  const { user } = useAuth();

  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';

  const [agents, setAgents]       = useState(null);
  const [selectedAgent, setSelected] = useState(null);
  const [showNewAgent, setShowNew] = useState(false);
  const [editAgent, setEditAgent] = useState(null);

  const loadAgents = useCallback(async () => {
    try { const { agents: list } = await api('/agents'); setAgents(list); }
    catch { setAgents([]); }
  }, []);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  // Realtime
  useEffect(() => {
    const onCreated = (e) => { const { agent } = e.detail || {}; if (agent) setAgents(p => p ? [...p, agent] : [agent]); };
    const onUpdated = (e) => { const { agent } = e.detail || {}; if (agent) setAgents(p => p ? p.map(a => a.id === agent.id ? { ...a, ...agent } : a) : []); };
    const onDeleted = (e) => { const { id } = e.detail || {}; if (id) setAgents(p => p ? p.filter(a => a.id !== id) : []); };
    window.addEventListener('sophia:agent:created', onCreated);
    window.addEventListener('sophia:agent:updated', onUpdated);
    window.addEventListener('sophia:agent:deleted', onDeleted);
    return () => {
      window.removeEventListener('sophia:agent:created', onCreated);
      window.removeEventListener('sophia:agent:updated', onUpdated);
      window.removeEventListener('sophia:agent:deleted', onDeleted);
    };
  }, []);

  const deleteAgent = async (agent) => {
    if (agent.isDefault) return toast.error('Non puoi eliminare l\'agente predefinito. Imposta prima un altro agente come predefinito.');
    const ok = await modal.confirm(`Eliminare l'agente "${agent.name}"? Questa azione non è reversibile.`, { danger: true });
    if (!ok) return;
    try {
      await api(`/agents/${agent.id}`, { method: 'DELETE' });
      toast.info(`Agente "${agent.name}" eliminato`);
      setAgents(p => p.filter(a => a.id !== agent.id));
    } catch (err) { toast.error(err.message); }
  };

  // Se c'è un agente selezionato, mostra il wizard
  if (selectedAgent) {
    // Ricarica agente aggiornato dalla lista (per avere dati freschi)
    const fresh = agents?.find(a => a.id === selectedAgent.id) || selectedAgent;
    return (
      <AgentWizard
        agent={fresh}
        onBack={() => setSelected(null)}
        onAgentSaved={loadAgents}
      />
    );
  }

  if (!agents) return <div className="skeleton" style={{ height: 300 }}/>;

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">Addestramento</h1>
          <p className="page-subtitle">Configura i tuoi agenti AI. Ogni agente ha il proprio addestramento e versioning indipendente.</p>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            <Plus size={16}/> Nuovo agente
          </button>
        )}
      </div>

      {agents.length === 0 ? (
        <div className="card empty-state" style={{ marginTop: 24 }}>
          <div className="empty-icon"><Bot size={24} strokeWidth={1.75}/></div>
          <h3>Nessun agente configurato</h3>
          <p>Crea il tuo primo agente AI e addestralo con personalità, regole e conoscenze specifiche.</p>
          {isAdmin && (
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowNew(true)}>
              <Plus size={16}/> Crea il primo agente
            </button>
          )}
        </div>
      ) : (
        <div className="flows-list" style={{ marginTop: 24 }}>
          {agents.map(agent => (
            <div key={agent.id} className="flow-card card" style={{ cursor: 'pointer' }} onClick={() => setSelected(agent)}>
              <div className="flow-header">
                <div className="flow-title-row">
                  <span style={{ fontSize: 22, lineHeight: 1 }}>{agent.avatar || '🤖'}</span>
                  <span className="flow-name">{agent.name}</span>
                  {agent.isDefault && (
                    <span className="badge badge-on" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Star size={10}/> Predefinito
                    </span>
                  )}
                  {agent.description && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{agent.description}</span>
                  )}
                </div>
                {isAdmin && (
                  <div className="flow-actions" onClick={e => e.stopPropagation()}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditAgent(agent)}>
                      <Pencil size={13}/> Meta
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={() => setSelected(agent)}>
                      <Settings size={13}/> Configura
                    </button>
                    {!agent.isDefault && (
                      <button className="btn btn-danger icon-btn" onClick={() => deleteAgent(agent)}>
                        <Trash2 size={13}/>
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="flow-meta" style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                Aggiornato: {fmtDate(agent.updatedAt || agent.createdAt)}
              </div>
            </div>
          ))}
        </div>
      )}

      {showNewAgent && (
        <AgentModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); loadAgents(); }}/>
      )}
      {editAgent && (
        <AgentModal agent={editAgent} onClose={() => setEditAgent(null)} onSaved={() => { setEditAgent(null); loadAgents(); }}/>
      )}
    </div>
  );
}
