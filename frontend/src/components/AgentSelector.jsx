/**
 * AgentSelector — selettore agente inline per chat dashboard e chat esterne.
 *
 * Props:
 *  - conversationId: string | null   (chat interna)
 *  - externalChatId: string | null   (chat esterna WA/widget)
 *  - compact: bool                   (mostra solo avatar+nome, no dropdown pieno)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, Check } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';

export default function AgentSelector({ conversationId, externalChatId, compact = false }) {
  const toast = useToast();
  const [agents, setAgents]       = useState([]);
  const [activeId, setActiveId]   = useState(null);  // agentId attivo per questo contesto
  const [open, setOpen]           = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useRef(null);

  const loadAgents = useCallback(async () => {
    try { const { agents: list } = await api('/agents'); setAgents(list || []); } catch {}
  }, []);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  // Aggiorna activeId dal server quando cambia il contesto
  useEffect(() => {
    if (!conversationId && !externalChatId) return;
    // Non abbiamo un endpoint dedicato per il get dell'agente attivo: lo risolviamo
    // ascoltando l'evento socket e aggiornando localmente dopo lo switch.
  }, [conversationId, externalChatId]);

  // Ascolta gli switch in tempo reale
  useEffect(() => {
    const handler = (e) => {
      const { context, contextId, agentId } = e.detail || {};
      if (
        (context === 'conversation' && contextId === conversationId) ||
        (context === 'external-chat' && contextId === externalChatId)
      ) {
        setActiveId(agentId);
      }
    };
    window.addEventListener('sophia:agent:switched', handler);
    return () => window.removeEventListener('sophia:agent:switched', handler);
  }, [conversationId, externalChatId]);

  // Chiudi il dropdown cliccando fuori
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const switchAgent = async (agentId) => {
    setSwitching(true);
    try {
      if (conversationId) {
        await api(`/agents/assign/conversation/${conversationId}`, { method: 'POST', body: { agentId } });
      } else if (externalChatId) {
        await api(`/agents/assign/external-chat/${externalChatId}`, { method: 'POST', body: { agentId } });
      }
      setActiveId(agentId);
      toast.info(`Agente cambiato: ${agents.find(a => a.id === agentId)?.name}`);
    } catch (err) { toast.error(err.message); } finally { setSwitching(false); setOpen(false); }
  };

  if (!agents.length) return null;

  const active = agents.find(a => a.id === activeId) || agents.find(a => a.isDefault) || agents[0];

  return (
    <div className="agent-selector" ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className="agent-selector-btn"
        onClick={() => setOpen(o => !o)}
        disabled={switching}
        title="Cambia agente"
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
          border: '1px solid var(--border)', borderRadius: 20, background: 'var(--surface)',
          cursor: 'pointer', fontSize: 13, color: 'var(--text)', fontWeight: 500,
          transition: 'border-color .15s',
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1 }}>{active?.avatar || '🤖'}</span>
        {!compact && <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active?.name || 'Agente'}</span>}
        <ChevronDown size={12} style={{ color: 'var(--text-muted)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}/>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 200,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 4px 20px rgba(0,0,0,.12)', minWidth: 200, overflow: 'hidden',
        }}>
          <div style={{ padding: '6px 10px 4px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5 }}>
            Seleziona agente
          </div>
          {agents.map(a => (
            <button
              key={a.id}
              onClick={() => switchAgent(a.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '9px 12px', textAlign: 'left', border: 'none',
                background: a.id === active?.id ? 'var(--primary-10, #eff6ff)' : 'transparent',
                cursor: 'pointer', transition: 'background .1s',
              }}
              onMouseEnter={e => { if (a.id !== active?.id) e.currentTarget.style.background = 'var(--gray-50)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = a.id === active?.id ? 'var(--primary-10, #eff6ff)' : 'transparent'; }}
            >
              <span style={{ fontSize: 18, lineHeight: 1 }}>{a.avatar || '🤖'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{a.name}</div>
                {a.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.description}</div>}
              </div>
              {a.id === active?.id && <Check size={14} style={{ color: 'var(--primary)', flexShrink: 0 }}/>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
