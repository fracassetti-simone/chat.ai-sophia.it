import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  FolderPlus, Upload, Search, Home, ChevronRight, Folder, FolderOpen, Trash2,
  Download, Pencil, X, FileText, Image as ImageIcon, File as FileIcon, UserRound,
  FolderInput, Move,
} from 'lucide-react';
import { api, uploadFileWithProgress } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useModal } from '../context/ModalContext.jsx';
import { FolderAccessModal, AccessBadge } from '../components/AccessControl.jsx';

// ── helpers ────────────────────────────────────────────────────────────────
function formatSize(b) {
  if (!b) return '';
  const u = ['B','KB','MB','GB']; let i=0, n=b;
  while (n>=1024&&i<3){n/=1024;i++;} return `${n.toFixed(n<10&&i>0?1:0)} ${u[i]}`;
}
function isImage(m) { return /^image\//.test(m||''); }
function fileIcon(m) {
  if (isImage(m)) return ImageIcon;
  if (/pdf|word|text|markdown|json|document/.test(m||'')) return FileText;
  return FileIcon;
}

// ── Context Menu ───────────────────────────────────────────────────────────
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('contextmenu', onClose);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('contextmenu', onClose); };
  }, [onClose]);

  // Aggiusta posizione se fuori schermo
  const style = { position:'fixed', top: Math.min(y, window.innerHeight-200), left: Math.min(x, window.innerWidth-200), zIndex:9999 };
  return (
    <div className="ctx-menu card" style={style} ref={ref}>
      {items.map((item, i) => item === 'sep'
        ? <div key={i} className="ctx-sep"/>
        : <button key={i} className={`ctx-item${item.danger?' ctx-danger':''}`} onClick={() => { item.onClick(); onClose(); }}>
            {item.icon && <item.icon size={14}/>} {item.label}
          </button>
      )}
    </div>
  );
}

// ── Move-to-folder picker ──────────────────────────────────────────────────
function MovePicker({ tenantFolders, current, onSelect, onClose }) {
  const [open, setOpen] = useState(new Set());
  const toggle = (id) => setOpen(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });

  const buildTree = (folders, parentId=null) => folders.filter(f=>f.parentId===parentId).map(f => ({
    ...f, children: buildTree(folders, f.id),
  }));
  const tree = buildTree(tenantFolders || []);

  const Row = ({f, depth=0}) => (
    <>
      <button
        className={`folder-pick-row${f.id===current?' active':''}`}
        style={{paddingLeft: 12+depth*16}}
        onClick={() => { onSelect(f.id); onClose(); }}
      >
        <Folder size={14}/> {f.name}
        {f.children.length>0 && <span className="folder-pick-chevron" onClick={e=>{e.stopPropagation();toggle(f.id)}}><ChevronRight size={12}/></span>}
      </button>
      {open.has(f.id) && f.children.map(c=><Row key={c.id} f={c} depth={depth+1}/>)}
    </>
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" style={{maxWidth:340}} onClick={e=>e.stopPropagation()}>
        <div className="modal-head-row">
          <h3 className="modal-title" style={{margin:0}}>Sposta in…</h3>
          <button className="btn btn-ghost icon-btn" onClick={onClose}><X size={16}/></button>
        </div>
        <button className="folder-pick-row" onClick={() => { onSelect(null); onClose(); }}>
          <Home size={14}/> Root (nessuna cartella)
        </button>
        {tree.map(f=><Row key={f.id} f={f}/>)}
      </div>
    </div>
  );
}

// ── Main Cloud page ────────────────────────────────────────────────────────
export default function Cloud() {
  const toast = useToast();
  const modal = useModal();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Inizializza folderId da ?folder= oppure lo risolve da ?contactId= una volta sola
  const [folderId, setFolderId] = useState(searchParams.get('folder') || null);
  const [contactIdResolved, setContactIdResolved] = useState(false);

  useEffect(() => {
    const cid = searchParams.get('contactId');
    if (!cid) { setContactIdResolved(true); return; }
    if (contactIdResolved) return; // già risolto, non rieseguire
    api(`/cloud/contact/${cid}/folder`, { method: 'POST', body: {} })
      .then(r => {
        if (r.folderId) setFolderId(r.folderId);
        setContactIdResolved(true);
      })
      .catch(() => setContactIdResolved(true));
  }, []); // solo al mount — dipendenze vuote per evitare loop
  const [data, setData] = useState(null);
  const [allFolders, setAllFolders] = useState([]); // per il move-picker
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [preview, setPreview] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0); // 0-100
  const [uploadName, setUploadName] = useState('');
  const [ctxMenu, setCtxMenu] = useState(null); // {x,y,items}
  const [movePicker, setMovePicker] = useState(null); // {fileId?}|{folderId?}
  const [dragOver, setDragOver] = useState(null); // folderId being dragged over
  const [folderModal, setFolderModal] = useState(null); // {mode:'create'|'edit', folder?}
  const fileInput = useRef(null);

  // Permesso di scrittura nella cartella corrente (root = sempre scrivibile).
  const canWriteHere = folderId ? (data?.folder?.canWrite !== false) : true;

  const load = useCallback((id=folderId) => {
    const qs = id ? `?folderId=${encodeURIComponent(id)}` : '';
    return api(`/cloud${qs}`).then(setData).catch(()=>setData({folder:null,breadcrumb:[],folders:[],files:[]}));
  }, [folderId]);

  // Load all folders for the move picker (flat list)
  const loadAllFolders = useCallback(() => {
    // We call the root to get top-level; for a real tree we'd need a separate endpoint.
    // Simple approach: collect from breadcrumb + current + children recursively via multiple calls — but for now load root+current
    api('/cloud').then(r => setAllFolders(r.folders||[])).catch(()=>{});
  }, []);

  useEffect(() => {
    // Aspetta che il contactId sia stato risolto prima di caricare
    if (searchParams.get('contactId') && !contactIdResolved) return;
    load(folderId);
    loadAllFolders();
  }, [folderId, contactIdResolved]);

  // Search debounce
  useEffect(() => {
    if (!search.trim()) { setSearchResults(null); return; }
    const t = setTimeout(() => {
      api(`/cloud/search?q=${encodeURIComponent(search.trim())}`).then(r=>setSearchResults(r.files)).catch(()=>setSearchResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const newFolder = () => setFolderModal({ mode: 'create' });

  const editFolder = (f) => setFolderModal({ mode: 'edit', folder: f });

  // Salvataggio dal modal (crea o aggiorna nome + accessi).
  const saveFolder = async ({ name, access, accessUsers }) => {
    try {
      if (folderModal?.mode === 'edit') {
        await api(`/cloud/folders/${folderModal.folder.id}`, { method:'PATCH', body:{ name, access, accessUsers } });
        toast.info('Cartella aggiornata');
      } else {
        await api('/cloud/folders', { method:'POST', body:{ name, parentId:folderId, access, accessUsers } });
      }
      load();
    } catch(err) { toast.error(err.message); throw err; }
  };

  const deleteFolder = async (f) => {
    const ok = await modal.confirm(`Eliminare la cartella "${f.name}" e tutto il suo contenuto?`, { danger:true });
    if (!ok) return;
    try { await api(`/cloud/folders/${f.id}`, { method:'DELETE' }); load(); toast.info('Cartella eliminata'); }
    catch(err) { toast.error(err.message); }
  };

  const onUpload = async (e) => {
    const files = [...(e.target.files||[])]; if(!files.length) return;
    setUploading(true);
    let ok=0;
    for (const file of files) {
      setUploadName(file.name);
      setUploadProgress(0);
      try {
        await uploadFileWithProgress(
          '/cloud/files', file,
          { folderId: folderId||'' },
          (pct) => setUploadProgress(pct)
        );
        ok++;
      } catch(err) { toast.error(`${file.name}: ${err.message}`); }
    }
    setUploading(false); setUploadProgress(0); setUploadName('');
    if(fileInput.current) fileInput.current.value='';
    if(ok) toast.info(`${ok} file caricato${ok>1?'':'o'}`);
    load();
  };

  const deleteFile = async (f) => {
    const ok = await modal.confirm(`Eliminare "${f.filename}"?`, { danger:true });
    if (!ok) return;
    try { await api(`/cloud/files/${f.id}`, { method:'DELETE' }); setPreview(null); load(); toast.info('File eliminato'); }
    catch(err) { toast.error(err.message); }
  };

  const renameFile = async (f) => {
    const name = await modal.prompt('Rinomina file', { title:'Rinomina', defaultValue:f.filename });
    if (!name?.trim()||name===f.filename) return;
    try { await api(`/cloud/files/${f.id}`, { method:'PATCH', body:{ filename:name.trim() } }); load(); }
    catch(err) { toast.error(err.message); }
  };

  const moveFile = async (fileId, targetFolderId) => {
    try { await api(`/cloud/files/${fileId}`, { method:'PATCH', body:{ folderId:targetFolderId } }); load(); toast.info('File spostato'); }
    catch(err) { toast.error(err.message); }
  };

  // Context menu for folders
  const folderCtx = (e, f) => {
    e.preventDefault(); e.stopPropagation();
    const items = [{ label:'Apri', icon:FolderOpen, onClick:()=>setFolderId(f.id) }];
    if (f.canWrite !== false && !f.isContact) {
      items.push({ label:'Rinomina e permessi', icon:Pencil, onClick:()=>editFolder(f) });
      items.push('sep');
      items.push({ label:'Elimina', icon:Trash2, danger:true, onClick:()=>deleteFolder(f) });
    }
    setCtxMenu({ x:e.clientX, y:e.clientY, items });
  };

  // Context menu for files
  const fileCtx = (e, f) => {
    e.preventDefault(); e.stopPropagation();
    setCtxMenu({ x:e.clientX, y:e.clientY, items:[
      { label:'Anteprima', icon:FileIcon, onClick:()=>setPreview(f) },
      { label:'Scarica', icon:Download, onClick:()=>window.open(f.downloadUrl) },
      { label:'Rinomina', icon:Pencil, onClick:()=>renameFile(f) },
      { label:'Sposta…', icon:Move, onClick:()=>setMovePicker({ fileId:f.id }) },
      'sep',
      { label:'Elimina', icon:Trash2, danger:true, onClick:()=>deleteFile(f) },
    ]});
  };

  // Drag-and-drop files onto folders
  const onFileDragStart = (e, fileId) => { e.dataTransfer.setData('fileId', fileId); };
  const onFolderDragOver = (e, fid) => { e.preventDefault(); setDragOver(fid); };
  const onFolderDrop = async (e, targetFolderId) => {
    e.preventDefault(); setDragOver(null);
    const fileId = e.dataTransfer.getData('fileId');
    if (fileId) await moveFile(fileId, targetFolderId);
  };

  const showSearch = searchResults !== null;
  const folders = data?.folders||[];
  const files = showSearch ? searchResults : (data?.files||[]);
  const empty = !showSearch && folders.length===0 && files.length===0;

  return (
    <div>
      <div className="page-head-row">
        <div><h1 className="page-title">Cloud documentale</h1>
          <p className="page-subtitle">Tasto destro su file e cartelle per azioni rapide. Trascina i file sulle cartelle per spostarli.</p></div>
        <div className="cloud-actions">
          <button className="btn btn-outline" onClick={newFolder} disabled={!canWriteHere}><FolderPlus size={16}/> Nuova cartella</button>
          <button className="btn btn-primary" onClick={()=>fileInput.current?.click()} disabled={uploading||!canWriteHere}><Upload size={16}/> {uploading?'Carico…':'Carica file'}</button>
          <input ref={fileInput} type="file" multiple hidden onChange={onUpload}/>
        </div>
      </div>

      <div className="cloud-toolbar card">
        <nav className="breadcrumb">
          <button className="crumb" onClick={()=>{setFolderId(null);setSearch('');}}><Home size={15}/> Home</button>
          {(data?.breadcrumb||[]).map(b=>(
            <span key={b.id} className="crumb-wrap"><ChevronRight size={14} className="crumb-sep"/>
              <button className="crumb" onClick={()=>setFolderId(b.id)}>{b.name}</button></span>
          ))}
        </nav>
        <div className="search-box cloud-search">
          <Search size={16} className="search-ico"/>
          <input className="search-inp" placeholder="Cerca in tutto il cloud" value={search} onChange={e=>setSearch(e.target.value)}/>
          {search && <button className="search-clear" onClick={()=>setSearch('')}><X size={14}/></button>}
        </div>
      </div>

      {!data ? <div className="skeleton" style={{height:280}}/> :
       showSearch ? (
         <section className="cloud-section">
           <h2 className="cloud-section-title">Risultati per "{search}"</h2>
           {files.length===0 ? <p className="empty">Nessun file trovato.</p> :
             <FileGrid files={files} onPreview={setPreview} onDelete={deleteFile} onRename={renameFile} onDragStart={onFileDragStart} onCtx={fileCtx}/>}
         </section>
       ) : empty ? (
         <div className="card empty-state">
           <div className="empty-icon"><FolderOpen size={24} strokeWidth={1.75}/></div>
           <h3>Cartella vuota</h3>
           <p>Carica un file o crea una cartella. Puoi anche trascinare i file qui.</p>
           <button className="btn btn-primary" style={{marginTop:16}} onClick={()=>fileInput.current?.click()}><Upload size={16}/> Carica file</button>
         </div>
       ) : (
         <>
           {folders.length>0 && (
             <div className="folder-grid">
               {folders.map(f=>(
                 <div
                   key={f.id}
                   className={`folder-card card${dragOver===f.id?' drag-over':''}`}
                   onClick={()=>setFolderId(f.id)}
                   onContextMenu={e=>folderCtx(e,f)}
                   onDragOver={e=>onFolderDragOver(e,f.id)}
                   onDragLeave={()=>setDragOver(null)}
                   onDrop={e=>onFolderDrop(e,f.id)}
                 >
                   <div className="folder-ic">{f.isContact?<UserRound size={20}/>:<Folder size={20}/>}</div>
                   <div className="folder-meta">
                     <span className="folder-name">{f.name}</span>
                     <span className="folder-count">{f.itemCount} element{f.itemCount===1?'o':'i'}</span>
                     {!f.isContact && f.access && (
                       <div className="folder-access" style={{marginTop:6}}><AccessBadge access={f.access}/></div>
                     )}
                   </div>
                   {!f.isContact && f.canWrite !== false && (
                     <div className="folder-tools" onClick={e=>e.stopPropagation()}>
                       <button className="icon-btn-sm" title="Rinomina e permessi" onClick={()=>editFolder(f)}><Pencil size={14}/></button>
                       <button className="icon-btn-sm danger" title="Elimina" onClick={()=>deleteFolder(f)}><Trash2 size={14}/></button>
                     </div>
                   )}
                 </div>
               ))}
             </div>
           )}
           {files.length>0 && (
             <section className="cloud-section">
               <h2 className="cloud-section-title">File</h2>
               <FileGrid files={files} onPreview={setPreview} onDelete={deleteFile} onRename={renameFile} onDragStart={onFileDragStart} onCtx={fileCtx}/>
             </section>
           )}
         </>
       )
      }

      {uploading && (
        <div className="upload-progress-bar-wrap">
          <div className="upload-progress-info">
            <Upload size={14}/>
            <span>{uploadName}</span>
            <span className="upload-pct">{uploadProgress}%</span>
          </div>
          <div className="upload-progress-track">
            <div className="upload-progress-fill" style={{ width: `${uploadProgress}%` }}/>
          </div>
        </div>
      )}
      {ctxMenu && <ContextMenu {...ctxMenu} onClose={()=>setCtxMenu(null)}/>}
      {movePicker && (
        <MovePicker
          tenantFolders={allFolders}
          current={folderId}
          onSelect={async (targetId) => { await moveFile(movePicker.fileId, targetId); }}
          onClose={()=>setMovePicker(null)}
        />
      )}
      {folderModal && (
        <FolderAccessModal
          title={folderModal.mode === 'edit' ? 'Rinomina e permessi' : 'Nuova cartella'}
          initialName={folderModal.folder?.name || ''}
          initialAccess={folderModal.folder?.access}
          initialAccessUsers={folderModal.folder?.accessUsers || []}
          onSave={saveFolder}
          onClose={()=>setFolderModal(null)}
        />
      )}
    </div>
  );
}

function FileGrid({ files, onPreview, onDelete, onRename, onDragStart, onCtx }) {
  return (
    <div className="file-grid">
      {files.map(f=>{
        const Icon=fileIcon(f.mimeType);
        return (
          <div key={f.id} className="file-card card" draggable onDragStart={e=>onDragStart(e,f.id)} onContextMenu={e=>onCtx(e,f)}>
            <button className="file-thumb" onClick={()=>onPreview(f)}>
              {isImage(f.mimeType)?<img src={f.url} alt={f.filename} loading="lazy"/>:<Icon size={30} strokeWidth={1.5}/>}
            </button>
            <div className="file-info">
              <span className="file-name" title={f.filename}>{f.filename}</span>
              <span className="file-size">{formatSize(f.sizeBytes)}</span>
            </div>
            {f.tags?.length>0 && <div className="file-tags">{f.tags.slice(0,3).map(t=><span key={t} className="tag-chip sm">{t}</span>)}</div>}
            <div className="file-tools">
              <a className="icon-btn-sm" title="Scarica" href={f.downloadUrl}><Download size={14}/></a>
              <button className="icon-btn-sm" title="Rinomina" onClick={()=>onRename(f)}><Pencil size={14}/></button>
              <button className="icon-btn-sm danger" title="Elimina" onClick={()=>onDelete(f)}><Trash2 size={14}/></button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PreviewModal({ file, onClose, onDelete }) {
  const Icon = fileIcon(file.mimeType);
  const mime = file.mimeType || '';
  const [textContent, setTextContent] = useState(null);
  const [textLoading, setTextLoading] = useState(false);

  const isImg   = isImage(mime);
  const isPdf   = /pdf/.test(mime);
  const isVideo = /^video\//.test(mime);
  const isAudio = /^audio\//.test(mime);
  const isText  = /text\//.test(mime) || /\.(txt|md|csv|json|xml|html|htm|css|js|ts|jsx|tsx|log|yaml|yml|ini|toml|sh|py|rb|php|sql)$/i.test(file.filename);

  useEffect(() => {
    if (!isText) return;
    setTextLoading(true);
    fetch(file.url)
      .then(r => r.text())
      .then(t => { setTextContent(t); setTextLoading(false); })
      .catch(() => { setTextContent('Impossibile caricare il testo.'); setTextLoading(false); });
  }, [file.url, isText]);

  return (
    <div className="modal-backdrop preview-backdrop" onClick={onClose}>
      <div className="preview-modal-full" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="preview-modal-head">
          <Icon size={16} style={{ flexShrink: 0 }}/>
          <span className="preview-modal-name">{file.filename}</span>
          <span className="preview-modal-size">{file.sizeBytes > 1048576 ? `${(file.sizeBytes/1048576).toFixed(1)} MB` : `${Math.round(file.sizeBytes/1024)} KB`}</span>
          <div style={{ display:'flex', gap:6, marginLeft:'auto' }}>
            <a className="btn btn-outline btn-sm" href={file.downloadUrl} download><Download size={14}/> Scarica</a>
            <button className="btn btn-danger btn-sm" onClick={() => onDelete(file)}><Trash2 size={14}/> Elimina</button>
            <button className="btn btn-ghost icon-btn" onClick={onClose}><X size={18}/></button>
          </div>
        </div>

        {/* Body */}
        <div className="preview-modal-body">
          {isImg && (
            <img src={file.url} alt={file.filename} className="preview-img"/>
          )}
          {isPdf && (
            <iframe title={file.filename} src={file.url} className="preview-iframe"/>
          )}
          {isVideo && (
            <video controls className="preview-video">
              <source src={file.url} type={mime}/>
              Il tuo browser non supporta la riproduzione video.
            </video>
          )}
          {isAudio && (
            <div className="preview-audio-wrap">
              <Icon size={64} strokeWidth={1} style={{ color: 'var(--gray-300)', marginBottom: 20 }}/>
              <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 16 }}>{file.filename}</p>
              <audio controls style={{ width: '100%', maxWidth: 400 }}>
                <source src={file.url} type={mime}/>
              </audio>
            </div>
          )}
          {isText && (
            textLoading
              ? <div className="preview-loading"><div className="spinner"/></div>
              : <pre className="preview-text">{textContent}</pre>
          )}
          {!isImg && !isPdf && !isVideo && !isAudio && !isText && (
            <div className="preview-fallback-full">
              <Icon size={64} strokeWidth={1} style={{ color: 'var(--gray-300)' }}/>
              <p className="preview-fallback-name">{file.filename}</p>
              <p className="preview-fallback-hint">Anteprima non disponibile per questo tipo di file.</p>
              <a className="btn btn-primary" href={file.downloadUrl} download style={{ marginTop: 8 }}>
                <Download size={16}/> Scarica file
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
