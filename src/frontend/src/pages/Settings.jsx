import { useEffect, useState } from 'react';
import { Lock, Phone, UserRound, Search, Link, Unlink } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useModal } from '../context/ModalContext.jsx';

export default function Settings() {
  const toast = useToast();
  const modal = useModal();
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [waNumber, setWaNumber] = useState('');
  const [linkedContact, setLinkedContact] = useState(null);
  const [contactSearch, setContactSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [savingWa, setSavingWa] = useState(false);

  useEffect(() => {
    api('/me/profile').then((data) => {
      setWaNumber(data.whatsappNumber || '');
      setLinkedContact(data.linkedContact || null);
    }).catch(() => {});
  }, []);

  // Cerca contatti in rubrica
  useEffect(() => {
    if (!contactSearch.trim()) { setSearchResults([]); return; }
    const t = setTimeout(() => {
      api(`/contacts?q=${encodeURIComponent(contactSearch)}`).then(r => setSearchResults(r.contacts?.slice(0,8)||[])).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [contactSearch]);

  const changePassword = async () => {
    if (next !== confirm) return toast.error('Le password non coincidono');
    if (next.length < 8) return toast.error('La password deve avere almeno 8 caratteri');
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      toast.info('Password aggiornata'); setCurrent(''); setNext(''); setConfirm('');
    } catch (err) { toast.error(err.message); }
  };

  const saveWa = async () => {
    if (waNumber && !waNumber.match(/^\+?\d{7,15}$/)) return toast.error('Formato numero non valido (es. +393331234567)');
    setSavingWa(true);
    try {
      await api('/me/profile', { method: 'PATCH', body: { whatsappNumber: waNumber || null } });
      toast.info('Numero aggiornato');
    } catch (err) { toast.error(err.message); } finally { setSavingWa(false); }
  };

  const linkContact = async (contact) => {
    try {
      await api('/me/profile', { method: 'PATCH', body: { contactId: contact.id } });
      setLinkedContact(contact); setContactSearch(''); setSearchResults([]);
      toast.info(`Collegato a ${contact.displayName}`);
    } catch (err) { toast.error(err.message); }
  };

  const unlinkContact = async () => {
    const ok = await modal.confirm('Scollegare il contatto? I dati memorizzati dall\'AI rimarranno nel contatto in rubrica.');
    if (!ok) return;
    try {
      await api('/me/profile', { method: 'PATCH', body: { contactId: null } });
      setLinkedContact(null); toast.info('Contatto scollegato');
    } catch (err) { toast.error(err.message); }
  };

  return (
    <div className="narrow">
      <h1 className="page-title">Impostazioni</h1>
      <p className="page-subtitle">Gestisci il tuo account e le tue preferenze.</p>

      {/* Account */}
      <div className="card panel">
        <h3 className="panel-title">Account</h3>
        <div className="info-row"><span>Nome</span><strong>{user.name || '—'}</strong></div>
        <div className="info-row"><span>Email</span><strong>{user.email}</strong></div>
        <div className="info-row"><span>Ruolo</span><strong>{user.role}</strong></div>
      </div>

      {/* Contatto in rubrica */}
      <div className="card panel">
        <h3 className="panel-title"><UserRound size={16}/> Contatto in rubrica</h3>
        <p className="page-subtitle">Collega il tuo utente a un contatto della rubrica. L'AI memorizzerà lì le informazioni su di te raccolte durante le conversazioni.</p>
        {linkedContact ? (
          <div className="settings-linked-contact">
            <div className="contact-avatar" style={{ width: 36, height: 36, fontSize: 13 }}>
              {(linkedContact.firstName||linkedContact.company||'?')[0].toUpperCase()}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>{linkedContact.displayName || linkedContact.firstName}</div>
              {linkedContact.email && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{linkedContact.email}</div>}
            </div>
            <button className="btn btn-outline btn-sm" onClick={unlinkContact}><Unlink size={13}/> Scollega</button>
          </div>
        ) : (
          <div className="field" style={{ marginTop: 12 }}>
            <label>Cerca contatto</label>
            <div className="search-box" style={{ position: 'relative' }}>
              <Search size={15} className="search-ico"/>
              <input className="search-inp" placeholder="Nome, email o telefono…" value={contactSearch} onChange={e => setContactSearch(e.target.value)}/>
            </div>
            {searchResults.length > 0 && (
              <div className="card" style={{ marginTop: 4, padding: 0, overflow: 'hidden' }}>
                {searchResults.map(c => (
                  <button key={c.id} className="contact-row" style={{ borderBottom: '1px solid var(--gray-100)' }} onClick={() => linkContact(c)}>
                    <span className="contact-avatar" style={{ width: 30, height: 30, fontSize: 11 }}>{(c.firstName||c.company||'?')[0].toUpperCase()}</span>
                    <span className="contact-main">
                      <span className="contact-name">{c.displayName}</span>
                      {c.email && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.email}</span>}
                    </span>
                    <Link size={13} style={{ color: 'var(--primary)', marginRight: 8 }}/>
                  </button>
                ))}
              </div>
            )}
            <p className="field-hint" style={{ marginTop: 6 }}>Se il tuo contatto non è ancora in rubrica, crealo prima dalla sezione Rubrica.</p>
          </div>
        )}
      </div>

      {/* Numero WhatsApp personale */}
      <div className="card panel">
        <h3 className="panel-title"><Phone size={16}/> Numero WhatsApp personale</h3>
        <p className="page-subtitle">Se lo imposti, l'AI lo userà quando dici "mandami su WhatsApp" senza specificare un numero.</p>
        <div className="field">
          <label>Numero</label>
          <input className="input" value={waNumber} onChange={e => setWaNumber(e.target.value)} placeholder="+393331234567"/>
          <span className="field-hint">Formato internazionale con + (es. +393331234567)</span>
        </div>
        <button className="btn btn-primary" onClick={saveWa} disabled={savingWa}>{savingWa ? 'Salvo…' : 'Salva'}</button>
      </div>

      {/* Cambia password */}
      <div className="card panel">
        <h3 className="panel-title"><Lock size={16}/> Cambia password</h3>
        <div className="field"><label>Password attuale</label>
          <input className="input" type="password" value={current} onChange={e => setCurrent(e.target.value)}/></div>
        <div className="field"><label>Nuova password</label>
          <input className="input" type="password" value={next} onChange={e => setNext(e.target.value)}/></div>
        <div className="field"><label>Conferma nuova password</label>
          <input className="input" type="password" value={confirm} onChange={e => setConfirm(e.target.value)}/></div>
        <button className="btn btn-primary" onClick={changePassword}>Aggiorna password</button>
      </div>
    </div>
  );
}
