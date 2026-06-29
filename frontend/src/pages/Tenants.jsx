import { useState } from 'react';
import { Building2, Plus, Trash2, Check, Users as UsersIcon, MessageSquare } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';
import { useTenant } from '../context/TenantContext.jsx';

export default function Tenants() {
  const toast = useToast();
  const modal = useModal();
  const { tenants, activeId, selectTenant, refresh } = useTenant();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return toast.error('Inserisci un nome');
    setBusy(true);
    try {
      const { tenant } = await api('/tenants', { method: 'POST', body: { name: trimmed } });
      setName('');
      await refresh();
      selectTenant(tenant.id); // rende subito attiva la nuova azienda
      toast.info(`"${tenant.name}" creata e selezionata`);
    } catch (err) {
      toast.error(err.message || 'Creazione non riuscita');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t) => {
    const ok = await modal.confirm(`Eliminare "${t.name}" e tutti i suoi dati? L'operazione è irreversibile.`, { danger: true });
    if (!ok) return;
    try {
      await api(`/tenants/${t.id}`, { method: 'DELETE' });
      await refresh();
      toast.info('Azienda eliminata');
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div>
      <h1 className="page-title">Aziende</h1>
      <p className="page-subtitle">Ogni azienda è un ambiente isolato: utenti, chat, moduli e configurazioni separati.</p>

      <div className="create-bar card">
        <div className="create-bar-field">
          <Building2 size={18} className="create-bar-icon" />
          <input
            className="create-bar-input"
            placeholder="Nome della nuova azienda"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
        </div>
        <button className="btn btn-primary" onClick={create} disabled={busy}>
          <Plus size={16} /> {busy ? 'Creazione…' : 'Crea azienda'}
        </button>
      </div>

      {tenants.length === 0 ? (
        <div className="empty-state card">
          <div className="empty-icon"><Building2 size={26} /></div>
          <h3>Nessuna azienda</h3>
          <p>Crea la prima azienda per iniziare a usare chat, moduli e addestramento.</p>
        </div>
      ) : (
        <div className="tenant-grid">
          {tenants.map((t) => {
            const isActive = t.id === activeId;
            return (
              <div key={t.id} className={`tenant-card card ${isActive ? 'active' : ''}`}>
                <div className="tenant-card-head">
                  <div className="tenant-avatar">{t.name.slice(0, 2).toUpperCase()}</div>
                  <div className="tenant-info">
                    <div className="tenant-name">{t.name}</div>
                    <div className="tenant-slug">{t.slug}</div>
                  </div>
                  <span className={`badge ${t.isActive ? 'badge-on' : 'badge-off'}`}>
                    {t.isActive ? 'Attiva' : 'Sospesa'}
                  </span>
                </div>

                <div className="tenant-metrics">
                  <span><UsersIcon size={14} /> {t._count?.users ?? 0} utenti</span>
                  <span><MessageSquare size={14} /> {t._count?.conversations ?? 0} chat</span>
                </div>

                <div className="tenant-card-foot">
                  {isActive ? (
                    <span className="active-tag"><Check size={14} /> Contesto attivo</span>
                  ) : (
                    <button className="btn btn-outline btn-sm" onClick={() => selectTenant(t.id)}>
                      Seleziona
                    </button>
                  )}
                  <button className="btn btn-danger icon-btn" title="Elimina" onClick={() => remove(t)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
