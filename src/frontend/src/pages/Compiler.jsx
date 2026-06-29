import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileText, Upload, Trash2, RefreshCw, ExternalLink, Copy, Check,
  Plus, ChevronDown, ChevronUp, Download, Users, Send, X, Loader2,
  Lock, Phone, Mail, Eye, Link, Settings,
} from 'lucide-react';
import { api, tokens } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useTenant } from '../context/TenantContext.jsx';

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Ottiene un token one-time (60 s) e apre il PDF in una nuova scheda.
// Serve perché il browser non può mandare Authorization header su <a href>.
async function openPdf(submissionId) {
  const { token } = await api(`/compiler/submissions/${submissionId}/pdf-token`, { method: 'POST' });
  window.open(`/api/compiler/submissions/${submissionId}/pdf?token=${encodeURIComponent(token)}`, '_blank', 'noopener');
}

function PdfDownloadButton({ submissionId }) {
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const handle = async (e) => {
    e.stopPropagation();
    setLoading(true);
    try { await openPdf(submissionId); }
    catch (err) { toast.error('Impossibile aprire il PDF: ' + err.message); }
    finally { setLoading(false); }
  };
  return (
    <button className="btn btn-outline btn-sm" onClick={handle} disabled={loading} title="Apri PDF">
      {loading ? <Loader2 size={13} className="spin"/> : <Download size={13}/>} PDF
    </button>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="btn btn-ghost icon-btn" title="Copia" onClick={async () => {
      await navigator.clipboard.writeText(text).catch(() => {});
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    }}>
      {copied ? <Check size={13} style={{ color: 'var(--green-600)' }}/> : <Copy size={13}/>}
    </button>
  );
}

// ── Upload con progress bar ───────────────────────────────────────────────────
function useUploadWithProgress() {
  const [progress, setProgress] = useState(0); // 0-100
  const [uploading, setUploading] = useState(false);
  const [uploadName, setUploadName] = useState('');

  const upload = (path, file, extra = {}) => new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);

    // Usa i token dal modulo api.js (chiavi corrette: sophia.access, sophia.tenant)
    if (tokens.access)  xhr.setRequestHeader('Authorization', `Bearer ${tokens.access}`);
    if (tokens.tenant)  xhr.setRequestHeader('X-Tenant-Id', tokens.tenant);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setUploading(false);
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || 'Upload fallito'));
      } catch { reject(new Error('Risposta non valida')); }
    };
    xhr.onerror = () => { setUploading(false); reject(new Error('Errore di rete')); };
    xhr.send(form);
  });

  const uploadFile = async (path, file, extra = {}) => {
    setUploading(true);
    setProgress(0);
    setUploadName(file.name);
    try {
      const result = await upload(path, file, extra);
      setProgress(100);
      return result;
    } finally {
      setTimeout(() => { setUploading(false); setProgress(0); setUploadName(''); }, 600);
    }
  };

  return { uploading, progress, uploadName, uploadFile };
}

// ── FormCard ─────────────────────────────────────────────────────────────────
function FormCard({ form: f, onDelete, onRefresh, canManage }) {
  const toast = useToast();
  const [generatedLink, setGeneratedLink] = useState(null);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [editUrl, setEditUrl] = useState(null);
  const [generatingEdit, setGeneratingEdit] = useState(false);
  const [showSubs, setShowSubs] = useState(false);

  const generateLink = async () => {
    setGeneratingLink(true);
    try {
      const r = await api(`/compiler/forms/${f.id}/generate-link`, { method: 'POST', body: { excludeAttachments: [] } });
      setGeneratedLink(r.url);
    } catch (err) { toast.error(err.message); } finally { setGeneratingLink(false); }
  };

  const generateEditLink = async () => {
    setGeneratingEdit(true);
    try {
      const r = await api(`/compiler/forms/${f.id}/edit-link`, { method: 'POST', body: {} });
      setEditUrl(r.editUrl);
      toast.info('Link di modifica generato — valido 24 ore');
    } catch (err) { toast.error(err.message); } finally { setGeneratingEdit(false); }
  };

  return (
    <div className="card compiler-form-card">
      {/* Header */}
      <div className="compiler-form-head">
        <div className={`compiler-form-icon ${f.status === 'ready' ? 'ready' : 'processing'}`}>
          {f.status === 'ready' ? <FileText size={18}/> : <Loader2 size={18} className="spin"/>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="compiler-form-name">{f.name}</div>
          <div className="compiler-form-meta">
            <span>{fmtDate(f.createdAt)}</span>
            {f.submissionCount > 0 && <span className="compiler-form-subs"><Users size={11}/> {f.submissionCount}</span>}
          </div>
        </div>
        <span className={`badge ${f.status === 'ready' ? 'badge-on' : 'badge-off'}`}>
          {f.status === 'ready' ? 'Pronto' : 'Elaborazione…'}
        </span>
      </div>

      {/* Azioni disponibili solo quando pronto */}
      {f.status === 'ready' && (
        <div className="compiler-form-links">

          {/* Link compilabile */}
          <div className="compiler-link-block">
            <div className="compiler-link-block-label"><Link size={11}/> Link compilabile</div>
            {generatedLink ? (
              <div className="compiler-link-row">
                <span className="compiler-link-url">{generatedLink}</span>
                <CopyButton text={generatedLink}/>
                <a href={generatedLink} target="_blank" rel="noopener" className="btn btn-ghost icon-btn" title="Apri">
                  <ExternalLink size={13}/>
                </a>
              </div>
            ) : canManage ? (
              <button className="btn btn-primary btn-sm" onClick={generateLink} disabled={generatingLink}>
                {generatingLink
                  ? <><Loader2 size={12} className="spin"/> Generando…</>
                  : <><Plus size={12}/> Genera link</>}
              </button>
            ) : (
              <span className="compiler-readonly-note">Solo admin con permessi possono generare link</span>
            )}
          </div>

          {/* Link modifica mappatura */}
          {canManage && (
            <div className="compiler-link-block">
              <div className="compiler-link-block-label"><Settings size={11}/> Modifica mappatura <span className="compiler-link-expiry">(valido 24h)</span></div>
              {editUrl ? (
                <div className="compiler-link-row">
                  <a href={editUrl} target="_blank" rel="noopener" className="btn btn-outline btn-sm">
                    <Eye size={12}/> Apri editor
                  </a>
                  <button className="btn btn-ghost btn-sm" onClick={generateEditLink} disabled={generatingEdit} title="Rigenera link">
                    <RefreshCw size={12} className={generatingEdit ? 'spin' : ''}/>
                  </button>
                </div>
              ) : (
                <button className="btn btn-outline btn-sm" onClick={generateEditLink} disabled={generatingEdit}>
                  {generatingEdit
                    ? <><Loader2 size={12} className="spin"/> Generando…</>
                    : <><Eye size={12}/> Genera link editor</>}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="compiler-form-footer">
        <button className="btn btn-ghost icon-btn btn-sm" onClick={onRefresh} title="Aggiorna">
          <RefreshCw size={13}/>
        </button>
        {canManage && (
          <button className="btn btn-ghost icon-btn btn-sm danger" onClick={() => onDelete(f)} title="Elimina">
            <Trash2 size={13}/>
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Compiler() {
  const toast = useToast();
  const modal = useModal();
  const { user } = useAuth();
  const { activeId: activeTenantId } = useTenant();
  const isSuper = user?.role === 'SUPER_ADMIN';
  const isAdmin = user?.role === 'ADMIN' || isSuper;

  const [moduleConfig, setModuleConfig] = useState(null);
  const [forms, setForms] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('forms');
  const [expandedSub, setExpandedSub] = useState(null);
  const [cfgForm, setCfgForm] = useState({ apiKey: '', portalUser: '', portalPass: '', allowAdminManage: false });
  const fileRef = useRef();

  const { uploading, progress, uploadName, uploadFile } = useUploadWithProgress();

  const loadConfig = useCallback(() =>
    api('/modules').then(({ modules }) => {
      const m = modules.find(m => m.key === 'compiler');
      setModuleConfig(m || null);
      if (m?.config) setCfgForm(f => ({ ...f, ...m.config }));
    }).catch(() => {}), []);

  const loadForms = useCallback(async () => {
    try {
      const r = await api('/compiler/forms');
      setForms(r.forms || []);
    } catch (err) {
      console.error('loadForms error:', err.message);
    }
  }, []);

  const loadSubmissions = useCallback(async () => {
    try {
      const r = await api('/compiler/submissions');
      setSubmissions(r.submissions || []);
    } catch (err) {
      console.error('loadSubmissions error:', err.message);
    }
  }, []);

  useEffect(() => {
    Promise.all([loadConfig(), loadForms(), loadSubmissions()]).finally(() => setLoading(false));
  }, []);

  // Auto-refresh ogni 5s se ci sono form in elaborazione
  useEffect(() => {
    if (!forms.some(f => f.status === 'processing')) return;
    const t = setInterval(loadForms, 5000);
    return () => clearInterval(t);
  }, [forms, loadForms]);

  const isActive = moduleConfig?.installed && moduleConfig?.enabled;
  const instance = moduleConfig;
  const allowAdminManage = moduleConfig?.config?.allowAdminManage;
  const canManage = isSuper || (isAdmin && allowAdminManage);
  const config = moduleConfig?.config || {};
  const hasCredentials = !!(config.portalUser && config.portalPass);
  const webhookUrl = `${window.location.origin}/api/compiler/webhook/${activeTenantId || ''}`;

  const uploadForm = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileRef.current) fileRef.current.value = '';

    // Modal personalizzato per il nome del modulo
    const defaultName = file.name.replace(/\.pdf$/i, '');
    const name = await modal.prompt('Come vuoi chiamare questo modulo?', {
      title: 'Nome modulo',
      defaultValue: defaultName,
      placeholder: 'Es. Modulo iscrizione, F24, Contratto…',
    });
    if (name === null) return; // annullato

    try {
      await uploadFile('/compiler/forms', file, { name: (name || defaultName).trim() });
      toast.info('Modulo caricato — mappatura AI in corso…');
      loadForms();
    } catch (err) { toast.error(err.message); }
  };

  const deleteForm = async (f) => {
    const ok = await modal.confirm(`Eliminare "${f.name}"? Questa azione non è reversibile.`, { danger: true });
    if (!ok) return;
    try { await api(`/compiler/forms/${f.id}`, { method: 'DELETE' }); toast.info('Modulo eliminato'); loadForms(); }
    catch (err) { toast.error(err.message); }
  };

  const saveConfig = async () => {
    try {
      await api('/modules/compiler/config', { method: 'PUT', body: { config: cfgForm } });
      toast.info('Configurazione salvata'); loadConfig();
    } catch (err) { toast.error(err.message); }
  };

  if (loading) return <div className="skeleton" style={{ height: 400 }}/>;

  if (!isActive) return (
    <div>
      <h1 className="page-title">Compilatore moduli</h1>
      <div className="card empty-state" style={{ marginTop: 24, padding: 40 }}>
        <div className="empty-icon"><Lock size={28} strokeWidth={1.5}/></div>
        <h3>Modulo non attivo</h3>
        {isSuper
          ? <p>Attiva il modulo dalla sezione <strong>Moduli</strong>.</p>
          : <>
              <p>Contatta PHI Informatica per attivarlo:</p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 12, flexWrap: 'wrap' }}>
                <a href="tel:+390355788880" className="modules-contact-btn modules-contact-btn-phone"><Phone size={14}/> +39 035 578 8880</a>
                <a href="mailto:sophia@phi.it" className="modules-contact-btn modules-contact-btn-email"><Mail size={14}/> sophia@phi.it</a>
              </div>
            </>}
      </div>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div className="page-head-row" style={{ marginBottom: 24 }}>
        <div>
          <h1 className="page-title" style={{ margin: 0 }}>Compilatore moduli</h1>
          <p className="page-subtitle">Carica PDF, invia ai clienti, ricevi le compilazioni nel cloud</p>
        </div>
        {hasCredentials && (
          <a href="https://compiler.ai-sophia.it" target="_blank" rel="noopener" className="btn btn-outline">
            <ExternalLink size={15}/> Apri PHI Compiler
          </a>
        )}
      </div>

      {/* Tabs */}
      <div className="tab-bar" style={{ marginBottom: 20 }}>
        {[
          ['forms', 'Moduli'],
          ['submissions', 'Compilazioni'],
          ...(isAdmin ? [['config', 'Configurazione']] : []),
        ].map(([k, label]) => (
          <button key={k} className={`tab-btn${activeTab === k ? ' active' : ''}`} onClick={() => setActiveTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {/* ── MODULI ── */}
      {activeTab === 'forms' && (
        <div>
          <div className="compiler-toolbar">
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              {canManage
                ? 'Carica un PDF: verrà mappato automaticamente e reso disponibile per l\'invio.'
                : 'Visualizzazione in sola lettura. Contatta un amministratore per modifiche.'}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost icon-btn" onClick={loadForms} title="Aggiorna"><RefreshCw size={15}/></button>
              {canManage && (
                <>
                  <input ref={fileRef} type="file" accept="application/pdf" hidden onChange={uploadForm}/>
                  <button className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={uploading}>
                    <Upload size={15}/> Carica PDF
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Progress bar upload */}
          {uploading && (
            <div className="upload-progress-bar-wrap" style={{ position: 'static', transform: 'none', margin: '12px 0' }}>
              <div className="upload-progress-info">
                <Upload size={14}/>
                <span>{uploadName}</span>
                <span className="upload-pct">{progress}%</span>
              </div>
              <div className="upload-progress-track">
                <div className="upload-progress-fill" style={{ width: `${progress}%` }}/>
              </div>
            </div>
          )}

          {forms.length === 0 ? (
            <div className="card empty-state" style={{ padding: 40 }}>
              <div className="empty-icon"><FileText size={28} strokeWidth={1.5}/></div>
              <h3>Nessun modulo</h3>
              {canManage && <p>Carica il primo PDF per iniziare.</p>}
            </div>
          ) : (
            <div className="compiler-forms-grid">
              {forms.map(f => (
                <FormCard key={f.id} form={f} onDelete={deleteForm} onRefresh={loadForms} canManage={canManage}/>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── COMPILAZIONI ── */}
      {activeTab === 'submissions' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn btn-ghost icon-btn" onClick={loadSubmissions} title="Aggiorna"><RefreshCw size={15}/></button>
          </div>
          {submissions.length === 0 ? (
            <div className="card empty-state" style={{ padding: 40 }}>
              <div className="empty-icon"><Send size={28} strokeWidth={1.5}/></div>
              <h3>Nessuna compilazione</h3>
              <p>Le compilazioni ricevute dai clienti appariranno qui e vengono salvate nel cloud del contatto.</p>
            </div>
          ) : (
            <div className="compiler-subs-list">
              {submissions.map(s => (
                <div key={s.id} className="card compiler-sub-card">
                  <div className="compiler-sub-head" onClick={() => setExpandedSub(expandedSub === s.id ? null : s.id)}>
                    <div className="compiler-sub-info">
                      <span className="compiler-sub-form">{s.form?.name}</span>
                      <span className="compiler-sub-email">{s.email || '(email non fornita)'}</span>
                      <span className="compiler-sub-date">{fmtDate(s.createdAt)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {s.pdfUrl && (
                        <PdfDownloadButton submissionId={s.id} />
                      )}
                      {expandedSub === s.id ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
                    </div>
                  </div>
                  {expandedSub === s.id && (
                    <div className="compiler-sub-detail">
                      {Array.isArray(s.fields) && s.fields.length > 0 && (
                        <>
                          <p className="compiler-detail-label">Campi compilati</p>
                          <div className="compiler-fields-grid">
                            {s.fields.map((field, i) => (
                              <div key={i} className="compiler-field-row">
                                <span className="compiler-field-label">{field.label}</span>
                                <span className="compiler-field-value">{field.value || '—'}</span>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                      {Array.isArray(s.attachments) && s.attachments.length > 0 && (
                        <div style={{ marginTop: 12 }}>
                          <p className="compiler-detail-label">Allegati</p>
                          {s.attachments.map((a, i) => (
                            <span key={i} className="tag-chip" style={{ marginRight: 6 }}>{a.label || a.name}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── CONFIGURAZIONE ── */}
      {activeTab === 'config' && isAdmin && (
        <div className="card narrow">
          {isSuper ? (
            <>
              <h3 style={{ marginTop: 0 }}>Configurazione PHI Compiler</h3>

              {/* Webhook URL */}
              <div className="compiler-webhook-box" style={{ marginBottom: 20 }}>
                <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>URL Webhook</p>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
                  Incolla questo URL nelle impostazioni della chiave API su compiler.ai-sophia.it.
                </p>
                <div className="compiler-link-row">
                  <code style={{ flex: 1, fontSize: 12, wordBreak: 'break-all', color: 'var(--gray-700)' }}>{webhookUrl}</code>
                  <CopyButton text={webhookUrl}/>
                </div>
              </div>

              <div className="field">
                <label>API Key PHI Compiler</label>
                <input className="input" type="password" value={cfgForm.apiKey || ''} onChange={e => setCfgForm(f => ({ ...f, apiKey: e.target.value }))} placeholder="phi_xxx"/>
              </div>

              <div className="field" style={{ marginTop: 16 }}>
                <label className="toggle-row">
                  <span style={{ flex: 1 }}>
                    <strong>Permetti agli admin di gestire i moduli in autonomia</strong><br/>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Gli admin possono caricare, generare link ed eliminare moduli</span>
                  </span>
                  <input type="checkbox" checked={!!cfgForm.allowAdminManage} onChange={e => setCfgForm(f => ({ ...f, allowAdminManage: e.target.checked }))}/>
                </label>
              </div>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 16 }}>
                <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Credenziali portale (visibili agli admin)</p>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Gli admin vedranno queste credenziali per accedere a compiler.ai-sophia.it.
                </p>
                <div className="smtp-grid">
                  <div className="field">
                    <label>Username portale</label>
                    <input className="input" value={cfgForm.portalUser || ''} onChange={e => setCfgForm(f => ({ ...f, portalUser: e.target.value }))} placeholder="email@esempio.it"/>
                  </div>
                  <div className="field">
                    <label>Password portale</label>
                    <input className="input" type="password" value={cfgForm.portalPass || ''} onChange={e => setCfgForm(f => ({ ...f, portalPass: e.target.value }))}/>
                  </div>
                </div>
              </div>

              <div className="modal-foot" style={{ padding: 0, marginTop: 20 }}>
                <button className="btn btn-primary" onClick={saveConfig}>Salva configurazione</button>
              </div>
            </>
          ) : (
            // Admin: vede le credenziali portale (se configurate) e la propria autonomia
            <div>
              <h3 style={{ marginTop: 0 }}>Accesso a PHI Compiler</h3>
              {hasCredentials ? (
                <>
                  <p style={{ fontSize: 13, color: 'var(--gray-600)', marginBottom: 16 }}>
                    Usa queste credenziali per accedere al portale.
                  </p>
                  <div className="field"><label>Username</label><input className="input" readOnly value={config.portalUser || ''}/></div>
                  <div className="field"><label>Password</label><input className="input" readOnly value={config.portalPass || ''}/></div>
                  <a href="https://compiler.ai-sophia.it" target="_blank" rel="noopener" className="btn btn-primary" style={{ marginTop: 12 }}>
                    <ExternalLink size={15}/> Apri PHI Compiler
                  </a>
                </>
              ) : (
                <>
                  <p style={{ fontSize: 13, color: 'var(--gray-600)', marginBottom: 16 }}>
                    Non hai ancora credenziali per il portale. Contatta PHI Informatica:
                  </p>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <a href="tel:+390355788880" className="modules-contact-btn modules-contact-btn-phone"><Phone size={14}/> +39 035 578 8880</a>
                    <a href="mailto:sophia@phi.it" className="modules-contact-btn modules-contact-btn-email"><Mail size={14}/> sophia@phi.it</a>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
