import { useEffect, useState } from 'react';
import {
  Power, Settings2, Plus, Trash2, AlertTriangle, Check, Loader2,
  ChevronRight, ChevronLeft, ChevronDown, Link, Globe, MessageSquare, Copy, ExternalLink, Phone, Mail,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';

export default function Modules() {
  const toast = useToast();
  const { user } = useAuth();
  const isSuper = user?.role === 'SUPER_ADMIN';
  const [modules, setModules] = useState(null);
  const [configFor, setConfigFor] = useState(null);
  const [expanded, setExpanded] = useState({}); // per super admin: mostra cap-chip espanse

  const load = () =>
    api('/modules').then(({ modules }) => setModules(modules)).catch(() => setModules([]));
  useEffect(() => { load(); }, []);

  const act = async (key, action) => {
    if (!isSuper) return;
    await api(`/modules/${key}/action`, { method: 'POST', body: { action } });
    load();
    toast.info('Modulo aggiornato');
  };

  const toggleExpand = (key) => setExpanded(e => ({ ...e, [key]: !e[key] }));

  if (!modules) return <div className="skeleton" style={{ height: 300 }} />;

  return (
    <div>
      <h1 className="page-title">Moduli</h1>
      <p className="page-subtitle">
        {isSuper
          ? 'Attiva e configura i moduli per ogni tenant.'
          : 'Funzionalità disponibili per il tuo account. Per attivare moduli aggiuntivi, contattaci.'}
      </p>

      {/* Messaggio commerciale per admin */}
      {!isSuper && (
        <div className="modules-contact-card card">
          <div className="modules-contact-icon">
            <Power size={22} strokeWidth={1.5}/>
          </div>
          <div className="modules-contact-content">
            <h3>Vuoi attivare nuovi moduli?</h3>
            <p>Contatta il nostro team per abilitare funzionalità aggiuntive — siamo sempre disponibili.</p>
            <div className="modules-contact-links">
              <a href="tel:+390355788880" className="modules-contact-btn modules-contact-btn-phone">
                <Phone size={14}/> +39 035 578 8880
              </a>
              <a href="mailto:sophia@phi.it" className="modules-contact-btn modules-contact-btn-email">
                <Mail size={14}/> sophia@phi.it
              </a>
            </div>
          </div>
        </div>
      )}

      <div className="module-grid">
        {modules.map((m) => (
          <div key={m.key} className="card module-card">
            <div className="module-head">
              <div>
                <h3 className="module-name">{m.name}</h3>
                <span className={`badge ${m.enabled && m.installed ? 'badge-on' : 'badge-off'}`}>
                  {m.installed ? (m.enabled ? 'Attivo' : 'Disattivato') : 'Non installato'}
                </span>
              </div>
            </div>
            <p className="module-desc">{m.description}</p>
            {m.notice && (
              <div className="notice"><AlertTriangle size={16} /> {m.notice}</div>
            )}

            {/* Cap-chip: solo super admin, collassabili */}
            {isSuper && m.capabilities?.length > 0 && (
              <div className="module-caps-section">
                <button className="module-caps-toggle" onClick={() => toggleExpand(m.key)}>
                  <ChevronDown size={13} style={{ transform: expanded[m.key] ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}/>
                  {m.capabilities.length} capability
                </button>
                {expanded[m.key] && (
                  <div className="module-caps">
                    {m.capabilities.map((c) => (
                      <span key={c.name} className="cap-chip">{c.name}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="module-actions">
              {isSuper ? (
                m.installed ? (
                  <>
                    <button className="btn btn-outline" onClick={() => act(m.key, m.enabled ? 'disable' : 'enable')}>
                      <Power size={15} /> {m.enabled ? 'Disattiva' : 'Attiva'}
                    </button>
                    {(m.key === 'email' || m.key === 'whatsapp' || m.key === 'gemini') && (
                      <button className="btn btn-ghost" onClick={() => setConfigFor(m)}>
                        <Settings2 size={15} /> Configura
                      </button>
                    )}
                  </>
                ) : (
                  <button className="btn btn-primary" onClick={() => act(m.key, 'install')}>Installa</button>
                )
              ) : null /* admin: nessun pulsante azione */ }
            </div>
          </div>
        ))}
      </div>

      {configFor?.key === 'email' && (
        <EmailConfig module={configFor} onClose={() => { setConfigFor(null); load(); }} />
      )}
      {configFor?.key === 'whatsapp' && (
        <WhatsAppWizard module={configFor} onClose={() => { setConfigFor(null); load(); }} />
      )}
      {configFor?.key === 'gemini' && (
        <GeminiConfig module={configFor} onClose={() => { setConfigFor(null); load(); }} />
      )}
      {configFor?.key === 'database' && (
        <DatabaseConfig module={configFor} onClose={() => { setConfigFor(null); load(); }} />
      )}
    </div>
  );
}

// ── Modal wrapper ──────────────────────────────────────────────────────────

function Modal({ title, children, onClose, wide }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal card"
        style={wide ? { maxWidth: 640 } : {}}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ── WhatsApp Wizard (3 step) ───────────────────────────────────────────────

function WhatsAppWizard({ module, onClose }) {
  const toast = useToast();
  const [step, setStep] = useState(1);

  // Step 1 state
  const [cfg, setCfg] = useState({
    accessToken: '', phoneNumberId: '', businessAccountId: '',
    templateLanguage: 'it', ...module.config,
  });
  const [saving, setSaving] = useState(false);

  // Step 2 state
  const [checking, setChecking] = useState(false);
  const [templateStatus, setTemplateStatus] = useState(null); // null | 'found' | 'missing'
  const [creating, setCreating] = useState(false);

  // Step 3 state
  const [webhookInfo, setWebhookInfo] = useState(null);
  const [loadingWebhook, setLoadingWebhook] = useState(false);

  const STEPS = [
    { label: 'Credenziali' },
    { label: 'Template' },
    { label: 'Webhook' },
  ];

  // ── Step 1: save credentials ────────────────────────────────────────────
  const saveCredentials = async () => {
    if (!cfg.accessToken || !cfg.phoneNumberId || !cfg.businessAccountId) {
      toast.error('Compila tutti i campi per procedere.');
      return;
    }
    setSaving(true);
    try {
      await api('/modules/whatsapp/config', { method: 'PUT', body: { config: cfg } });
      toast.info('Credenziali salvate');
      setStep(2);
      checkTemplate();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Step 2: check/create template ──────────────────────────────────────
  const checkTemplate = async () => {
    setChecking(true);
    setTemplateStatus(null);
    try {
      const { templateReady } = await api('/modules/whatsapp/setup/templates');
      setTemplateStatus(templateReady ? 'found' : 'missing');
    } catch (err) {
      toast.error(err.message);
      setTemplateStatus('missing');
    } finally {
      setChecking(false);
    }
  };

  const createTemplate = async () => {
    setCreating(true);
    try {
      await api('/modules/whatsapp/setup/templates', {
        method: 'POST',
        body: { language: cfg.templateLanguage },
      });
      toast.info('Template creato — in attesa di approvazione Meta (di solito pochi minuti)');
      setTemplateStatus('pending');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setCreating(false);
    }
  };

  // ── Step 3: webhook ─────────────────────────────────────────────────────
  const loadWebhookInfo = async () => {
    setLoadingWebhook(true);
    try {
      const info = await api('/modules/whatsapp/setup/webhook-info');
      setWebhookInfo(info);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoadingWebhook(false);
    }
  };

  const goToStep3 = () => {
    setStep(3);
    loadWebhookInfo();
  };

  const copyText = (text) => {
    navigator.clipboard.writeText(text).then(() => toast.info('Copiato!'));
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <Modal title="Configurazione WhatsApp" onClose={onClose} wide>
      {/* Step indicators */}
      <div className="wa-steps">
        {STEPS.map((s, i) => (
          <div key={i} className={`wa-step ${step === i + 1 ? 'active' : ''} ${step > i + 1 ? 'done' : ''}`}>
            <div className="wa-step-dot">
              {step > i + 1 ? <Check size={13} /> : i + 1}
            </div>
            <span>{s.label}</span>
            {i < STEPS.length - 1 && <div className="wa-step-line" />}
          </div>
        ))}
      </div>

      {/* ── Step 1: Credenziali ── */}
      {step === 1 && (
        <div>
          <p className="wa-step-desc">
            Inserisci le credenziali della tua app WhatsApp Business (Meta Cloud API).
          </p>
          <Input
            label="Access Token"
            type="password"
            value={cfg.accessToken}
            onChange={(v) => setCfg({ ...cfg, accessToken: v })}
            hint="Token di sistema o permanente dall'App Dashboard di Meta"
          />
          <Input
            label="Phone Number ID"
            value={cfg.phoneNumberId}
            onChange={(v) => setCfg({ ...cfg, phoneNumberId: v })}
            hint="ID del numero di telefono WhatsApp (non il numero in sé)"
          />
          <Input
            label="Business Account ID (WABA ID)"
            value={cfg.businessAccountId}
            onChange={(v) => setCfg({ ...cfg, businessAccountId: v })}
            hint="ID dell'account WhatsApp Business (WABA)"
          />
          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
            <button className="btn btn-primary" onClick={saveCredentials} disabled={saving}>
              {saving ? <Loader2 size={15} className="spin" /> : <ChevronRight size={15} />}
              {saving ? 'Salvataggio…' : 'Avanti'}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Template ── */}
      {step === 2 && (
        <div>
          <p className="wa-step-desc">
            WhatsApp richiede un template approvato per avviare nuove conversazioni.
            Verifichiamo l'esistenza del template <code>conversation_continue</code>.
          </p>

          {checking && (
            <div className="wa-status-box">
              <Loader2 size={18} className="spin" />
              <span>Verifica template in corso…</span>
            </div>
          )}

          {!checking && templateStatus === 'found' && (
            <div className="wa-status-box success">
              <Check size={18} />
              <span>Template <strong>conversation_continue</strong> trovato e approvato. Puoi procedere.</span>
            </div>
          )}

          {!checking && templateStatus === 'pending' && (
            <div className="wa-status-box warning">
              <AlertTriangle size={18} />
              <span>
                Template inviato a Meta per approvazione. Di solito viene approvato in pochi minuti.
                Torna qui per verificare o procedi al passo successivo.
              </span>
            </div>
          )}

          {!checking && templateStatus === 'missing' && (
            <div>
              <div className="wa-status-box warning">
                <AlertTriangle size={18} />
                <span>Template non trovato. Lo creiamo adesso.</span>
              </div>

              <div className="field" style={{ marginTop: 16 }}>
                <label>Lingua del template</label>
                <select
                  className="input"
                  value={cfg.templateLanguage}
                  onChange={(e) => setCfg({ ...cfg, templateLanguage: e.target.value })}
                >
                  <option value="it">Italiano</option>
                  <option value="en">English</option>
                </select>
              </div>

              <div className="wa-template-preview">
                <div className="wa-bubble-header">
                  {cfg.templateLanguage === 'it' ? 'Benvenuto in Sophia' : 'Welcome to Sophia'}
                </div>
                <div className="wa-bubble-body">
                  {cfg.templateLanguage === 'it'
                    ? 'Ciao! Hai una notifica in attesa. Premi il pulsante qui sotto per riceverla e continuare la conversazione su WhatsApp.'
                    : 'Hi! You have a pending notification. Press the button below to receive it and continue the conversation on WhatsApp.'}
                </div>
                <button className="wa-bubble-btn" disabled>
                  {cfg.templateLanguage === 'it' ? '✓ Continua' : '✓ Continue'}
                </button>
              </div>

              <button className="btn btn-primary" onClick={createTemplate} disabled={creating} style={{ marginTop: 12 }}>
                {creating ? <Loader2 size={15} className="spin" /> : <MessageSquare size={15} />}
                {creating ? 'Creazione in corso…' : 'Crea template'}
              </button>
            </div>
          )}

          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={() => setStep(1)}>
              <ChevronLeft size={15} /> Indietro
            </button>
            {templateStatus === 'found' || templateStatus === 'pending' ? (
              <button className="btn btn-primary" onClick={goToStep3}>
                <ChevronRight size={15} /> Avanti
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={goToStep3}>
                Salta →
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Step 3: Webhook ── */}
      {step === 3 && (
        <div>
          <p className="wa-step-desc">
            Configura il webhook su Meta per ricevere i messaggi in arrivo.
            Copia i valori qui sotto e incollali nella sezione <strong>WhatsApp → Configurazione</strong> del tuo App Dashboard Meta.
          </p>

          {loadingWebhook && (
            <div className="wa-status-box">
              <Loader2 size={18} className="spin" />
              <span>Generazione URL webhook…</span>
            </div>
          )}

          {webhookInfo && (
            <div>
              <div className="wa-webhook-field">
                <label><Globe size={14} /> URL callback</label>
                <div className="wa-webhook-value">
                  <code>{webhookInfo.webhookUrl}</code>
                  <button className="btn btn-ghost btn-sm" onClick={() => copyText(webhookInfo.webhookUrl)}>
                    <Copy size={14} /> Copia
                  </button>
                </div>
              </div>

              <div className="wa-webhook-field">
                <label><Link size={14} /> Token di verifica</label>
                <div className="wa-webhook-value">
                  <code>{webhookInfo.verifyToken}</code>
                  <button className="btn btn-ghost btn-sm" onClick={() => copyText(webhookInfo.verifyToken)}>
                    <Copy size={14} /> Copia
                  </button>
                </div>
              </div>

              <div className="wa-info-box">
                <strong>Come configurare in Meta:</strong>
                <ol style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.8 }}>
                  <li>Apri <a href="https://developers.facebook.com" target="_blank" rel="noreferrer">Meta for Developers <ExternalLink size={12} /></a> → la tua app</li>
                  <li>Vai su <strong>WhatsApp → Configurazione</strong></li>
                  <li>Clicca <strong>Modifica</strong> accanto a "Webhook"</li>
                  <li>Incolla l'URL callback e il token di verifica</li>
                  <li>Clicca <strong>Verifica e salva</strong></li>
                  <li>Iscriviti al campo <strong>messages</strong></li>
                </ol>
              </div>
            </div>
          )}

          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={() => setStep(2)}>
              <ChevronLeft size={15} /> Indietro
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              <Check size={15} /> Chiudi
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Email Config ──────────────────────────────────────────────────────────

function EmailConfig({ module, onClose }) {
  const toast = useToast();
  const [smtps, setSmtps] = useState(module.config?.smtps || []);

  const add = () => setSmtps([...smtps, {
    name: '', host: '', port: 587, secure: false, username: '', password: '', fromEmail: '', fromName: '',
  }]);
  const update = (i, patch) => setSmtps(smtps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const removeAt = (i) => setSmtps(smtps.filter((_, idx) => idx !== i));

  const save = async () => {
    try {
      await api('/modules/email/config', { method: 'PUT', body: { config: { smtps } } });
      toast.info('Configurazione email salvata');
      onClose();
    } catch (err) { toast.error(err.message); }
  };

  return (
    <Modal title="Configurazione Email (SMTP)" onClose={onClose}>
      <p className="page-subtitle" style={{ marginBottom: 16 }}>
        Aggiungi un numero illimitato di server. L'assistente sceglie automaticamente quale usare.
      </p>
      {smtps.map((s, i) => (
        <div key={i} className="smtp-row card">
          <div className="smtp-grid">
            <Input label="Nome" value={s.name} onChange={(v) => update(i, { name: v })} />
            <Input label="Host" value={s.host} onChange={(v) => update(i, { host: v })} />
            <Input label="Porta" type="number" value={s.port} onChange={(v) => update(i, { port: Number(v) })} />
            <Input label="Username" value={s.username} onChange={(v) => update(i, { username: v })} />
            <Input label="Password" type="password" value={s.password} onChange={(v) => update(i, { password: v })} />
            <Input label="Email mittente" value={s.fromEmail} onChange={(v) => update(i, { fromEmail: v })} />
            <Input label="Nome mittente" value={s.fromName} onChange={(v) => update(i, { fromName: v })} />
            <label className="checkbox">
              <input type="checkbox" checked={s.secure} onChange={(e) => update(i, { secure: e.target.checked })} />
              SSL/TLS
            </label>
          </div>
          <button className="btn btn-danger" onClick={() => removeAt(i)}><Trash2 size={14} /> Rimuovi</button>
        </div>
      ))}
      <button className="btn btn-outline" onClick={add}><Plus size={15} /> Aggiungi server</button>
      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
        <button className="btn btn-primary" onClick={save}>Salva</button>
      </div>
    </Modal>
  );
}

// ── Input helper ─────────────────────────────────────────────────────────

function Input({ label, value, onChange, type = 'text', hint }) {
  return (
    <div className="field" style={{ marginBottom: 14 }}>
      <label>{label}</label>
      <input
        className="input"
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

// ── Gemini Config ─────────────────────────────────────────────────────────

function GeminiConfig({ module, onClose }) {
  const toast = useToast();
  const [apiKey, setApiKey] = useState('');
  const [geminiModel, setGeminiModel] = useState('gemini-2.5-flash');
  const [saving, setSaving] = useState(false);
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    api('/gemini/config').then((data) => {
      setHasKey(data.hasKey);
      setGeminiModel(data.model || 'gemini-2.5-flash');
    }).catch(() => {});
  }, []);

  const save = async () => {
    if (!apiKey && !hasKey) return toast.error('Inserisci una API key');
    if (!apiKey && hasKey) { onClose(); return; }
    setSaving(true);
    try {
      await api('/gemini/config', { method: 'PUT', body: { apiKey, model: geminiModel } });
      toast.info('Configurazione Gemini salvata');
      onClose();
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  return (
    <Modal title="Configura Gemini AI" onClose={onClose}>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
        La API key di Google Gemini viene salvata nel database in modo sicuro e non nel file .env.
        Ogni tenant ha la propria chiave.
      </p>
      {hasKey && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 13 }}>
          ✅ API key già configurata. Inserisci una nuova chiave solo se vuoi cambiarla.
        </div>
      )}
      <Input label="API Key Google Gemini" value={apiKey} onChange={setApiKey} type="password"
        hint="Ottenila da https://aistudio.google.com/apikey" />
      <Input label="Modello Gemini" value={geminiModel} onChange={setGeminiModel}
        hint="Es. gemini-2.5-flash, gemini-1.5-pro" />
      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Salvataggio…' : 'Salva'}</button>
      </div>
    </Modal>
  );
}

// ── Configurazione modulo Database ──────────────────────────────────────────
function DatabaseConfig({ module, onClose }) {
  const toast = useToast();
  const [adminCanCreate, setAdminCanCreate] = useState(!!(module.config?.adminCanCreate));
  const [adminCanWrite, setAdminCanWrite]   = useState(!!(module.config?.adminCanWrite));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api(`/modules/database/config`, { method: 'PUT', body: { config: { adminCanCreate, adminCanWrite } } });
      toast.info('Permessi database salvati');
      onClose();
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };

  return (
    <Modal title="Configurazione Database" onClose={onClose}>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
        Controlla cosa possono fare gli Admin del tenant. I Super Admin hanno sempre accesso completo.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" style={{ marginTop: 2 }} checked={adminCanCreate} onChange={e => setAdminCanCreate(e.target.checked)}/>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Admin può creare / modificare / eliminare schemi</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Se attivo, l'admin del tenant può definire nuovi database, modificarne la struttura ed eliminarli.
              L'AI può creare schemi solo se questo permesso è attivo.
            </div>
          </div>
        </label>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" style={{ marginTop: 2 }} checked={adminCanWrite} onChange={e => setAdminCanWrite(e.target.checked)}/>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Admin può creare / modificare / eliminare record</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Se attivo, l'admin (e i member con accesso) possono inserire, modificare e cancellare record.
              L'AI può modificare record solo se questo permesso è attivo.
              <br/>Se disattivo, la lettura è sempre permessa.
            </div>
          </div>
        </label>
      </div>
      <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--gray-50)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
        <span>ℹ️</span>
        <span>Di default entrambi i permessi sono <strong>disabilitati</strong>: gli admin possono solo leggere i dati. Attivali solo se vuoi che possano modificare la struttura o i dati.</span>
      </div>
      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Salvo…' : 'Salva permessi'}</button>
      </div>
    </Modal>
  );
}
