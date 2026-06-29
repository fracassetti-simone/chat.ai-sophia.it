import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Mail, Plus, RefreshCw, Send, Bot, Paperclip, X, ChevronLeft,
  Settings, Pen, Save, Eye, EyeOff, Trash2, Inbox, Search,
  Star, Circle, CheckCircle, Filter, UserRound, ExternalLink,
} from 'lucide-react';
import { api, uploadFile } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';

// ─── Helpers ────────────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const now = new Date();
  const isToday = dt.toDateString() === now.toDateString();
  return isToday
    ? dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    : dt.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
}

function initials(name, email) {
  const s = name || email || '?';
  const parts = s.split(/[\s@]/);
  return (parts[0]?.[0] || '') + (parts[1]?.[0] || parts[0]?.[1] || '');
}

// ─── Account Form Modal ──────────────────────────────────────────────────────
function AccountForm({ account, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: '', email: '',
    smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpPass: '',
    imapHost: '', imapPort: 993, imapSecure: true, imapUser: '', imapPass: '',
    aiAutoReply: true, aiReplyFilter: [],
    ...(account || {}),
  });
  const [saving, setSaving] = useState(false);
  const [filterInput, setFilterInput] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const addFilter = () => {
    const e = filterInput.trim().toLowerCase();
    if (!e) return;
    set('aiReplyFilter', [...(form.aiReplyFilter || []), e]);
    setFilterInput('');
  };

  const save = async () => {
    if (!form.name || !form.email || !form.smtpHost || !form.smtpUser || !form.smtpPass)
      return toast.error('Compila almeno nome, email e dati SMTP');
    setSaving(true);
    try {
      if (account?.id) await api(`/email/accounts/${account.id}`, { method: 'PATCH', body: form });
      else await api('/email/accounts', { method: 'POST', body: form });
      toast.info(account?.id ? 'Account aggiornato' : 'Account aggiunto');
      onSaved();
    } catch (err) { toast.error(err.message); setSaving(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" style={{ maxWidth: 600 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head-row">
          <h2 className="modal-title" style={{ margin: 0 }}>{account?.id ? 'Modifica account' : 'Aggiungi account email'}</h2>
          <button className="btn btn-ghost icon-btn" onClick={onClose}><X size={18}/></button>
        </div>
        <div className="form-grid">
          <div className="field field-full"><label>Etichetta</label><input className="input" value={form.name} onChange={e=>set('name',e.target.value)} placeholder="Es. Supporto"/></div>
          <div className="field field-full"><label>Indirizzo email</label><input className="input" type="email" value={form.email} onChange={e=>set('email',e.target.value)}/></div>
          <div className="field field-full"><label className="section-label">SMTP (invio)</label></div>
          <div className="field"><label>Host</label><input className="input" value={form.smtpHost} onChange={e=>set('smtpHost',e.target.value)} placeholder="smtp.gmail.com"/></div>
          <div className="field"><label>Porta</label><input className="input" type="number" value={form.smtpPort} onChange={e=>set('smtpPort',+e.target.value)}/></div>
          <div className="field"><label>Utente</label><input className="input" value={form.smtpUser} onChange={e=>set('smtpUser',e.target.value)}/></div>
          <div className="field"><label>Password</label><input className="input" type="password" value={form.smtpPass} onChange={e=>set('smtpPass',e.target.value)}/></div>
          <div className="field field-full"><label className="section-label">IMAP (ricezione)</label></div>
          <div className="field"><label>Host IMAP</label><input className="input" value={form.imapHost||''} onChange={e=>set('imapHost',e.target.value)} placeholder="imap.gmail.com"/></div>
          <div className="field"><label>Porta</label><input className="input" type="number" value={form.imapPort||993} onChange={e=>set('imapPort',+e.target.value)}/></div>
          <div className="field"><label>Utente IMAP</label><input className="input" value={form.imapUser||''} onChange={e=>set('imapUser',e.target.value)}/></div>
          <div className="field"><label>Password IMAP</label><input className="input" type="password" value={form.imapPass||''} onChange={e=>set('imapPass',e.target.value)}/></div>
          <div className="field field-full">
            <label className="toggle-row" style={{gap:10}}>
              <span style={{flex:1}}><strong>Risposta automatica AI</strong><br/><span className="field-hint">L'AI risponde automaticamente alle email in arrivo</span></span>
              <input type="checkbox" checked={!!form.aiAutoReply} onChange={e=>set('aiAutoReply',e.target.checked)}/>
            </label>
          </div>
          {form.aiAutoReply && (
            <div className="field field-full">
              <label>Escludi da risposta automatica <span className="field-hint">— indirizzi o domini (es. noreply@, @spam.com)</span></label>
              <div style={{display:'flex',gap:6,marginBottom:6}}>
                <input className="input" value={filterInput} onChange={e=>setFilterInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addFilter()} placeholder="es. noreply@ oppure @newsletter.com"/>
                <button className="btn btn-outline btn-sm" onClick={addFilter}>Aggiungi</button>
              </div>
              <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                {(form.aiReplyFilter||[]).map((f,i)=>(
                  <span key={i} className="tag-chip">{f}<button onClick={()=>set('aiReplyFilter',(form.aiReplyFilter||[]).filter((_,j)=>j!==i))}><X size={11}/></button></span>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving?'Salvo…':'Salva'}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Compose Modal ───────────────────────────────────────────────────────────
function ComposeModal({ accounts, onClose, onSent, replyTo }) {
  const toast = useToast();
  const [form, setForm] = useState({
    accountId: accounts[0]?.id || '',
    to: replyTo?.fromEmail || '',
    subject: replyTo ? `Re: ${replyTo.subject}` : '',
    text: '',
  });
  const [sending, setSending] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const send = async () => {
    if (!form.to || !form.subject || !form.text) return toast.error('Compila tutti i campi');
    setSending(true);
    try {
      if (replyTo) {
        await api(`/email/threads/${replyTo.id}/reply`, { method: 'POST', body: { text: form.text } });
      } else {
        await api('/email/send', { method: 'POST', body: form });
      }
      toast.info('Email inviata'); onSent();
    } catch (err) { toast.error(err.message); setSending(false); }
  };

  return (
    <div className="em-compose-overlay">
      <div className="em-compose-card card">
        <div className="em-compose-head">
          <span>{replyTo ? `Rispondi a ${replyTo.fromEmail}` : 'Nuova email'}</span>
          <button className="btn btn-ghost icon-btn" onClick={onClose}><X size={16}/></button>
        </div>
        {!replyTo && accounts.length > 1 && (
          <div className="em-compose-row">
            <span>Da</span>
            <select className="input em-compose-input" value={form.accountId} onChange={e=>set('accountId',e.target.value)}>
              {accounts.map(a=><option key={a.id} value={a.id}>{a.name} &lt;{a.email}&gt;</option>)}
            </select>
          </div>
        )}
        <div className="em-compose-row">
          <span>A</span>
          <input className="input em-compose-input" type="email" value={form.to} onChange={e=>set('to',e.target.value)} placeholder="destinatario@email.com"/>
        </div>
        {!replyTo && (
          <div className="em-compose-row">
            <span>Oggetto</span>
            <input className="input em-compose-input" value={form.subject} onChange={e=>set('subject',e.target.value)}/>
          </div>
        )}
        <textarea className="em-compose-body" value={form.text} onChange={e=>set('text',e.target.value)} placeholder="Scrivi il messaggio…"/>
        <div className="em-compose-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={send} disabled={sending}><Send size={14}/> {sending?'Invio…':'Invia'}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Thread Detail ───────────────────────────────────────────────────────────
function ThreadDetail({ thread, onBack, onReply, accounts }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setLoading(true);
    api(`/email/threads/${thread.id}`).then(r => {
      setMessages(r.thread.messages || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [thread.id]);

  const aiReply = async () => {
    setAiLoading(true);
    try {
      await api(`/email/threads/${thread.id}/ai-reply`, { method: 'POST', body: {} });
      toast.info('Risposta AI inviata');
      // Ricarica messaggi
      api(`/email/threads/${thread.id}`).then(r => setMessages(r.thread.messages || []));
    } catch (err) { toast.error(err.message); } finally { setAiLoading(false); }
  };

  if (loading) return <div className="skeleton" style={{height:300}}/>;

  return (
    <div className="em-detail">
      <div className="em-detail-head">
        <button className="btn btn-ghost" onClick={onBack}><ChevronLeft size={16}/></button>
        <div className="em-detail-subject">{thread.subject}</div>
        <div style={{display:'flex',gap:6,marginLeft:'auto'}}>
          <button className="btn btn-outline btn-sm" onClick={() => onReply(thread)}>
            <Pen size={14}/> Rispondi
          </button>
          <button className="btn btn-outline btn-sm" onClick={aiReply} disabled={aiLoading}>
            <Bot size={14}/> {aiLoading ? 'AI…' : 'Risposta AI'}
          </button>
        </div>
      </div>

      <div className="em-messages">
        {messages.map((m, i) => (
          <div key={m.id} className={`em-msg em-msg-${m.role}`}>
            <div className="em-msg-avatar">{initials(m.fromName, m.fromEmail).toUpperCase().slice(0,2)}</div>
            <div className="em-msg-body">
              <div className="em-msg-head">
                <span className="em-msg-from">{m.fromName || m.fromEmail}</span>
                <span className="em-msg-addr">&lt;{m.fromEmail}&gt;</span>
                <span className="em-msg-time">{fmtDate(m.createdAt)}</span>
                {m.role !== 'inbound' && <span className="badge badge-on" style={{fontSize:10,marginLeft:6}}>{m.role==='ai'?'AI':'Inviata'}</span>}
              </div>
              <div className="em-msg-text" dangerouslySetInnerHTML={
                m.bodyHtml
                  ? { __html: m.bodyHtml }
                  : { __html: (m.bodyText||'').replace(/\n/g,'<br>') }
              }/>
              {Array.isArray(m.attachments) && m.attachments.length > 0 && (
                <div className="em-msg-attachments">
                  {m.attachments.map((a,j)=>(
                    <span key={j} className="tag-chip"><Paperclip size={11}/> {a.filename||'Allegato'}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Email Page ─────────────────────────────────────────────────────────
export default function EmailPage() {
  const toast = useToast();
  const modal = useModal();

  const [accounts, setAccounts] = useState(null);
  const [threads, setThreads] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [activeThread, setActiveThread] = useState(null);
  const [compose, setCompose] = useState(null); // null | {} | {replyTo}
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [editAccount, setEditAccount] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [filterUnread, setFilterUnread] = useState(false);

  const loadAccounts = useCallback(() =>
    api('/email/accounts').then(r => {
      setAccounts(r.accounts);
      if (r.accounts.length && !selectedAccountId) setSelectedAccountId(r.accounts[0].id);
    }).catch(() => setAccounts([])),
  [selectedAccountId]);

  const loadThreads = useCallback(() => {
    const qs = new URLSearchParams();
    if (selectedAccountId) qs.set('accountId', selectedAccountId);
    if (search) qs.set('q', search);
    if (filterUnread) qs.set('unread', 'true');
    api(`/email/threads?${qs}`).then(r => setThreads(r.threads || [])).catch(() => {});
  }, [selectedAccountId, search, filterUnread]);

  useEffect(() => { loadAccounts(); }, []);
  useEffect(() => { if (accounts?.length) loadThreads(); }, [loadThreads, accounts]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => { if (accounts?.length) loadThreads(); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const sync = async (accountId) => {
    setSyncing(true);
    try {
      const { newMessages } = await api(`/email/accounts/${accountId || selectedAccountId}/sync`, { method: 'POST', body: {} });
      toast.info(newMessages ? `${newMessages} nuov${newMessages===1?'a':'e'} email ricevuta${newMessages===1?'':'e'}` : 'Nessuna nuova email');
      loadThreads();
    } catch (err) { toast.error(err.message); } finally { setSyncing(false); }
  };

  const deleteAccount = async (acc) => {
    const ok = await modal.confirm(`Eliminare l'account ${acc.email}?`, { danger: true });
    if (!ok) return;
    try { await api(`/email/accounts/${acc.id}`, { method: 'DELETE' }); loadAccounts(); }
    catch (err) { toast.error(err.message); }
  };

  if (!accounts) return <div className="skeleton" style={{height:400}}/>;

  if (!accounts.length) return (
    <div>
      <h1 className="page-title">Email</h1>
      <div className="card empty-state" style={{marginTop:24}}>
        <div className="empty-icon"><Mail size={28} strokeWidth={1.5}/></div>
        <h3>Nessun account configurato</h3>
        <p>Aggiungi un account SMTP/IMAP per sincronizzare la posta.</p>
        <button className="btn btn-primary" style={{marginTop:16}} onClick={()=>setShowAccountForm(true)}><Plus size={16}/> Aggiungi account</button>
      </div>
      {showAccountForm && <AccountForm onClose={()=>setShowAccountForm(false)} onSaved={()=>{setShowAccountForm(false);loadAccounts();}}/>}
    </div>
  );

  return (
    <div className="em-layout">

      {/* ── Sidebar ── */}
      <aside className="em-sidebar">
        <button className="btn btn-primary em-compose-btn" onClick={()=>setCompose({})}>
          <Plus size={15}/> Scrivi
        </button>

        {accounts.map(acc => (
          <div key={acc.id} className={`em-account${selectedAccountId===acc.id?' active':''}`} onClick={()=>{setSelectedAccountId(acc.id);setActiveThread(null);}}>
            <div className="em-account-dot" style={{background: acc.enabled ? 'var(--primary)' : 'var(--gray-300)'}}/>
            <div className="em-account-info">
              <div className="em-account-name">{acc.name}</div>
              <div className="em-account-email">{acc.email}</div>
            </div>
            <div className="em-account-actions" onClick={e=>e.stopPropagation()}>
              <button className="icon-btn-sm" title="Sincronizza" onClick={()=>sync(acc.id)} disabled={syncing}>
                <RefreshCw size={12} className={syncing?'spin':''}/>
              </button>
              <button className="icon-btn-sm" title="Impostazioni" onClick={()=>{setEditAccount(acc);setShowAccountForm(true);}}>
                <Settings size={12}/>
              </button>
              <button className="icon-btn-sm danger" title="Elimina" onClick={()=>deleteAccount(acc)}>
                <Trash2 size={12}/>
              </button>
            </div>
          </div>
        ))}

        <button className="em-add-account" onClick={()=>setShowAccountForm(true)}>
          <Plus size={13}/> Aggiungi account
        </button>

        <div className="em-sidebar-divider"/>
        <div className="em-sidebar-folder active"><Inbox size={14}/> Posta in arrivo</div>
      </aside>

      {/* ── Thread list ── */}
      <div className="em-thread-list">
        <div className="em-list-toolbar">
          <div className="em-search">
            <Search size={14}/>
            <input placeholder="Cerca email…" value={search} onChange={e=>setSearch(e.target.value)}/>
            {search && <button onClick={()=>setSearch('')}><X size={12}/></button>}
          </div>
          <button className={`em-filter-btn${filterUnread?' active':''}`} onClick={()=>setFilterUnread(f=>!f)} title="Solo non lette">
            <Circle size={14}/> Non lette
          </button>
          <button className="icon-btn-sm" onClick={loadThreads} title="Aggiorna">
            <RefreshCw size={14}/>
          </button>
        </div>

        {threads.length === 0 ? (
          <div className="em-empty">
            <Inbox size={28} strokeWidth={1.5}/>
            <p>Nessuna email. Premi <strong>Sincronizza</strong> sull'account per scaricare la posta.</p>
          </div>
        ) : threads.map(t => (
          <button key={t.id}
            className={`em-thread-item${!t.isRead?' unread':''}${activeThread?.id===t.id?' selected':''}`}
            onClick={()=>setActiveThread(t)}>
            <div className="em-thread-avatar">
              {!t.isRead && <span className="em-unread-dot"/>}
              {initials(t.fromName, t.fromEmail).toUpperCase().slice(0,2)}
            </div>
            <div className="em-thread-info">
              <div className="em-thread-row1">
                <span className="em-thread-from">{t.fromName || t.fromEmail}</span>
                <span className="em-thread-time">{fmtDate(t.lastMessageAt)}</span>
              </div>
              <div className="em-thread-subject">{t.subject}</div>
              <div className="em-thread-preview">{t.messages?.[0]?.bodyText?.slice(0,100) || ''}</div>
            </div>
          </button>
        ))}
      </div>

      {/* ── Detail pane ── */}
      <div className="em-detail-pane">
        {activeThread ? (
          <ThreadDetail
            thread={activeThread}
            onBack={()=>setActiveThread(null)}
            onReply={(t)=>setCompose({replyTo:t})}
            accounts={accounts}
          />
        ) : (
          <div className="em-empty em-empty-detail">
            <Mail size={40} strokeWidth={1.25}/>
            <p>Seleziona un'email per leggerla</p>
          </div>
        )}
      </div>

      {/* Modals */}
      {showAccountForm && (
        <AccountForm account={editAccount} onClose={()=>{setShowAccountForm(false);setEditAccount(null);}} onSaved={()=>{setShowAccountForm(false);setEditAccount(null);loadAccounts();}}/>
      )}
      {compose !== null && (
        <ComposeModal accounts={accounts} replyTo={compose.replyTo} onClose={()=>setCompose(null)} onSent={()=>{setCompose(null);loadThreads();}}/>
      )}
    </div>
  );
}
