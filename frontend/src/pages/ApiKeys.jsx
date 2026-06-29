import { useEffect, useState } from 'react';
import { KeyRound, Plus, RefreshCw, Trash2, Copy, X, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';

export default function ApiKeys() {
  const toast = useToast();
  const modal = useModal();
  const [keys, setKeys] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [secret, setSecret] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', tenantId: '', description: '' });

  const load = () => api('/apikeys').then(({ apiKeys }) => setKeys(apiKeys));
  useEffect(() => {
    load();
    api('/tenants').then(({ tenants }) => setTenants(tenants)).catch(() => {});
  }, []);

  const tenantName = (id) => tenants.find((t) => t.id === id)?.name || '—';

  const create = async () => {
    if (!form.name.trim() || !form.tenantId) return toast.error('Nome e azienda sono obbligatori');
    try {
      const { secret } = await api('/apikeys', { method: 'POST', body: { ...form, permissions: [] } });
      setSecret(secret);
      setForm({ name: '', tenantId: '', description: '' });
      setCreating(false);
      load();
    } catch (err) { toast.error(err.message); }
  };

  const regenerate = async (k) => {
    const ok = await modal.confirm('Rigenerare la chiave? Quella attuale smetterà di funzionare.'); if (!ok) return;
    const { secret } = await api(`/apikeys/${k.id}/regenerate`, { method: 'POST' });
    setSecret(secret); load();
  };
  const toggle = async (k) => { await api(`/apikeys/${k.id}`, { method: 'PATCH', body: { enabled: !k.enabled } }); load(); };
  const remove = async (k) => { const ok = await modal.confirm('Eliminare la chiave?', { danger: true }); if (ok) { await api(`/apikeys/${k.id}`, { method: 'DELETE' }); load(); } };

  if (!keys) return <div className="skeleton" style={{ height: 300 }} />;

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">API Key</h1>
          <p className="page-subtitle">Accessi programmatici alla piattaforma, assegnati per azienda.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> Nuova API Key
        </button>
      </div>

      {secret && (
        <div className="secret-banner card">
          <ShieldCheck size={20} className="secret-icon" />
          <div className="secret-body">
            <strong>Copia la chiave adesso — non sarà più mostrata.</strong>
            <code className="secret-code">{secret}</code>
          </div>
          <button className="btn btn-outline" onClick={() => { navigator.clipboard.writeText(secret); toast.info('Copiata'); }}>
            <Copy size={15} /> Copia
          </button>
          <button className="btn btn-ghost icon-btn" onClick={() => setSecret(null)}><X size={16} /></button>
        </div>
      )}

      {keys.length === 0 ? (
        <div className="empty-state card">
          <div className="empty-icon"><KeyRound size={26} /></div>
          <h3>Nessuna API Key</h3>
          <p>Genera una chiave per consentire l'accesso programmatico a un'azienda.</p>
        </div>
      ) : (
        <div className="card table-card">
          <table className="data-table">
            <thead><tr><th>Nome</th><th>Azienda</th><th>Chiave</th><th>Ultima attività</th><th>Stato</th><th></th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td><span className="cell-strong"><KeyRound size={15} /> {k.name}</span>
                    {k.description && <div className="cell-sub">{k.description}</div>}</td>
                  <td>{tenantName(k.tenantId)}</td>
                  <td><code className="key-prefix">{k.prefix}…</code></td>
                  <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('it-IT') : 'Mai usata'}</td>
                  <td>
                    <button className={`badge ${k.enabled ? 'badge-on' : 'badge-off'}`} onClick={() => toggle(k)}>
                      {k.enabled ? 'Abilitata' : 'Disabilitata'}
                    </button>
                  </td>
                  <td className="row-actions">
                    <button className="btn btn-ghost icon-btn" title="Rigenera" onClick={() => regenerate(k)}><RefreshCw size={16} /></button>
                    <button className="btn btn-danger icon-btn" title="Elimina" onClick={() => remove(k)}><Trash2 size={16} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title"><KeyRound size={18} /> Nuova API Key</h2>
            <div className="field"><label>Nome</label>
              <input className="input" value={form.name} placeholder="Es. Integrazione sito"
                onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label>Azienda</label>
              <select className="input" value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })}>
                <option value="">Seleziona azienda</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select></div>
            <div className="field"><label>Descrizione (opzionale)</label>
              <input className="input" value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setCreating(false)}>Annulla</button>
              <button className="btn btn-primary" onClick={create}>Genera chiave</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
