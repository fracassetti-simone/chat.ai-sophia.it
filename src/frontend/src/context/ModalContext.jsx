// Modal personalizzati per sostituire confirm(), prompt() e alert() nativi.
// Uso: import { useModal } from './ModalContext.jsx' e chiama modal.confirm(...)
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { X, AlertTriangle, Info, Trash2 } from 'lucide-react';

const ModalCtx = createContext(null);

export function ModalProvider({ children }) {
  const [queue, setQueue] = useState([]);

  const open = (cfg) =>
    new Promise((resolve) => {
      setQueue((q) => [...q, { ...cfg, id: Math.random().toString(36).slice(2), resolve }]);
    });

  const close = (id, result) => {
    setQueue((q) => q.filter((m) => m.id !== id));
    // result già catturato dalla Promise nella chiusura
    void result;
  };

  const api = {
    // Conferma distruttiva
    confirm: (message, { title = 'Conferma', danger = false } = {}) =>
      open({ type: 'confirm', title, message, danger }),
    // Input testo
    prompt: (message, { title = '', defaultValue = '', placeholder = '' } = {}) =>
      open({ type: 'prompt', title, message, defaultValue, placeholder }),
    // Info/alert
    alert: (message, { title = 'Attenzione' } = {}) =>
      open({ type: 'alert', title, message }),
  };

  const current = queue[0] || null;

  return (
    <ModalCtx.Provider value={api}>
      {children}
      {current && (
        <ModalOverlay key={current.id} modal={current} onClose={(result) => { current.resolve(result); close(current.id, result); }} />
      )}
    </ModalCtx.Provider>
  );
}

export function useModal() { return useContext(ModalCtx); }

function ModalOverlay({ modal, onClose }) {
  const inputRef = useRef(null);
  const [value, setValue] = useState(modal.defaultValue || '');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(null); };
    window.addEventListener('keydown', onKey);
    setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const Icon = modal.danger ? Trash2 : Info;

  return (
    <div className="modal-backdrop" onClick={() => onClose(null)}>
      <div className="modal card modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head-row">
          <div className="modal-icon-title">
            <span className={`modal-icon-badge${modal.danger ? ' danger' : ''}`}>
              {modal.danger ? <Trash2 size={16} /> : <Info size={16} />}
            </span>
            <h3 className="modal-title-sm">{modal.title || (modal.type === 'confirm' ? 'Conferma' : modal.type === 'prompt' ? 'Inserisci' : 'Informazione')}</h3>
          </div>
          <button className="btn btn-ghost icon-btn" onClick={() => onClose(null)}><X size={16} /></button>
        </div>
        <p className="modal-body-text">{modal.message}</p>
        {modal.type === 'prompt' && (
          <input
            ref={inputRef}
            className="input"
            style={{ marginTop: 4 }}
            value={value}
            placeholder={modal.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onClose(value); }}
          />
        )}
        <div className="modal-foot">
          {modal.type !== 'alert' && (
            <button className="btn btn-ghost" onClick={() => onClose(null)}>Annulla</button>
          )}
          <button
            className={`btn ${modal.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => onClose(modal.type === 'prompt' ? value : true)}
            autoFocus={modal.type !== 'prompt'}
          >
            {modal.type === 'alert' ? 'OK' : modal.danger ? 'Elimina' : 'Conferma'}
          </button>
        </div>
      </div>
    </div>
  );
}
