import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Plus, Search, Send, Paperclip, Mic, MoreVertical, Trash2, Pencil, X, Loader2,
  Activity, Clock, CheckCircle2, Pause, Play, ChevronDown, ChevronUp,
  MessageCircle, Phone, PhoneOff, FlaskConical, Unlink,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Download, ExternalLink, FileText,
} from 'lucide-react';
import { api, streamMessage, upload } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import Markdown from '../components/Markdown.jsx';
import AgentSelector from '../components/AgentSelector.jsx';

function formatDateTime(dt) {
  if (!dt) return '';
  return new Date(dt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formatInterval(s) {
  if (!s) return '';
  if (s >= 3600) return `ogni ${Math.round(s / 3600)} ora/e`;
  if (s >= 60) return `ogni ${Math.round(s / 60)} minuti`;
  return `ogni ${s} secondi`;
}
function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ── Pannello destro: Attività + WhatsApp + Addestramento ──────────────────

function RightPanel({
  className = '',
  onToggleRight,
  conversationId, refreshKey,
  // WA
  phoneLinked, waPhone, waSyncId, currentConvId,
  onLinkPhone, onUnlinkPhone, onInitWaSync, onDisconnectWaSync,
  // Training
  isAdmin, isTrainingChat, trainingLoading, onToggleTraining,
}) {
  const [tasks, setTasks] = useState([]);
  const [actionLog, setActionLog] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('sophia.actionLog') || '[]'); } catch { return []; }
  });
  const [openActivity, setOpenActivity] = useState(true);
  const [openWa, setOpenWa] = useState(true);
  const [openTraining, setOpenTraining] = useState(true);
  const toast = useToast();

  const load = useCallback(async () => {
    if (!conversationId) return;
    try { const { tasks } = await api(`/tasks?conversationId=${conversationId}`); setTasks(tasks); } catch {}
  }, [conversationId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  useEffect(() => {
    const handler = (e) => {
      const entry = e.detail;
      setActionLog((prev) => { const next = [entry, ...prev].slice(0, 50); sessionStorage.setItem('sophia.actionLog', JSON.stringify(next)); return next; });
    };
    window.addEventListener('sophia:action', handler);
    return () => window.removeEventListener('sophia:action', handler);
  }, []);

  const toggleTask = async (task) => {
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: task.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' } });
      load();
    } catch (err) { toast.error(err.message); }
  };
  const deleteTask = async (task) => {
    try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); load(); } catch (err) { toast.error(err.message); }
  };
  const clearLog = () => { setActionLog([]); sessionStorage.removeItem('sophia.actionLog'); };
  const activeTasks = tasks.filter((t) => t.kind === 'RECURRING');
  const isWaSyncedChat = waSyncId && currentConvId === waSyncId;

  return (
    <aside className={`activity-panel${className ? ' ' + className : ''}`}>
      <div className="activity-panel-inner">

      {/* ── Sezione WhatsApp ── */}
      <div className="panel-section">
        <div className="panel-section-header" onClick={() => setOpenWa(o => !o)}>
          <span><MessageCircle size={14} /> WhatsApp</span>
          {openWa ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </div>
        {openWa && (
          <div className="panel-section-body">
            {!phoneLinked ? (
              <div className="panel-wa-state">
                <p className="panel-wa-desc">Collega il tuo numero per sincronizzare la chat con WhatsApp.</p>
                <button className="btn btn-outline btn-sm" onClick={onLinkPhone}>
                  <Phone size={13} /> Collega numero
                </button>
              </div>
            ) : (
              <div className="panel-wa-state">
                <div className="panel-wa-number">
                  <Phone size={13} />
                  <span>{waPhone}</span>
                  <span className="panel-wa-verified">verificato</span>
                </div>
                {!waSyncId ? (
                  <button className="btn btn-outline btn-sm" onClick={onInitWaSync}>
                    <MessageCircle size={13} /> Apri chat sincronizzata
                  </button>
                ) : (
                  <div className="panel-wa-synced">
                    <div className="panel-wa-sync-badge">
                      <MessageCircle size={12} /> Chat sincronizzata attiva
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={onDisconnectWaSync}>
                      <Unlink size={12} /> Disconnetti chat
                    </button>
                  </div>
                )}
                <button className="btn btn-ghost btn-sm panel-wa-unlink" onClick={onUnlinkPhone}>
                  <PhoneOff size={12} /> Scollega numero
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Sezione Addestramento (solo admin) ── */}
      {isAdmin && conversationId && (
        <div className="panel-section">
          <div className="panel-section-header" onClick={() => setOpenTraining(o => !o)}>
            <span><FlaskConical size={14} /> Addestramento</span>
            {openTraining ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </div>
          {openTraining && (
            <div className="panel-section-body">
              <p className="panel-training-desc">
                Attiva per usare questa chat come sessione di addestramento. La chat verrà svuotata e l'AI si comporterà normalmente per permetterti di testare le risposte.
              </p>
              <label className="panel-training-toggle">
                <span>Chat di addestramento</span>
                <div className={`toggle-switch ${isTrainingChat ? 'on' : ''} ${trainingLoading ? 'loading' : ''}`} onClick={!trainingLoading ? onToggleTraining : undefined}>
                  <div className="toggle-thumb" />
                </div>
              </label>
              {isTrainingChat && (
                <div className="panel-training-active">
                  <FlaskConical size={12} />
                  <span>Sessione attiva — l'AI risponde normalmente ma le risposte utili possono essere applicate al prompt.</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Sezione Attività ── */}
      <div className="panel-section">
        <div className="panel-section-header" onClick={() => setOpenActivity(o => !o)}>
          <span><Activity size={14} /> Attività</span>
          {openActivity ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </div>
        {openActivity && (
          <div className="panel-section-body">
            <div className="activity-section-title">Programmate</div>
            {activeTasks.length === 0 && <p className="activity-empty">Nessuna attività attiva.</p>}
            {activeTasks.map((t) => (
              <div key={t.id} className={`activity-item ${t.status === 'PAUSED' ? 'paused' : ''}`}>
                <div className="activity-item-top"><span className="activity-item-label">{t.instruction}</span></div>
                <div className="activity-item-meta">
                  <Clock size={11} />{t.intervalSeconds ? formatInterval(t.intervalSeconds) : 'una volta'}
                  {t.lastRunAt && <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>· {formatDateTime(t.lastRunAt)}</span>}
                </div>
                <div className="activity-item-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => toggleTask(t)}>
                    {t.status === 'ACTIVE' ? <Pause size={12} /> : <Play size={12} />}
                    {t.status === 'ACTIVE' ? 'Pausa' : 'Riattiva'}
                  </button>
                  <button className="btn btn-danger icon-btn" onClick={() => deleteTask(t)}><Trash2 size={12} /></button>
                </div>
              </div>
            ))}
            <div className="activity-section-title" style={{ marginTop: 12 }}>
              Azioni eseguite
              {actionLog.length > 0 && <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', fontSize: 11 }} onClick={clearLog}>Cancella</button>}
            </div>
            {actionLog.length === 0 && <p className="activity-empty">Nessuna azione registrata.</p>}
            {actionLog.map((entry, i) => (
              <div key={i} className="action-log-item">
                <CheckCircle2 size={12} className="action-log-icon" />
                <div><div className="action-log-name">{entry.label}</div><div className="action-log-time">{entry.time}</div></div>
              </div>
            ))}
          </div>
        )}
      </div>

      </div>{/* end activity-panel-inner */}
    </aside>
  );
}

// ── Modal collegamento telefono ────────────────────────────────────────────

function PhoneLinkModal({ onClose, onLinked }) {
  const toast = useToast();
  const [step, setStep] = useState('phone');
  const [phone, setPhone] = useState('+39');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [expiresAt, setExpiresAt] = useState(null);
  const inputRefs = useRef([]);

  const sendOtp = async () => {
    if (!phone.match(/^\+\d{7,15}$/)) return toast.error('Formato non valido (es. +393331234567)');
    setLoading(true);
    try {
      const { expiresAt } = await api('/phone/link', { method: 'POST', body: { phone } });
      setExpiresAt(expiresAt);
      setStep('otp');
      toast.info('Codice OTP inviato via WhatsApp');
    } catch (err) { toast.error(err.message); } finally { setLoading(false); }
  };

  const verifyOtp = async () => {
    const code = otp.join('');
    if (code.length !== 6) return toast.error('Inserisci tutte le 6 cifre');
    setLoading(true);
    try {
      await api('/phone/verify', { method: 'POST', body: { code } });
      setStep('done');
      onLinked(phone);
    } catch (err) { toast.error(err.message); } finally { setLoading(false); }
  };

  const handleOtpChange = (i, val) => {
    const d = val.replace(/\D/g, '').slice(-1);
    const next = [...otp]; next[i] = d; setOtp(next);
    if (d && i < 5) inputRefs.current[i + 1]?.focus();
  };
  const handleOtpKey = (i, e) => {
    if (e.key === 'Backspace' && !otp[i] && i > 0) inputRefs.current[i - 1]?.focus();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Collega numero WhatsApp</h2>
        {step === 'phone' && (
          <div className="phone-link-box">
            <p className="field-hint">Inserisci il numero di telefono. Riceverai un codice OTP via WhatsApp.</p>
            <div className="field">
              <label>Numero (formato internazionale)</label>
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+393331234567" />
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
              <button className="btn btn-primary" onClick={sendOtp} disabled={loading}>{loading ? 'Invio…' : 'Invia codice'}</button>
            </div>
          </div>
        )}
        {step === 'otp' && (
          <div className="phone-link-box">
            <p className="field-hint">Inserisci il codice a 6 cifre ricevuto su WhatsApp al numero <strong>{phone}</strong>.</p>
            {expiresAt && <p className="field-hint">Valido fino alle {new Date(expiresAt).toLocaleTimeString('it-IT')}</p>}
            <div className="otp-inputs">
              {otp.map((d, i) => (
                <input key={i} ref={(el) => inputRefs.current[i] = el}
                  className="otp-digit" maxLength={1} value={d}
                  onChange={(e) => handleOtpChange(i, e.target.value)}
                  onKeyDown={(e) => handleOtpKey(i, e)}
                  inputMode="numeric" />
              ))}
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setStep('phone')}>Indietro</button>
              <button className="btn btn-primary" onClick={verifyOtp} disabled={loading || otp.join('').length < 6}>{loading ? 'Verifica…' : 'Verifica'}</button>
            </div>
          </div>
        )}
        {step === 'done' && (
          <div className="phone-link-box" style={{ textAlign: 'center', gap: 16 }}>
            <CheckCircle2 size={48} style={{ color: 'var(--primary)', margin: '0 auto' }} />
            <p style={{ fontWeight: 700, fontSize: 16 }}>Numero verificato</p>
            <p className="field-hint">{phone} è ora collegato al tuo account.</p>
            <button className="btn btn-primary" onClick={onClose}>Chiudi</button>
          </div>
        )}
      </div>
    </div>
  );
}

// Genera token one-time e apre il PDF — evita il blocco "Non autenticato"
// che il browser riceverebbe aprendo direttamente l'URL protetto.
function BannerPdfButton({ submissionId }) {
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const handle = async () => {
    setLoading(true);
    try {
      const { token } = await api(`/compiler/submissions/${submissionId}/pdf-token`, { method: 'POST' });
      window.open(`/api/compiler/submissions/${submissionId}/pdf?token=${encodeURIComponent(token)}`, '_blank', 'noopener');
    } catch (err) {
      toast.error('Impossibile aprire il PDF: ' + err.message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <button className="btn btn-outline btn-sm ccb-pdf-btn" onClick={handle} disabled={loading} title="Apri PDF compilato">
      {loading ? <Loader2 size={13} className="spin" /> : <Download size={13} />} PDF
    </button>
  );
}

// ── Banner compilazioni moduli ─────────────────────────────────────────────

function CompilerBanner({ banner, onDismiss }) {
  const ts = new Date(banner.completedAt).toLocaleString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return (
    <div className="compiler-completion-banner">
      <div className="ccb-icon">
        <FileText size={15} />
      </div>
      <div className="ccb-body">
        <span className="ccb-title">Modulo compilato</span>
        <span className="ccb-form">{banner.formName}</span>
        {banner.email && <span className="ccb-email">da {banner.email}</span>}
        <span className="ccb-time">{ts}</span>
      </div>
      {banner.pdfAvailable && (
        <BannerPdfButton submissionId={banner.submissionId} />
      )}
      <button className="btn btn-ghost icon-btn ccb-close" onClick={() => onDismiss(banner.submissionId)}>
        <X size={13} />
      </button>
    </div>
  );
}

// ── Chat principale ────────────────────────────────────────────────────────

export default function Chat() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const modal = useModal();
  const { user } = useAuth();

  const [conversations, setConversations] = useState([]);
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]); // [{file, name, type, size, documentId?}]
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  // typing e messaggi non letti per ogni conversazione
  const [typingConvs, setTypingConvs] = useState(new Set()); // Set di convId in risposta
  const [unreadCounts, setUnreadCounts] = useState({}); // { convId: count }
  const [menuFor, setMenuFor] = useState(null);
  const [activityKey, setActivityKey] = useState(0);

  // WhatsApp
  const [waSyncId, setWaSyncId] = useState(null);
  const [waPhone, setWaPhone] = useState(null);
  const [phoneLinked, setPhoneLinked] = useState(false);

  // Banner compilazioni moduli PHI Compiler
  const [compilerBanners, setCompilerBanners] = useState([]);

  // Stato sidebar — persiste su localStorage per mantenere la preferenza al refresh
  const [showList, setShowList] = useState(() => {
    try { const v = localStorage.getItem('chat_showList'); return v === null ? true : v === '1'; } catch { return true; }
  });
  const [showRight, setShowRight] = useState(() => {
    try { const v = localStorage.getItem('chat_showRight'); return v === null ? true : v === '1'; } catch { return true; }
  });

  const toggleList = () => setShowList(s => {
    const next = !s;
    try { localStorage.setItem('chat_showList', next ? '1' : '0'); } catch {}
    return next;
  });
  const toggleRight = () => setShowRight(s => {
    const next = !s;
    try { localStorage.setItem('chat_showRight', next ? '1' : '0'); } catch {}
    return next;
  });
  const [showPhoneModal, setShowPhoneModal] = useState(false);

  // Training
  const [isTrainingChat, setIsTrainingChat] = useState(false);
  const [trainingLoading, setTrainingLoading] = useState(false);
  const [pendingLearning, setPendingLearning] = useState(null); // { msgId, content }
  const [applyingLearning, setApplyingLearning] = useState(false);

  const scrollRef = useRef(null);
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';

  // Ref a id e streaming per usarli nei callback degli event listener senza stale closures
  const idRef = useRef(id);
  const streamingRef = useRef(streaming);
  useEffect(() => { idRef.current = id; }, [id]);
  useEffect(() => { streamingRef.current = streaming; }, [streaming]);

  const loadConversations = useCallback(async (q = '') => {
    try {
      const { conversations } = await api(`/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      setConversations(conversations);
    } catch {}
  }, []);

  const loadPhoneStatus = useCallback(async () => {
    try {
      const { linked, verified, phone } = await api('/phone/status');
      setPhoneLinked(!!(linked && verified));
      if (linked && verified) {
        setWaPhone(phone);
        const { synced, conversationId } = await api('/whatsapp-chat/status');
        if (synced) setWaSyncId(conversationId);
        else setWaSyncId(null);
      }
    } catch {}
  }, []);

  useEffect(() => { loadConversations(); loadPhoneStatus(); }, [loadConversations, loadPhoneStatus]);

  useEffect(() => {
    if (!id) { setMessages([]); setIsTrainingChat(false); return; }
    api(`/conversations/${id}`)
      .then(({ conversation }) => setMessages(conversation.messages.filter(m => m.role !== 'system')))
      .catch(() => navigate('/chat'));
    if (isAdmin) {
      api(`/training-chat/${id}/status`).then(({ isTraining }) => setIsTrainingChat(isTraining)).catch(() => {});
    }
  }, [id, navigate, isAdmin]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamText]);

  // Messaggi WA in realtime
  useEffect(() => {
    const handler = (e) => {
      const { conversationId, role, content } = e.detail || {};
      if (conversationId === id) {
        setMessages((m) => [...m, { id: `wa-${Date.now()}`, role, content }]);
      }
    };
    window.addEventListener('sophia:wa:message', handler);
    return () => window.removeEventListener('sophia:wa:message', handler);
  }, [id]);

  // ── PHI Compiler: banner + azione AI automatica ─────────────────────────
  // sendSilent è definito come ref per evitare dipendenze circolari
  const sendSilentRef = useRef(null);

  useEffect(() => {
    const handler = async (e) => {
      const p = e.detail;

      // 1. Mostra banner nella chat
      setCompilerBanners((prev) => {
        // Evita duplicati (es. riconnessione socket)
        if (prev.some((b) => b.submissionId === p.submissionId)) return prev;
        return [
          {
            submissionId: p.submissionId,
            formName:     p.formName,
            email:        p.email,
            pdfAvailable: p.pdfAvailable,
            completedAt:  p.completedAt,
          },
          ...prev,
        ].slice(0, 5); // max 5 banner
      });

      // 2. Aggiungi al log attività nel pannello destro
      const tsLabel = new Date(p.completedAt).toLocaleString('it-IT', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      window.dispatchEvent(new CustomEvent('sophia:action', {
        detail: { label: `Modulo "${p.formName}" compilato`, time: tsLabel },
      }));

      // 3. Se c'è una conversazione aperta e non siamo in streaming,
      //    invia un messaggio di sistema per far eseguire le azioni all'AI
      if (sendSilentRef.current && idRef.current && !streamingRef.current) {
        const systemText =
          `[EVENTO SISTEMA — PHI Compiler] Il modulo "${p.formName}" è stato compilato` +
          (p.email ? ` da ${p.email}` : '') +
          ` alle ${tsLabel}.` +
          ` submissionId: ${p.submissionId}.` +
          ` Se in questa conversazione hai promesso di eseguire azioni dopo la compilazione, eseguile adesso.`;
        sendSilentRef.current(systemText);
      }
    };

    window.addEventListener('sophia:compiler:completed', handler);
    return () => window.removeEventListener('sophia:compiler:completed', handler);
  }, []); // dipendenze vuote — usa i ref per id e streaming

  const dismissBanner = (submissionId) => {
    setCompilerBanners((prev) => prev.filter((b) => b.submissionId !== submissionId));
  };

  const newConversation = async () => {
    const { conversation } = await api('/conversations', { method: 'POST' });
    await loadConversations();
    navigate(`/chat/${conversation.id}`);
  };

  const initWaSync = async () => {
    try {
      const { conversationId, phone } = await api('/whatsapp-chat/init', { method: 'POST' });
      setWaSyncId(conversationId);
      setWaPhone(phone);
      await loadConversations();
      navigate(`/chat/${conversationId}`);
      toast.info('Chat WhatsApp sincronizzata creata');
    } catch (err) { toast.error(err.message); }
  };

  const disconnectWaSync = async () => {
    if (!waSyncId) return;
    try {
      await api('/whatsapp-chat/disconnect', { method: 'POST' });
      setWaSyncId(null);
      await loadConversations();
      if (id === waSyncId) navigate('/chat');
      toast.info('Chat WhatsApp disconnessa');
    } catch (err) { toast.error(err.message); }
  };

  const unlinkPhone = async () => {
    const ok = await modal.confirm('Scollegare il numero? La chat sincronizzata verrà rimossa.', { danger: true });
    if (!ok) return;
    try {
      await api('/phone/unlink', { method: 'DELETE' });
      setPhoneLinked(false);
      setWaPhone(null);
      setWaSyncId(null);
      await loadConversations();
      if (id === waSyncId) navigate('/chat');
      toast.info('Numero scollegato');
    } catch (err) { toast.error(err.message); }
  };

  const onAttach = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachments((a) => [...a, { file, name: file.name, type: file.type, size: file.size, documentId: null }]);
    e.target.value = '';
  };
  const removeAttachment = (i) => setAttachments((a) => a.filter((_, idx) => idx !== i));

  const [sendingAttachments, setSendingAttachments] = useState(false);

  // ── Funzione di invio principale ─────────────────────────────────────────
  const send = async (overrideText) => {
    const text = (overrideText !== undefined ? overrideText : input).trim();
    if ((!text && attachments.length === 0) || streaming || sendingAttachments) return;

    let convId = id;
    let isNew = false;
    if (!convId) {
      const { conversation } = await api('/conversations', { method: 'POST' });
      convId = conversation.id;
      isNew = true;
    }

    // Carica i file allegati e raccoglie i documentId per passarli all'AI
    const uploadedDocs = [];
    const documentIds = [];
    if (attachments.length > 0 && overrideText === undefined) {
      setSendingAttachments(true);
      for (const att of attachments) {
        try {
          const { document: doc } = await upload('/documents', att.file);
          uploadedDocs.push(att.name);
          if (doc?.id) documentIds.push(doc.id);
        } catch (err) { toast.error(`Errore upload ${att.name}: ${err.message}`); }
      }
      setSendingAttachments(false);
    }

    const finalText = text || (uploadedDocs.length ? `[Allegati: ${uploadedDocs.join(', ')}]` : '');
    const tmpMsg = { id: `tmp-${Date.now()}`, role: 'user', content: finalText };

    if (overrideText === undefined) {
      setInput('');
      setAttachments([]);
    }
    setMessages((m) => [...m, tmpMsg]);
    setStreaming(true);
    setStreamText('');

    if (isNew) navigate(`/chat/${convId}`, { replace: false });

    setTypingConvs((s) => { const n = new Set(s); n.add(convId); return n; });

    let acc = '';
    await streamMessage(convId, finalText, documentIds, {
      onToken: (delta) => { acc += delta; setStreamText(acc); },
      onTool: (call) => {
        const label = friendlyToolLabel(call.name);
        window.dispatchEvent(new CustomEvent('sophia:action', {
          detail: { label, time: new Date().toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) },
        }));
        if (call.name === 'schedule_recurring_action' || call.name === 'cancel_recurring_action') setActivityKey((k) => k + 1);
      },
      onDone: async (payload) => {
        const aiMsg = { id: `a-${Date.now()}`, role: 'assistant', content: acc, toolCalls: payload?.toolCalls || [] };
        setMessages((m) => [...m, aiMsg]);
        setStreamText('');
        setStreaming(false);
        setTypingConvs((s) => { const n = new Set(s); n.delete(convId); return n; });
        if (convId !== id) {
          setUnreadCounts((u) => ({ ...u, [convId]: (u[convId] || 0) + 1 }));
        }
        loadConversations(query);
        setActivityKey((k) => k + 1);
        if (isTrainingChat && acc.length > 30) setPendingLearning({ msgId: aiMsg.id, content: acc });
      },
      onError: (err) => {
        setStreaming(false); setStreamText('');
        setTypingConvs((s) => { const n = new Set(s); n.delete(convId); return n; });
        if (convId !== id) {
          setUnreadCounts((u) => ({ ...u, [convId]: (u[convId] || 0) + 1 }));
        }
        toast.error(err.message || 'Errore durante la risposta');
      },
    });
  };

  // Registra il ref per l'invio silenzioso (usato dal listener compiler)
  useEffect(() => {
    sendSilentRef.current = (text) => send(text);
  });

  const [recording, setRecording] = useState(false);
  const recRef = useRef(null);

  const startVoice = () => {
    if (recording) {
      recRef.current?.stop();
      setRecording(false);
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast.error('Riconoscimento vocale non supportato dal browser');
    try {
      const rec = new SR();
      recRef.current = rec;
      rec.lang = 'it-IT';
      rec.interimResults = false;
      rec.continuous = false;
      rec.onstart = () => setRecording(true);
      rec.onresult = (ev) => {
        const transcript = ev.results[0][0].transcript;
        setInput((v) => `${v} ${transcript}`.trim());
      };
      rec.onerror = (ev) => {
        if (ev.error !== 'aborted') toast.error('Microfono: ' + ev.error);
        setRecording(false);
      };
      rec.onend = () => setRecording(false);
      rec.start();
    } catch (err) {
      toast.error('Impossibile avviare il microfono: ' + err.message);
      setRecording(false);
    }
  };

  const rename = async (conv) => {
    const title = await modal.prompt('Nuovo nome della chat', { title: 'Rinomina', defaultValue: conv.title });
    if (!title) return;
    await api(`/conversations/${conv.id}`, { method: 'PATCH', body: { title } });
    loadConversations(query); setMenuFor(null);
  };
  const remove = async (conv) => {
    await api(`/conversations/${conv.id}`, { method: 'DELETE' });
    loadConversations(query); setMenuFor(null);
    if (conv.id === id) navigate('/chat');
  };

  const toggleTrainingMode = async () => {
    if (!id) return;
    setTrainingLoading(true);
    try {
      if (isTrainingChat) {
        await api(`/training-chat/${id}/stop`, { method: 'POST' });
        setIsTrainingChat(false);
        toast.info('Modalità addestramento disattivata');
      } else {
        await api(`/training-chat/${id}/start`, { method: 'POST' });
        setIsTrainingChat(true);
        setMessages([]);
        toast.info('Chat svuotata — modalità addestramento attiva');
      }
    } catch (err) { toast.error(err.message); } finally { setTrainingLoading(false); }
  };

  const applyLearning = async () => {
    if (!pendingLearning) return;
    setApplyingLearning(true);
    try {
      const { field } = await api(`/training-chat/${id}/apply`, {
        method: 'POST',
        body: { learning: pendingLearning.content, field: 'mainPrompt' },
      });
      setPendingLearning(null);
      toast.info('Prompt di addestramento aggiornato');
    } catch (err) { toast.error(err.message); } finally { setApplyingLearning(false); }
  };

  return (
    <div className="chat-layout">
      {showPhoneModal && (
        <PhoneLinkModal
          onClose={() => setShowPhoneModal(false)}
          onLinked={async (ph) => { setPhoneLinked(true); setWaPhone(ph); setShowPhoneModal(false); await loadPhoneStatus(); }}
        />
      )}

      {/* ── Sidebar sinistra ── */}
      <aside className={`chat-list${showList ? '' : ' chat-list-collapsed'}`}>
        <div className="chat-list-inner">
        {showList && (<>
        <div className="chat-list-head">
          <button className="btn btn-primary new-chat" onClick={newConversation}>
            <Plus size={16} /> Nuova conversazione
          </button>
          <div className="chat-search">
            <Search size={15} className="search-icon" />
            <input className="input" placeholder="Cerca chat" value={query}
              onChange={(e) => { setQuery(e.target.value); loadConversations(e.target.value); }} />
          </div>
          {conversations.length > 0 && (
            <button className="btn-delete-all-chats" title="Elimina tutte le chat" onClick={async () => {
              const ok = await modal.confirm(`Eliminare tutte le ${conversations.length} conversazioni? L'operazione è irreversibile.`, { danger: true });
              if (!ok) return;
              try {
                await api('/conversations/all', { method: 'DELETE' });
                setMessages([]); setConversations([]); navigate('/chat');
                toast.info('Tutte le chat eliminate');
              } catch (err) { toast.error(err.message); }
            }}>
              <Trash2 size={14}/> Elimina tutte
            </button>
          )}
        </div>

        <div className="chat-history">
          {/* Chat WA sincronizzata in cima con bordo verde */}
          {waSyncId && conversations.find(c => c.id === waSyncId) && (
            <div className={`chat-item wa-synced ${waSyncId === id ? 'active' : ''}`}>
              <button className="chat-item-main" onClick={() => navigate(`/chat/${waSyncId}`)}>
                <MessageCircle size={13} className="wa-icon" />
                <span>WhatsApp — {waPhone}</span>
              </button>
            </div>
          )}
          {conversations.filter(c => c.id !== waSyncId).map((c) => {
            const isTyping = typingConvs.has(c.id) && c.id !== id;
            const unread = unreadCounts[c.id] || 0;
            return (
              <div key={c.id} className={`chat-item ${c.id === id ? 'active' : ''}`}
                onClick={() => {
                  navigate(`/chat/${c.id}`);
                  setUnreadCounts((u) => ({ ...u, [c.id]: 0 }));
                }}>
                <button className="chat-item-main">
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                  {isTyping && <span className="conv-typing-dot" title="Risposta in arrivo" />}
                  {unread > 0 && !isTyping && <span className="conv-unread-badge">{unread}</span>}
                </button>
                <button className="chat-item-menu" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === c.id ? null : c.id); }}>
                  <MoreVertical size={16} />
                </button>
                {menuFor === c.id && (
                  <div className="dropdown">
                    <button onClick={() => rename(c)}><Pencil size={14} /> Rinomina</button>
                    <button className="danger" onClick={() => remove(c)}><Trash2 size={14} /> Elimina</button>
                  </div>
                )}
              </div>
            );
          })}
          {conversations.length === 0 && <p className="empty small">Nessuna conversazione.</p>}
        </div>
        </>)}
        </div>{/* end chat-list-inner */}
      </aside>

      {/* Toggle sinistra: sempre visibile, fuori dal flusso delle sidebar */}
      <button className="sidebar-toggle sidebar-toggle-left" onClick={toggleList} title={showList ? 'Chiudi lista' : 'Apri lista'}>
        {showList ? <PanelLeftClose size={14}/> : <PanelLeftOpen size={14}/>}
      </button>

      {/* ── Area chat centrale ── */}
      <section className="chat-main">

        {/* ── Banner compilazioni moduli ── */}
        {compilerBanners.length > 0 && (
          <div className="compiler-banners-area">
            {compilerBanners.map((b) => (
              <CompilerBanner key={b.submissionId} banner={b} onDismiss={dismissBanner} />
            ))}
          </div>
        )}

        <div className="chat-messages" ref={scrollRef}>
          {messages.length === 0 && !streaming && (
            <div className="chat-empty">
              <h2>Come posso aiutarti oggi?</h2>
              <p>Fai una domanda, allega un documento o usa la voce.</p>
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} role={m.role} content={m.content} toolCalls={m.toolCalls}
              conversationId={id} toast={toast} navigate={navigate}
              pendingLearning={m.role === 'assistant' && pendingLearning?.msgId === m.id ? pendingLearning : null}
              applyingLearning={applyingLearning}
              onApplyLearning={applyLearning}
              onDismissLearning={() => setPendingLearning(null)}
            />
          ))}
          {streaming && <Message role="assistant" content={streamText} typing={!streamText} />}
        </div>

        {attachments.length > 0 && (
          <div className="attachments-preview">
            {attachments.map((att, i) => (
              <div key={i} className="attachment-chip">
                <Paperclip size={12} />
                <span>{att.name}</span>
                <span className="att-size">({fmtBytes(att.size)})</span>
                <button onClick={() => removeAttachment(i)}><X size={12} /></button>
              </div>
            ))}
          </div>
        )}

        <div className="composer">
          {id && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px 0' }}>
              <AgentSelector conversationId={id} />
            </div>
          )}
          <div className="composer-box">
            <textarea className="composer-input"
              placeholder={attachments.length ? 'Aggiungi un messaggio (opzionale)…' : 'Scrivi un messaggio…'}
              value={input} rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <div className="composer-actions">
              <label className="icon-btn" title="Allega file">
                <Paperclip size={18} strokeWidth={1.75} />
                <input type="file" hidden onChange={onAttach} accept=".pdf,.docx,.txt,.md,.json,.yaml,.yml,image/*" />
              </label>
              <button className={`icon-btn${recording ? ' icon-btn-recording' : ''}`} title={recording ? 'Stop registrazione' : 'Microfono'} onClick={startVoice}>
                <Mic size={18} strokeWidth={1.75} />
              </button>
              <button className="icon-btn send" title="Invia" onClick={() => send()}
                disabled={streaming || sendingAttachments || (!input.trim() && attachments.length === 0)}>
                {sendingAttachments ? <Loader2 size={18} className="spin"/> : <Send size={18} strokeWidth={1.75} />}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Toggle destra: sempre visibile, fuori dal flusso del pannello */}
      <button className="sidebar-toggle sidebar-toggle-right" onClick={toggleRight} title={showRight ? 'Chiudi pannello' : 'Apri pannello'}>
        {showRight ? <PanelRightClose size={14}/> : <PanelRightOpen size={14}/>}
      </button>

      {/* ── Pannello destro ── */}
      <RightPanel
        className={showRight ? '' : 'collapsed'}
        onToggleRight={() => setShowRight(s => !s)}
        conversationId={id}
        refreshKey={activityKey}
        phoneLinked={phoneLinked}
        waPhone={waPhone}
        waSyncId={waSyncId}
        currentConvId={id}
        onLinkPhone={() => setShowPhoneModal(true)}
        onUnlinkPhone={unlinkPhone}
        onInitWaSync={initWaSync}
        onDisconnectWaSync={disconnectWaSync}
        isAdmin={isAdmin}
        isTrainingChat={isTrainingChat}
        trainingLoading={trainingLoading}
        onToggleTraining={toggleTrainingMode}
      />
    </div>
  );
}

function friendlyToolLabel(name) {
  const map = {
    call_endpoint: 'Chiamata API', list_endpoints: 'Elenco endpoint',
    send_email: 'Invio email', send_whatsapp: 'Invio WhatsApp',
    schedule_recurring_action: 'Attività programmata', cancel_recurring_action: 'Attività annullata',
    schedule_once: 'Azione programmata', list_recurring_actions: 'Controllo attività',
    'gemini__query_manual': 'Interrogazione manuale Gemini',
    'images__generate': 'Generazione immagine', 'contacts__save_contact': 'Contatto aggiornato',
    'calendar__create_event': 'Evento creato', 'cloud__find_documents': 'Documenti trovati',
    'compiler__send_form': 'Modulo inviato', 'compiler__list_forms': 'Elenco moduli',
    'compiler__get_submissions': 'Compilazioni recuperate',
    'tasks__switch_agent': 'Cambio agente', 'tasks__delegate_to_agent': 'Delega ad agente',
    'tasks__list_agents': 'Elenco agenti',
  };
  return map[name] || name.replace(/_/g, ' ');
}

// Estrae URL di immagini generate dai tool calls
function extractNavActions(toolCalls) {
  const seen = new Set();
  const actions = [];
  for (const tc of toolCalls || []) {
    const r = tc.result;
    if (r?.navigateTo && !seen.has(r.navigateTo)) {
      seen.add(r.navigateTo);
      actions.push({ to: r.navigateTo, label: r.navigateLabel || 'Apri' });
    }
  }
  return actions;
}

function extractGeneratedImages(toolCalls) {
  const urls = [];
  for (const tc of toolCalls || []) {
    if (tc.name === 'images__generate' && tc.result?.url) urls.push(tc.result.url);
  }
  return urls;
}

// Verifica se qualche tool call sta ancora caricando (immagini)
function hasGeneratingImage(toolCalls) {
  return (toolCalls || []).some(tc => tc.name === 'images__generate' && !tc.result);
}

function Message({ role, content, typing, toolCalls, conversationId, toast, navigate, pendingLearning, applyingLearning, onApplyLearning, onDismissLearning }) {
  const isUser = role === 'user';
  const [scheduled, setScheduled] = useState(false);

  const suggestion = (toolCalls || []).map((t) => t.result?.suggestAction).find((s) => s?.type === 'schedule_retry');
  const generatedImages = extractGeneratedImages(toolCalls);
  const generatingImage = hasGeneratingImage(toolCalls);
  const navActions = extractNavActions(toolCalls);

  const scheduleRetry = async () => {
    try {
      await api('/tasks', { method: 'POST', body: { kind: 'RETRY', conversationId, endpointId: suggestion.endpointId, endpointName: suggestion.endpointName, variables: suggestion.variables, delaySeconds: suggestion.delaySeconds } });
      setScheduled(true);
      toast?.info('Riproverò automaticamente in background.');
    } catch (err) { toast?.error(err.message || 'Impossibile impostare il task'); }
  };

  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-ai'}`}>
      <div className="msg-avatar">{isUser ? 'TU' : 'S'}</div>
      <div className="msg-body">
        {typing ? <div className="typing"><span /><span /><span /></div>
          : isUser ? <p className="msg-text">{content}</p>
          : <Markdown content={content} />}
        {/* Immagini generate in-line */}
        {generatingImage && (
          <div className="img-generating">
            <div className="typing"><span/><span/><span/></div>
            <span>Generazione immagine in corso…</span>
          </div>
        )}
        {generatedImages.map((url, i) => (
          <div key={i} className="msg-img-bubble">
            <img src={url} alt="Immagine generata" loading="lazy" />
            <div className="msg-img-actions">
              <a href={url} download={`immagine-${i+1}.png`} className="msg-img-dl" target="_blank" rel="noopener">
                <Download size={13}/> Scarica
              </a>
              <a href={url} target="_blank" rel="noopener" className="msg-img-dl">
                <ExternalLink size={13}/> Apri
              </a>
            </div>
          </div>
        ))}
        {suggestion && !scheduled && (
          <div className="msg-action" style={{ marginTop: 8 }}>
            <button className="btn btn-ghost" onClick={scheduleRetry}>{suggestion.message}</button>
          </div>
        )}
        {scheduled && <p className="empty small" style={{ marginTop: 6 }}>Riproverò automaticamente.</p>}
        {navActions.length > 0 && (
          <div className="msg-nav-actions">
            {navActions.map((a, i) => (
              <button key={i} className="msg-nav-btn" onClick={() => navigate(a.to)}>
                <ExternalLink size={13}/> {a.label}
              </button>
            ))}
          </div>
        )}
        {pendingLearning && (
          <div className="learning-suggestion">
            <div className="ls-label">Questa risposta contiene istruzioni utili. Vuoi applicarla al prompt di addestramento?</div>
            <div className="ls-actions">
              <button className="btn btn-primary btn-sm" onClick={onApplyLearning} disabled={applyingLearning}>
                {applyingLearning ? (
                  <><span className="learning-spinner" /> Rielaborazione in corso…</>
                ) : 'Applica al prompt'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={onDismissLearning} disabled={applyingLearning}>Ignora</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
