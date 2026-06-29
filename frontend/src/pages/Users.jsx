import { useEffect, useState } from 'react';
import { UserPlus, Trash2, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const ROLE_LABEL = { SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', MEMBER: 'Utente' };

export default function Users() {
  const toast = useToast();
  const modal = useModal();
  const { user: me, can } = useAuth();
  const [users, setUsers] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = () => api('/users').then(({ users }) => setUsers(users)).catch(() => setUsers([]));
  useEffect(() => { load(); }, []);

  const remove = async (u) => {
    const ok = await modal.confirm(`Eliminare ${u.email}?`, { danger: true }); if (!ok) return;
    try { await api(`/users/${u.id}`, { method: 'DELETE' }); load(); toast.info('Utente eliminato'); }
    catch (err) { toast.error(err.message); }
  };

  if (!users) return <div className="skeleton" style={{ height: 300 }} />;

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">Utenti</h1>
          <p className="page-subtitle">Gestisci gli accessi della tua azienda.</p>
        </div>
        {can('users:create') && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <UserPlus size={16} /> Nuovo utente
          </button>
        )}
      </div>

      <div className="card table-card">
        <table className="data-table">
          <thead>
            <tr><th>Nome</th><th>Email</th><th>Ruolo</th><th>Stato</th><th></th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name || '—'}</td>
                <td>{u.email}</td>
                <td><span className={`role-pill role-${u.role.toLowerCase()}`}>{ROLE_LABEL[u.role]}</span></td>
                <td><span className={`badge ${u.isActive ? 'badge-on' : 'badge-off'}`}>{u.isActive ? 'Attivo' : 'Sospeso'}</span></td>
                <td className="row-actions">
                  {u.id !== me.id && can('users:delete') && (
                    <button className="btn btn-danger icon-btn" onClick={() => remove(u)}><Trash2 size={16} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && <CreateUser onClose={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function CreateUser({ onClose }) {
  const toast = useToast();
  const { user: me } = useAuth();
  const [form, setForm] = useState({ email: '', password: '', name: '', role: 'MEMBER' });
  const canMakeSuper = me.role === 'SUPER_ADMIN';

  const submit = async () => {
    try {
      await api('/users', { method: 'POST', body: form });
      toast.info('Utente creato');
      onClose();
    } catch (err) { toast.error(err.message); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><ShieldCheck size={18} /> Nuovo utente</h2>
        <div className="field"><label>Nome</label>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="field"><label>Email</label>
          <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div className="field"><label>Password</label>
          <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
        <div className="field"><label>Ruolo</label>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="MEMBER">Utente</option>
            <option value="ADMIN">Admin</option>
            {canMakeSuper && <option value="SUPER_ADMIN">Super Admin</option>}
          </select>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={submit}>Crea</button>
        </div>
      </div>
    </div>
  );
}
