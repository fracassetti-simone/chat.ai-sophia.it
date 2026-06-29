import { useEffect, useRef, useState } from 'react';
import { Code2, Copy, Plus, Upload, X } from 'lucide-react';
import { api, uploadFile } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';

const FEATURES = [
  { key: 'email', label: 'Email' },
  { key: 'whatsapp', label: 'WhatsApp' },
];

export default function Embed() {
  const toast = useToast();
  const logoInput = useRef(null);
  const [embeds, setEmbeds] = useState(null);
  const [active, setActive] = useState(null);
  const [snippet, setSnippet] = useState('');
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const load = () => api('/embed').then(({ embeds }) => {
    setEmbeds(embeds);
    if (embeds[0] && !active) setActive(embeds[0]);
  }).catch(() => setEmbeds([]));

  useEffect(() => { load(); }, []);

  const createNew = async () => {
    const { embed, snippet } = await api('/embed', { method: 'POST', body: { title: 'Assistente' } });
    setActive(embed); setSnippet(snippet); load();
  };

  const save = async () => {
    const { snippet } = await api(`/embed/${active.id}`, { method: 'PATCH', body: active });
    setSnippet(snippet);
    toast.info('Widget aggiornato');
  };

  const toggleFeature = (key) => {
    const mods = active.enabledFeatures?.modules || [];
    const next = mods.includes(key) ? mods.filter((m) => m !== key) : [...mods, key];
    setActive({ ...active, enabledFeatures: { ...active.enabledFeatures, modules: next } });
  };

  const onLogoSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.error('Il logo deve essere inferiore a 2 MB'); return; }
    setUploadingLogo(true);
    try {
      const res = await uploadFile('/documents', file);
      // The response includes both document.publicUrl and a top-level publicUrl
      const logoUrl = res.publicUrl || res.document?.publicUrl || `/api/documents/${res.document?.id}/file`;
      const updated = { ...active, logoUrl };
      setActive(updated);
      await api(`/embed/${active.id}`, { method: 'PATCH', body: updated });
      toast.info('Logo caricato');
    } catch (err) { toast.error('Errore upload logo: ' + err.message); }
    finally { setUploadingLogo(false); if (logoInput.current) logoInput.current.value = ''; }
  };

  const removeLogo = async () => {
    const updated = { ...active, logoUrl: null };
    setActive(updated);
    await api(`/embed/${active.id}`, { method: 'PATCH', body: updated });
  };

  if (!embeds) return <div className="skeleton" style={{ height: 300 }} />;

  if (!active) {
    return (
      <div>
        <h1 className="page-title">Embed</h1>
        <p className="page-subtitle">Crea una chat flottante da incorporare in qualsiasi sito.</p>
        <button className="btn btn-primary" onClick={createNew} style={{ marginTop: 16 }}>
          <Plus size={16} /> Crea widget
        </button>
      </div>
    );
  }

  const enabledMods = active.enabledFeatures?.modules || [];

  return (
    <div>
      <div className="page-head-row">
        <div><h1 className="page-title">Embed</h1>
          <p className="page-subtitle">Configura l'aspetto e le funzionalità del widget.</p></div>
        <button className="btn btn-primary" onClick={save}>Salva</button>
      </div>

      <div className="embed-cols">
        <div className="card panel">
          <div className="field"><label>Titolo</label>
            <input className="input" value={active.title} onChange={(e) => setActive({ ...active, title: e.target.value })} /></div>
          <div className="field"><label>Messaggio iniziale</label>
            <input className="input" value={active.welcomeMessage} onChange={(e) => setActive({ ...active, welcomeMessage: e.target.value })} /></div>

          {/* Logo upload — nessun URL manuale */}
          <div className="field">
            <label>Logo del widget</label>
            {active.logoUrl ? (
              <div className="logo-preview-row">
                <img src={active.logoUrl} alt="Logo widget" className="logo-preview-img" />
                <button className="btn btn-ghost icon-btn" onClick={removeLogo} title="Rimuovi logo"><X size={16} /></button>
              </div>
            ) : (
              <div className="logo-upload-area" onClick={() => logoInput.current?.click()}>
                <Upload size={18} />
                <span>{uploadingLogo ? 'Caricamento…' : 'Carica logo (PNG, SVG, JPG — max 2 MB)'}</span>
              </div>
            )}
            <input ref={logoInput} type="file" accept="image/*" hidden onChange={onLogoSelect} disabled={uploadingLogo} />
          </div>

          <div className="row-2">
            <div className="field"><label>Colore principale</label>
              <input className="input" type="color" value={active.primaryColor} onChange={(e) => setActive({ ...active, primaryColor: e.target.value })} /></div>
            <div className="field"><label>Larghezza (px)</label>
              <input className="input" type="number" value={active.width} onChange={(e) => setActive({ ...active, width: Number(e.target.value) })} /></div>
          </div>

          <label className="section-label" style={{ marginTop: 8 }}>Funzionalità accessibili al widget</label>
          <div className="feature-toggles">
            {FEATURES.map((feat) => (
              <label key={feat.key} className="toggle-row">
                <span>{feat.label}</span>
                <input type="checkbox" checked={enabledMods.includes(feat.key)} onChange={() => toggleFeature(feat.key)} />
              </label>
            ))}
            <label className="toggle-row">
              <span>Ricerca internet</span>
              <input type="checkbox" checked={!!active.enabledFeatures?.internet}
                onChange={(e) => setActive({ ...active, enabledFeatures: { ...active.enabledFeatures, internet: e.target.checked } })} />
            </label>
            <label className="toggle-row">
              <span>Prompt personalizzato</span>
              <input type="checkbox" checked={active.enabledFeatures?.prompt !== false}
                onChange={(e) => setActive({ ...active, enabledFeatures: { ...active.enabledFeatures, prompt: e.target.checked } })} />
            </label>
          </div>
        </div>

        <div className="card panel">
          <h3 className="panel-title"><Code2 size={16} /> Snippet di installazione</h3>
          <p className="page-subtitle">Incolla questo codice nel tuo sito, prima di &lt;/body&gt;.</p>
          <pre className="snippet-box"><code>{snippet || 'Salva il widget per generare lo snippet.'}</code></pre>
          {snippet && (
            <button className="btn btn-outline" onClick={() => { navigator.clipboard.writeText(snippet); toast.info('Snippet copiato'); }}>
              <Copy size={15} /> Copia snippet
            </button>
          )}
          <WidgetPreview embed={active} />
        </div>
      </div>
    </div>
  );
}

function WidgetPreview({ embed }) {
  const color = embed.primaryColor || '#2563eb';
  const title = embed.title || 'Assistente';
  const welcome = embed.welcomeMessage || 'Ciao! Come posso aiutarti?';
  return (
    <div className="widget-preview" style={{ marginTop: 20 }}>
      <p className="panel-title" style={{ marginBottom: 10 }}>Anteprima</p>
      <div className="widget-preview-stage">
        {/* Pannello chat aperto */}
        <div className="widget-preview-panel">
          <div className="widget-preview-header" style={{ background: color }}>
            <div className="widget-preview-avatar">
              {embed.logoUrl
                ? <img src={embed.logoUrl} alt="logo" />
                : <span>{title.charAt(0).toUpperCase()}</span>}
            </div>
            <div className="widget-preview-htext">
              <strong>{title}</strong>
              <span>Online</span>
            </div>
          </div>
          <div className="widget-preview-body">
            <div className="widget-preview-msg">{welcome}</div>
          </div>
          <div className="widget-preview-input">
            <span>Scrivi un messaggio…</span>
            <div className="widget-preview-send" style={{ background: color }} />
          </div>
        </div>

        {/* Launcher */}
        <div className="widget-preview-bubble" style={{ background: color }}>
          {embed.logoUrl
            ? <img src={embed.logoUrl} alt="logo" style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'contain' }} />
            : <span style={{ color: '#fff', fontSize: 20, fontWeight: 700 }}>{title.charAt(0).toUpperCase()}</span>}
        </div>
      </div>
    </div>
  );
}
