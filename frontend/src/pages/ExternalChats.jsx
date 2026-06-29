import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Search, Send, MessageCircle, Image, FileText, Mic, Video, Phone,
  MoreVertical, Trash2, Plus, Paperclip, X,
} from 'lucide-react';
import { api, uploadMedia } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';
import Markdown from '../components/Markdown.jsx';
import AgentSelector from '../components/AgentSelector.jsx';

const SOURCE_LABELS = { WHATSAPP: 'WhatsApp', WIDGET: 'Widget' };

function fmtTime(d) {
  if (!d) return '';
  const date = new Date(d);
  const isToday = date.toDateString() === new Date().toDateString();
  if (isToday) return date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtBytes(b) {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentView({ att }) {
  const [err, setErr] = useState(false);
  if (!att) return null;
  const url = att.url?.startsWith('/') ? att.url : null;

  if (att.type === 'image') {
    if (!url || err) return <div className="ext-att-placeholder"><Image size={14} /><span>{att.filename || 'Immagine'}</span></div>;
    return <img src={url} alt="" className="ext-msg-image" onError={() => setErr(true)} />;
  }
  if (att.type === 'audio') {
    return (
      <div>
        {url ? <audio controls src={url} className="ext-msg-audio" /> : <div className="ext-att-placeholder"><Mic size={14} /><span>Audio vocale</span></div>}
        {att.transcription && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0', fontStyle: 'italic' }}>
            "{att.transcription}"
          </p>
        )}
      </div>
    );
  }
  if (att.type === 'video') {
    return url ? <video controls src={url} className="ext-msg-video" /> : <div className="ext-att-placeholder"><Video size={14} /><span>Video</span></div>;
  }
  return (
    <div className="ext-att-placeholder">
      <FileText size={14} />
      {url ? <a href={url} target="_blank" rel="noopener noreferrer">{att.filename || 'Documento'}</a>
           : <span>{att.filename || 'Documento'}</span>}
    </div>
  );
}

function MessageBubble({ msg }) {
  const isCustomer = msg.role === 'customer';
  const isOperator = msg.role === 'operator';
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  const text = msg.content || '';
  const isPending = text.startsWith('[In attesa]');
  const displayText = isPending ? text.replace('[In attesa] ', '') : text;
  const isSystem = text.startsWith('[Template:') || text.startsWith('[Immagine]') || text.startsWith('[Audio]') || text.startsWith('[Video]') || text.startsWith('[Documento');

  return (
    <div className={`ext-msg ${isCustomer ? 'ext-msg-customer' : isOperator ? 'ext-msg-operator' : 'ext-msg-ai'}`}>
      <div className="ext-msg-bubble" style={isPending ? { opacity: 0.7 } : {}}>
        {atts.map((att, i) => <AttachmentView key={i} att={att} />)}
        {!isSystem && displayText && (
          isCustomer || isOperator
            ? <p className="ext-msg-text">{displayText}</p>
            : <Markdown content={displayText} />
        )}
        {isSystem && !atts.length && <p className="ext-msg-text" style={{ fontStyle: 'italic', opacity: 0.7 }}>{text}</p>}
        <div className="ext-msg-meta">
          <span className="ext-msg-time">{fmtTime(msg.createdAt)}</span>
          {isPending && <span className="ext-msg-role-label" style={{ color: '#f59e0b' }}>In attesa</span>}
          {isOperator && !isPending && <span className="ext-msg-role-label">Tu</span>}
          {!isCustomer && !isOperator && <span className="ext-msg-role-label">AI</span>}
        </div>
      </div>
    </div>
  );
}

// ── Modal nuova chat WA ────────────────────────────────────────────────────
function NewChatModal({ onClose, onCreated }) {
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const create = async () => {
    const p = phone.replace(/\D/g, '');
    if (p.length < 7) return toast.error('Inserisci un numero valido (solo cifre, es. 393331234567)');
    setLoading(true);
    try {
      const { chat } = await api('/external-chats', {
        method: 'POST',
        body: { phone: p, displayName: name || undefined, message: message || undefined },
      });
      toast.info('Chat creata');
      onCreated(chat);
      onClose();
    } catch (err) { toast.error(err.message); } finally { setLoading(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Nuova chat WhatsApp</h2>
        <p className="page-subtitle" style={{ marginTop: -12, marginBottom: 16 }}>
          Se è la prima volta che scrivi a questo numero, verrà inviato automaticamente il template "Continua" richiesto da Meta.
        </p>
        <div className="field">
          <label>Numero (solo cifre, formato internazionale)</label>
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)}
            placeholder="393331234567" inputMode="numeric" />
          <span className="field-hint">Senza + — es. 393331234567 per +39 333 123 4567</span>
        </div>
        <div className="field">
          <label>Nome contatto (opzionale)</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mario Rossi" />
        </div>
        <div className="field">
          <label>Messaggio iniziale (opzionale)</label>
          <textarea className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder="Ciao! Ti scrivo per…" />
          <span className="field-hint">Se la sessione WA non è aperta, il messaggio verrà accodato e recapitato quando il cliente preme "Continua".</span>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={create} disabled={loading}>
            {loading ? 'Creazione…' : 'Crea chat'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Pagina principale ──────────────────────────────────────────────────────
export default function ExternalChats() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const modal = useModal();
  const fileRef = useRef();

  const [chats, setChats]           = useState([]);
  const [query, setQuery]           = useState('');
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages]     = useState([]);
  const [input, setInput]           = useState('');
  const [sending, setSending]       = useState(false);
  const [menuFor, setMenuFor]       = useState(null);
  const [showNewChat, setShowNewChat] = useState(false);
  const [pendingFile, setPendingFile] = useState(null); // {file, preview}
  const scrollRef = useRef(null);

  const loadChats = useCallback(async () => {
    try { const { chats } = await api('/external-chats'); setChats(chats); } catch {}
  }, []);

  const loadMessages = useCallback(async (chatId) => {
    try {
      const { chat } = await api(`/external-chats/${chatId}`);
      setActiveChat(chat); setMessages(chat.messages || []);
    } catch { navigate('/external-chats'); }
  }, [navigate]);

  useEffect(() => { loadChats(); }, [loadChats]);
  useEffect(() => {
    if (id) loadMessages(id);
    else {
      setActiveChat(null); setMessages([]);
      // Auto-apri la chat più recente se non è specificata
      api('/external-chats').then(({ chats }) => {
        if (chats && chats.length > 0) navigate(`/external-chats/${chats[0].id}`, { replace: true });
      }).catch(() => {});
    }
  }, [id, loadMessages, navigate]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Live updates
  useEffect(() => {
    const onMsg = (e) => {
      const { chatId, message } = e.detail || {};
      loadChats();
      if (chatId === id && message)
        setMessages((prev) => prev.find((m) => m.id === message.id) ? prev : [...prev, message]);
    };
    const onDel = (e) => {
      const { chatId } = e.detail || {};
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (chatId === id) navigate('/external-chats');
    };
    window.addEventListener('sophia:ext-chat', onMsg);
    window.addEventListener('sophia:ext-chat-deleted', onDel);
    return () => { window.removeEventListener('sophia:ext-chat', onMsg); window.removeEventListener('sophia:ext-chat-deleted', onDel); };
  }, [id, loadChats, navigate]);

  // Chiudi menu al click fuori
  useEffect(() => {
    const close = () => setMenuFor(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const deleteChat = async (chat) => {
    const ok = await modal.confirm(`Eliminare la chat con ${chat.displayName || chat.externalId}?`, { danger: true });
    if (!ok) return;
    try {
      await api(`/external-chats/${chat.id}`, { method: 'DELETE' });
      setChats((prev) => prev.filter((c) => c.id !== chat.id));
      if (chat.id === id) navigate('/external-chats');
      toast.info('Chat eliminata');
    } catch (err) { toast.error(err.message); }
    setMenuFor(null);
  };

  const onFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
    setPendingFile({ file, preview, name: file.name, size: file.size });
    e.target.value = '';
  };

  const removePendingFile = () => { if (pendingFile?.preview) URL.revokeObjectURL(pendingFile.preview); setPendingFile(null); };

  const send = async () => {
    if (sending || !id) return;
    setSending(true);
    try {
      if (pendingFile) {
        // Invia media
        const { message } = await uploadMedia(`/external-chats/${id}/send-media`, pendingFile.file, input.trim());
        if (message) setMessages((prev) => [...prev, message]);
        removePendingFile();
        setInput('');
      } else {
        const text = input.trim();
        if (!text) return;
        const { message } = await api(`/external-chats/${id}/send`, { method: 'POST', body: { content: text } });
        setInput('');
        if (message) setMessages((prev) => [...prev, message]);
      }
    } catch (err) { toast.error(err.message); } finally { setSending(false); }
  };

  const filtered = chats.filter((c) => {
    const t = query.toLowerCase();
    return !t || (c.externalId||'').includes(t) || (c.displayName||'').toLowerCase().includes(t);
  });

  return (
    <div className="chat-layout">
      {showNewChat && (
        <NewChatModal
          onClose={() => setShowNewChat(false)}
          onCreated={async (chat) => { await loadChats(); navigate(`/external-chats/${chat.id}`); }}
        />
      )}

      {/* Sidebar */}
      <aside className="chat-list">
        <div className="chat-list-head">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ fontSize: 12, fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>
              WhatsApp e altro
            </h2>
            <button className="btn btn-primary btn-sm" onClick={() => setShowNewChat(true)} title="Nuova chat WA">
              <Plus size={14} />
            </button>
          </div>
          <div className="chat-search">
            <Search size={15} className="search-icon" />
            <input className="input" placeholder="Cerca…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>

        <div className="chat-history">
          {filtered.length === 0 && <p className="empty small">Nessuna chat. Premi + per iniziare.</p>}
          {filtered.map((chat) => {
            const lastMsg = chat.messages?.[0];
            const isWA = chat.source === 'WHATSAPP';
            return (
              <div key={chat.id} style={{ position: 'relative' }}>
                <div
                  className={`chat-item ext-chat-item ${isWA ? 'wa-source' : ''} ${chat.id === id ? 'active' : ''}`}
                  onClick={() => navigate(`/external-chats/${chat.id}`)}>
                  <div className="ext-chat-avatar">
                    {isWA ? <Phone size={13} /> : <MessageCircle size={13} />}
                  </div>
                  <div className="ext-chat-info">
                    <div className="ext-chat-name">
                      {chat.displayName || chat.externalId}
                      <span className="ext-chat-source">{SOURCE_LABELS[chat.source]}</span>
                    </div>
                    {lastMsg && (
                      <div className="ext-chat-preview">
                        {lastMsg.role !== 'customer' && <span className="ext-chat-role">{lastMsg.role === 'operator' ? 'Tu: ' : 'AI: '}</span>}
                        <span>{(lastMsg.content || '').replace(/^\[.*?\]\s*/, '').slice(0, 46) || '…'}</span>
                      </div>
                    )}
                    {chat.lastMessageAt && <div className="ext-chat-time">{fmtTime(chat.lastMessageAt)}</div>}
                  </div>
                  <button className="chat-item-menu" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === chat.id ? null : chat.id); }}>
                    <MoreVertical size={15} />
                  </button>
                </div>
                {menuFor === chat.id && (
                  <div className="dropdown" onClick={(e) => e.stopPropagation()}>
                    <button className="danger" onClick={() => deleteChat(chat)}><Trash2 size={14} /> Elimina chat</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Area messaggi */}
      <section className="chat-main">
        {!id ? (
          <div className="chat-empty">
            <MessageCircle size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 16px', display: 'block' }} />
            <h2>WhatsApp e altro</h2>
            <p>Conversazioni con clienti via WhatsApp e widget.<br />Premi <strong>+</strong> per avviarne una nuova.</p>
          </div>
        ) : (
          <>
            {activeChat && (
              <div className="ext-chat-header">
                <div className="ext-chat-header-info">
                  {activeChat.source === 'WHATSAPP' ? <Phone size={16} style={{ color: '#25D366' }} /> : <MessageCircle size={16} />}
                  <div>
                    <span className="ext-chat-header-name">{activeChat.displayName || activeChat.externalId}</span>
                    <span className="ext-chat-header-id">{activeChat.externalId} · {SOURCE_LABELS[activeChat.source]}</span>
                  </div>
                </div>
                <AgentSelector externalChatId={activeChat.id} compact={false} />
              </div>
            )}

            <div className="chat-messages ext-messages" ref={scrollRef}>
              {messages.length === 0 && <div className="chat-empty"><p>Nessun messaggio.</p></div>}
              {messages.map((msg) => <MessageBubble key={msg.id} msg={msg} />)}
            </div>

            {/* Anteprima file allegato */}
            {pendingFile && (
              <div className="attachments-preview" style={{ padding: '8px 32px 0' }}>
                <div className="attachment-chip">
                  {pendingFile.preview
                    ? <img src={pendingFile.preview} alt="" style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: 4 }} />
                    : <Paperclip size={13} />}
                  <span>{pendingFile.name}</span>
                  <span className="att-size">({fmtBytes(pendingFile.size)})</span>
                  <button onClick={removePendingFile}><X size={12} /></button>
                </div>
              </div>
            )}

            <div className="composer">
              <div className="ext-composer-note">
                Scrivi come <strong>operatore</strong> — il messaggio arriva al cliente, non all'AI.
              </div>
              <div className="composer-box">
                <textarea
                  className="composer-input"
                  placeholder={pendingFile ? 'Aggiungi una didascalia (opzionale)…' : 'Scrivi al cliente…'}
                  value={input} rows={1}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                />
                <div className="composer-actions">
                  <label className="icon-btn" title="Allega immagine o documento">
                    <Paperclip size={18} strokeWidth={1.75} />
                    <input ref={fileRef} type="file" hidden
                      accept="image/*,video/*,audio/*,.pdf,.docx,.xlsx,.txt"
                      onChange={onFileSelect} />
                  </label>
                  <button className="icon-btn send" onClick={send}
                    disabled={sending || (!input.trim() && !pendingFile)}>
                    <Send size={18} strokeWidth={1.75} />
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
