import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api } from '../lib/api.js';

export default function Login() {
  const { login } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('login'); // login | reset
  const [resetSent, setResetSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await api('/auth/forgot-password', { method: 'POST', body: { email } });
        setResetSent(true);
      }
    } catch (err) {
      toast.error(err.message || (mode === 'login' ? 'Accesso non riuscito' : 'Richiesta non riuscita'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card card">
        <div className="login-brand">
          <span className="sophia-logo">Sophia</span>
        </div>

        {resetSent ? (
          <>
            <h1 className="login-title">Controlla la tua email</h1>
            <p className="login-sub">Se l'indirizzo è registrato, riceverai un link per reimpostare la password.</p>
            <button className="btn btn-outline" style={{ width: '100%', justifyContent: 'center', marginTop: 16 }} onClick={() => { setMode('login'); setResetSent(false); }}>
              Torna all'accesso
            </button>
          </>
        ) : mode === 'login' ? (
          <>
            <h1 className="login-title">Accedi al tuo spazio</h1>
            <p className="login-sub">Inserisci le credenziali per continuare.</p>
            <form onSubmit={submit}>
              <div className="field">
                <label>Email</label>
                <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="nome@azienda.it" autoFocus required />
              </div>
              <div className="field">
                <label>Password</label>
                <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
              </div>
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
                {busy ? 'Accesso in corso…' : 'Accedi'}
              </button>
            </form>
            <button className="login-forgot" onClick={() => setMode('reset')}>
              Password dimenticata?
            </button>
          </>
        ) : (
          <>
            <h1 className="login-title">Reimposta password</h1>
            <p className="login-sub">Inserisci l'email del tuo account. Ti invieremo le istruzioni.</p>
            <form onSubmit={submit}>
              <div className="field">
                <label>Email</label>
                <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="nome@azienda.it" autoFocus required />
              </div>
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
                {busy ? 'Invio…' : 'Invia link di reset'}
              </button>
            </form>
            <button className="login-forgot" onClick={() => setMode('login')}>
              Torna all'accesso
            </button>
          </>
        )}
      </div>
      <p className="login-foot">Sophia · Piattaforma AI — <a href="https://ai-sophia.it" target="_blank" rel="noopener">ai-sophia.it</a></p>
    </div>
  );
}
