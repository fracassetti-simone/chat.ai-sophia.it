import { useEffect, useState, useRef } from 'react';
import {
  PlugZap, Plus, Trash2, Upload, Power, CheckCircle2, XCircle,
  Loader2, ChevronDown, ChevronUp, Key, Eye, EyeOff, AlertTriangle,
  Clock, Zap, Settings2,
} from 'lucide-react';
import { api, upload } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const IMPORT_KEY = 'sophia.ep.importing';

// Rileva variabili del tipo {{nome}}, $NOME, ${NOME} in una stringa
function detectVars(str) {
  const set = new Set();
  const s = typeof str === 'string' ? str : JSON.stringify(str || '');
  [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].forEach(([, k]) => set.add(k));
  [...s.matchAll(/\$\{(\w+)\}/g)].forEach(([, k]) => set.add(k));
  [...s.matchAll(/\$([A-Z_][A-Z0-9_]*)/g)].forEach(([, k]) => set.add(k));
  return [...set];
}

// Raccoglie tutte le variabili da una lista di endpoint estratti
function collectAllVars(endpoints) {
  const set = new Set();
  for (const ep of endpoints) {
    detectVars(ep.url).forEach((v) => set.add(v));
    detectVars(JSON.stringify(ep.headers || {})).forEach((v) => set.add(v));
    detectVars(JSON.stringify(ep.body || {})).forEach((v) => set.add(v));
    detectVars(JSON.stringify(ep.query || {})).forEach((v) => set.add(v));
    if (ep.bearerToken) detectVars(ep.bearerToken).forEach((v) => set.add(v));
  }
  return [...set];
}

// Etichette friendly per variabili comuni
function varLabel(name) {
  const lower = name.toLowerCase();
  if (lower.includes('token') || lower.includes('bearer')) return 'Token di autenticazione';
  if (lower.includes('api_key') || lower.includes('apikey')) return 'API Key';
  if (lower.includes('secret')) return 'Secret / Chiave segreta';
  if (lower.includes('password') || lower.includes('pass')) return 'Password';
  if (lower.includes('user') || lower.includes('username')) return 'Username / Utente';
  if (lower.includes('client_id')) return 'Client ID';
  if (lower.includes('client_secret')) return 'Client Secret';
  return name.replace(/_/g, ' ');
}

function isSensitive(name) {
  const l = name.toLowerCase();
  return l.includes('token') || l.includes('key') || l.includes('secret') ||
         l.includes('password') || l.includes('pass') || l.includes('bearer');
}

export default function Endpoints() {
  const toast = useToast();
  const [endpoints, setEndpoints] = useState(null);
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem(IMPORT_KEY) || 'null');
      return s && Date.now() - s.ts < 3 * 60 * 1000 ? s : null;
    } catch { return null; }
  });
  const [varWizard, setVarWizard] = useState(null); // { endpoints, vars: [nome,...] }
  const [verifying, setVerifying] = useState({});
  const [verifyResult, setVerifyResult] = useState({});
  const [expanded, setExpanded] = useState({});
  const fileRef = useRef(null);

  const load = () =>
    api('/endpoints').then(({ endpoints }) => setEndpoints(endpoints)).catch(() => setEndpoints([]));
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!importing) localStorage.removeItem(IMPORT_KEY);
  }, [importing]);

  const startImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const state = { ts: Date.now(), filename: file.name };
    localStorage.setItem(IMPORT_KEY, JSON.stringify(state));
    setImporting(state);

    try {
      const { text } = await upload('/documents', file);
      const { endpoints: extracted } = await api('/endpoints/import', { method: 'POST', body: { text } });

      if (!extracted.length) {
        toast.info('Nessun endpoint trovato nella documentazione.');
        setImporting(null);
        return;
      }

      // Raccoglie TUTTE le variabili + bearer rilevati
      const allVars = collectAllVars(extracted);
      const needsBearer = extracted.some((ep) =>
        ep.bearerToken || JSON.stringify(ep.headers || {}).toLowerCase().includes('authorization'),
      );
      if (!allVars.includes('bearer') && needsBearer) allVars.push('bearerToken');

      if (allVars.length > 0) {
        setVarWizard({ endpoints: extracted, vars: allVars });
      } else {
        await saveExtracted(extracted, {});
      }
    } catch (err) {
      toast.error(err.message);
      setImporting(null);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const saveExtracted = async (extracted, varValues) => {
    let saved = 0;
    for (const ep of extracted) {
      const norm = normalize(ep);

      // Applica i valori delle variabili direttamente (sostituzione assoluta)
      if (Object.keys(varValues).length > 0) {
        // Sostituisce variabili nel body
        if (norm.body && Object.keys(norm.body).length > 0) {
          norm.body = substituteVarsInObject(norm.body, varValues);
        }
        // Sostituisce variabili negli header
        if (norm.headers && Object.keys(norm.headers).length > 0) {
          norm.headers = substituteVarsInObject(norm.headers, varValues);
        }
        // Sostituisce bearer token
        if (varValues.bearerToken) norm.bearerToken = varValues.bearerToken;
        // Sostituisce variabili nell'URL
        norm.url = substituteVarsInString(norm.url, varValues);
        // Salva anche in variables per compatibilità runtime
        norm.variables = { ...norm.variables, ...varValues };
      }

      await api('/endpoints', { method: 'POST', body: norm }).catch(() => {});
      saved++;
    }
    load();
    setImporting(null);
    setVarWizard(null);
    toast.info(`${saved} endpoint importati`);
  };

  const remove = async (ep) => { await api(`/endpoints/${ep.id}`, { method: 'DELETE' }); load(); };
  const toggle = async (ep) => {
    await api(`/endpoints/${ep.id}`, { method: 'PATCH', body: { enabled: !ep.enabled } });
    load();
  };

  const verify = async (ep) => {
    setVerifying((v) => ({ ...v, [ep.id]: true }));
    try {
      const result = await api(`/endpoints/${ep.id}/verify`, { method: 'POST' });
      setVerifyResult((r) => ({ ...r, [ep.id]: result }));
    } catch (err) {
      setVerifyResult((r) => ({ ...r, [ep.id]: { ok: false, error: err.message } }));
    } finally {
      setVerifying((v) => ({ ...v, [ep.id]: false }));
    }
  };

  if (!endpoints && !importing) return <div className="skeleton" style={{ height: 300 }} />;

  return (
    <div>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">Connetti API</h1>
          <p className="page-subtitle">Registra gli endpoint che l'assistente può utilizzare.</p>
        </div>
        <div className="head-actions">
          <label className="btn btn-outline" style={{ cursor: 'pointer' }}>
            <Upload size={16} /> Importa documentazione
            <input
              ref={fileRef}
              type="file"
              hidden
              accept=".pdf,.docx,.txt,.md,.json,.yaml,.yml"
              onChange={startImport}
            />
          </label>
          <button className="btn btn-primary" onClick={() => setEditing({ method: 'GET' })}>
            <Plus size={16} /> Nuovo endpoint
          </button>
        </div>
      </div>

      {importing && (
        <div className="import-banner">
          <Loader2 size={16} className="spin" />
          <span>
            Analisi di <strong>{importing.filename}</strong> in corso — l'AI sta estraendo gli endpoint…
          </span>
        </div>
      )}

      <div className="card table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Metodo</th>
              <th>URL</th>
              <th>Categoria</th>
              <th>Stato</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(endpoints ?? []).map((ep) => (
              <>
                <tr key={ep.id}>
                  <td>
                    <span className="cell-strong">
                      <PlugZap size={15} /> {ep.name}
                    </span>
                    <div className="cell-sub">{ep.description}</div>
                  </td>
                  <td>
                    <span className={`method method-${ep.method.toLowerCase()}`}>{ep.method}</span>
                  </td>
                  <td className="url-cell">{ep.url}</td>
                  <td>{ep.category}</td>
                  <td>
                    <button
                      className={`badge ${ep.enabled ? 'badge-on' : 'badge-off'}`}
                      onClick={() => toggle(ep)}
                    >
                      <Power size={12} /> {ep.enabled ? 'Abilitato' : 'Disabilitato'}
                    </button>
                  </td>
                  <td className="row-actions">
                    <button
                      className="btn btn-ghost btn-sm"
                      title="Testa endpoint"
                      onClick={() => verify(ep)}
                      disabled={verifying[ep.id]}
                    >
                      {verifying[ep.id]
                        ? <Loader2 size={14} className="spin" />
                        : <Zap size={14} />
                      }
                      Testa
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setExpanded((x) => ({ ...x, [ep.id]: !x[ep.id] }))}
                    >
                      {expanded[ep.id] ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(ep)}>
                      Modifica
                    </button>
                    <button className="btn btn-danger icon-btn" onClick={() => remove(ep)}>
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>

                {verifyResult[ep.id] && (
                  <tr key={`${ep.id}-vr`}>
                    <td colSpan={6} style={{ padding: '0 18px 12px' }}>
                      <VerifyResult result={verifyResult[ep.id]} />
                    </td>
                  </tr>
                )}

                {expanded[ep.id] && (
                  <tr key={`${ep.id}-exp`}>
                    <td colSpan={6} style={{ padding: '0 18px 12px' }}>
                      <EndpointDetails ep={ep} />
                    </td>
                  </tr>
                )}
              </>
            ))}
            {(endpoints ?? []).length === 0 && !importing && (
              <tr>
                <td colSpan={6} className="empty">
                  Nessun endpoint. Importa una documentazione o creane uno.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <EndpointEditor
          endpoint={editing}
          onClose={() => { setEditing(null); load(); }}
        />
      )}

      {varWizard && (
        <VarWizard
          count={varWizard.endpoints.length}
          vars={varWizard.vars}
          onSave={(values) => saveExtracted(varWizard.endpoints, values)}
          onSkip={() => saveExtracted(varWizard.endpoints, {})}
          onClose={() => { setVarWizard(null); setImporting(null); }}
        />
      )}
    </div>
  );
}

// ── Sostituzione variabili (valore assoluto) ────────────────────────────────

function substituteVarsInString(str, vars) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{{${k}}}`))
    .replace(/\$\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `\${${k}}`))
    .replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, k) => (vars[k] !== undefined ? vars[k] : `$${k}`));
}

function substituteVarsInObject(obj, vars) {
  if (typeof obj === 'string') return substituteVarsInString(obj, vars);
  if (Array.isArray(obj)) return obj.map((v) => substituteVarsInObject(v, vars));
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, substituteVarsInObject(v, vars)]),
    );
  }
  return obj;
}

// ── Verify Result ──────────────────────────────────────────────────────────

function VerifyResult({ result }) {
  const ok = result.ok;
  return (
    <div className={`verify-result ${ok ? 'verify-ok' : 'verify-fail'}`}>
      {ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
      <div>
        <strong>{ok ? `Risposta ${result.status}` : 'Errore'}</strong>
        {result.elapsed != null && (
          <span className="verify-elapsed"><Clock size={11} /> {result.elapsed}ms</span>
        )}
        {result.error && <div className="verify-error">{result.error}</div>}
        {result.payload != null && (
          <pre className="verify-payload">
            {typeof result.payload === 'string'
              ? result.payload.slice(0, 500)
              : JSON.stringify(result.payload, null, 2).slice(0, 500)}
          </pre>
        )}
      </div>
    </div>
  );
}

// ── Endpoint Details (expanded) ────────────────────────────────────────────

function EndpointDetails({ ep }) {
  const sections = [
    { label: 'Headers', data: ep.headers },
    { label: 'Query params', data: ep.query },
    { label: 'Path params', data: ep.params },
    { label: 'Body', data: ep.body },
  ].filter((s) => s.data && Object.keys(s.data).length > 0);

  if (!sections.length && !ep.bearerToken) {
    return <div className="ep-detail-empty">Nessun parametro configurato.</div>;
  }

  return (
    <div className="ep-details">
      {ep.bearerToken && (
        <div className="ep-detail-row">
          <span className="ep-detail-label"><Key size={12} /> Bearer Token</span>
          <code className="ep-detail-value">{'•'.repeat(12)}</code>
        </div>
      )}
      {sections.map((s) => (
        <div key={s.label} className="ep-detail-row">
          <span className="ep-detail-label">{s.label}</span>
          <pre className="ep-detail-json">{JSON.stringify(s.data, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}

// ── Wizard variabili (post-import) ─────────────────────────────────────────

function VarWizard({ count, vars, onSave, onSkip, onClose }) {
  const [values, setValues] = useState(() =>
    Object.fromEntries(vars.map((v) => [v, ''])),
  );
  const [show, setShow] = useState({});

  const set = (k, v) => setValues((prev) => ({ ...prev, [k]: v }));
  const toggleShow = (k) => setShow((prev) => ({ ...prev, [k]: !prev[k] }));

  const handleSave = () => {
    // Filtra solo variabili con valori effettivi
    const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
    onSave(filled);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title"><Settings2 size={18} /> Credenziali e variabili API</h2>

        <div className="notice" style={{ marginBottom: 20 }}>
          <AlertTriangle size={16} />
          Abbiamo estratto <strong>{count}</strong> endpoint dalla documentazione.
          Inserisci i valori comuni che verranno applicati a tutti gli endpoint.
          Puoi lasciare vuoti i campi non necessari.
        </div>

        {vars.map((varName) => {
          const sensitive = isSensitive(varName);
          const label = varLabel(varName);
          return (
            <div className="field" key={varName} style={{ marginBottom: 14 }}>
              <label>
                {label}
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11, marginLeft: 6 }}>
                  ({varName})
                </span>
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="input"
                  type={sensitive && !show[varName] ? 'password' : 'text'}
                  value={values[varName]}
                  onChange={(e) => set(varName, e.target.value)}
                  placeholder={sensitive ? '••••••••••' : `Valore per ${varName}`}
                  style={{ flex: 1 }}
                />
                {sensitive && (
                  <button className="btn btn-ghost" onClick={() => toggleShow(varName)}>
                    {show[varName] ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        <div className="field-hint" style={{ marginBottom: 16 }}>
          I valori inseriti vengono sostituiti direttamente in tutti gli endpoint importati e non saranno più visibili come variabili.
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onSkip}>Salta</button>
          <button className="btn btn-primary" onClick={handleSave}>
            Importa endpoint
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Endpoint Editor ────────────────────────────────────────────────────────

function normalize(ep) {
  return {
    name: ep.name || 'Endpoint',
    description: ep.description || '',
    url: ep.url || 'https://',
    method: METHODS.includes(ep.method) ? ep.method : 'GET',
    category: ep.category || 'Generale',
    headers: ep.headers || {},
    query: ep.query || {},
    params: ep.params || {},
    body: ep.body || {},
    variables: ep.variables || {},
    bearerToken: ep.bearerToken || null,
  };
}

function EndpointEditor({ endpoint, onClose }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: '', description: '', url: 'https://', method: 'GET', category: 'Generale',
    bearerToken: '', headers: {}, query: {}, params: {}, body: {}, ...endpoint,
  });
  const [showToken, setShowToken] = useState(false);
  const [headerRows, setHeaderRows] = useState(() => {
    const entries = Object.entries(endpoint.headers || {});
    return entries.length ? entries.map(([k, v]) => ({ k, v: String(v) })) : [{ k: '', v: '' }];
  });
  const setHeaderRow = (i, patch) =>
    setHeaderRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addHeaderRow = () => setHeaderRows((rows) => [...rows, { k: '', v: '' }]);
  const removeHeaderRow = (i) => setHeaderRows((rows) => rows.filter((_, idx) => idx !== i));
  const [bodyStr, setBodyStr] = useState(() =>
    endpoint.body && Object.keys(endpoint.body).length
      ? JSON.stringify(endpoint.body, null, 2)
      : '',
  );
  const [bodyError, setBodyError] = useState('');

  const save = async () => {
    try {
      let body = {};
      if (bodyStr.trim()) {
        try { body = JSON.parse(bodyStr); }
        catch { setBodyError('JSON non valido'); return; }
      }
      setBodyError('');
      const headers = Object.fromEntries(
        headerRows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]),
      );
      const data = { ...normalize(f), headers, body, bearerToken: f.bearerToken || null };
      if (endpoint.id) await api(`/endpoints/${endpoint.id}`, { method: 'PATCH', body: data });
      else await api('/endpoints', { method: 'POST', body: data });
      toast.info('Endpoint salvato');
      onClose();
    } catch (err) { toast.error(err.message); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal card"
        style={{ width: '94vw', maxWidth: 980, maxHeight: '92vh', overflowY: 'auto', boxSizing: 'border-box' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">
          {endpoint.id ? 'Modifica endpoint' : 'Nuovo endpoint'}
        </h2>

        <div className="row-2">
          <div className="field">
            <label>Metodo</label>
            <select className="input" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
              {METHODS.map((m) => <option key={m}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Categoria</label>
            <input className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
          </div>
        </div>

        <div className="field"><label>Nome</label>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="field"><label>Descrizione</label>
          <input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div className="field"><label>URL</label>
          <input className="input" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></div>

        <div className="field">
          <label>Bearer Token <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(opzionale)</span></label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              type={showToken ? 'text' : 'password'}
              value={f.bearerToken || ''}
              onChange={(e) => setF({ ...f, bearerToken: e.target.value })}
              style={{ flex: 1 }}
            />
            <button className="btn btn-ghost" onClick={() => setShowToken(!showToken)}>
              {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        <div className="field">
          <label>
            Header attesi <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
              (es. Authorization, x-api-key — i valori possono usare {'{{var}}'} o $VAR)
            </span>
          </label>
          {headerRows.map((row, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input
                className="input"
                placeholder="Nome header (es. x-api-key)"
                style={{ flex: 1 }}
                value={row.k}
                onChange={(e) => setHeaderRow(i, { k: e.target.value })}
              />
              <input
                className="input"
                placeholder="Valore (es. $OTP_API_KEY)"
                style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 12 }}
                value={row.v}
                onChange={(e) => setHeaderRow(i, { v: e.target.value })}
              />
              <button className="btn btn-ghost" onClick={() => removeHeaderRow(i)} title="Rimuovi header">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button className="btn btn-ghost" onClick={addHeaderRow}>
            <Plus size={14} /> Aggiungi header
          </button>
        </div>

        <div className="field">
          <label>Body JSON <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(per POST/PUT/PATCH)</span></label>
          <textarea
            className="input"
            rows={5}
            style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
            value={bodyStr}
            onChange={(e) => { setBodyStr(e.target.value); setBodyError(''); }}
            placeholder='{ "key": "value" }'
          />
          {bodyError && <div style={{ color: 'var(--red-600)', fontSize: 12, marginTop: 4 }}>{bodyError}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annulla</button>
          <button className="btn btn-primary" onClick={save}>Salva</button>
        </div>
      </div>
    </div>
  );
}
