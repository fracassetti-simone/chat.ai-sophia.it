import { useState, useEffect, useCallback } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, MessageSquare, GraduationCap, Blocks, PlugZap,
  Users as UsersIcon, Building2, KeyRound, Code2, Settings, LogOut, Check, Zap, Phone,
  BookUser, FolderClosed, ChevronDown, Calendar, Mail, ClipboardList, Clock, BookOpen, FileText,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useTenant } from '../context/TenantContext.jsx';
import { PERMISSIONS } from '../lib/permissions.js';
import { api } from '../lib/api.js';

// Icona WhatsApp SVG inline
function WhatsAppIcon({ size = 17 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
      <path d="M12 0C5.373 0 0 5.373 0 12c0 2.118.554 4.103 1.523 5.824L.057 23.882a.5.5 0 0 0 .613.613l6.058-1.466A11.95 11.95 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.847 0-3.584-.485-5.089-1.333l-.365-.211-3.787.916.933-3.786-.217-.374A9.957 9.957 0 0 1 2 12C2 6.478 6.478 2 12 2s10 4.478 10 10-4.478 10-10 10z"/>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Regole di visibilità per ruolo
//
// SUPER_ADMIN: vede tutto
// ADMIN (tenant): vede le sezioni operative + le sezioni config solo se il
//                 modulo "config-manage" è attivo per il suo tenant.
//                 Non vede mai: Aziende, API Key, Riferimento API, Connetti API.
//                 Non può mai attivare/disattivare moduli (read-only).
// MEMBER: solo Chat
// ─────────────────────────────────────────────────────────────────────────────

export default function Shell() {
  const { user, logout, can } = useAuth();
  const { isSuper, hasTenant, tenants, activeId, activeTenant, selectTenant } = useTenant();
  const navigate = useNavigate();

  const isAdmin = user?.role === 'ADMIN';
  const isMember = user?.role === 'MEMBER';

  // Moduli attivi per il tenant corrente (usati per condizionare voci nav)
  const [enabledModules, setEnabledModules] = useState(new Set());
  useEffect(() => {
    if (!activeId) return;
    api('/modules').then(({ modules }) => {
      setEnabledModules(new Set(modules.filter(m => m.enabled && m.installed).map(m => m.key)));
    }).catch(() => {});
  }, [activeId]);

  // L'admin vede la sezione config solo se il modulo "config-manage" è attivo
  const adminHasConfig = isAdmin && enabledModules.has('config-manage');

  const initials = (user.name || user.email).slice(0, 2).toUpperCase();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sophia-logo">Sophia</span>
        </div>
        <nav className="sidebar-nav">

          {/* ── Dati (database visibili in sidebar — solo se modulo attivo e schemi visibili) ── */}
          {!isSuper && <DatiGroup enabledModules={enabledModules}/>}

          {/* ── Generale ── */}
          <div className="nav-section">
            <div className="nav-section-label">Generale</div>
            <NavLink to="/" end className="nav-item"><LayoutDashboard size={17} strokeWidth={1.75}/><span>Dashboard</span></NavLink>
          </div>

          {/* ── Comunicazione (tutti i ruoli con tenant) ── */}
          {(isSuper ? hasTenant : true) && (
            <div className="nav-section">
              <div className="nav-section-label">Comunicazione</div>
              <ChatGroup />
            </div>
          )}

          {/* ── Clienti e dati (admin + super) ── */}
          {!isMember && (isSuper ? hasTenant : true) && (
            <div className="nav-section">
              <div className="nav-section-label">Clienti e dati</div>
              <NavLink to="/contacts"  className="nav-item"><BookUser size={17} strokeWidth={1.75}/><span>Rubrica</span></NavLink>
              <NavLink to="/cloud"     className="nav-item"><FolderClosed size={17} strokeWidth={1.75}/><span>Cloud</span></NavLink>
              <NavLink to="/calendar"  className="nav-item"><Calendar size={17} strokeWidth={1.75}/><span>Calendario</span></NavLink>
              <NavLink to="/email"     className="nav-item"><Mail size={17} strokeWidth={1.75}/><span>Email</span></NavLink>
              <NavLink to="/compiler"  className="nav-item"><FileText size={17} strokeWidth={1.75}/><span>Moduli PDF</span></NavLink>
            </div>
          )}

          {/* ── Operativo (admin + super, non member) ── */}
          {!isMember && (isSuper ? hasTenant : true) && (
            <div className="nav-section">
              <div className="nav-section-label">Operativo</div>
              <NavLink to="/training"    className="nav-item"><GraduationCap size={17} strokeWidth={1.75}/><span>Agenti AI</span></NavLink>
              <NavLink to="/automations" className="nav-item"><Clock size={17} strokeWidth={1.75}/><span>Automazioni</span></NavLink>
              <NavLink to="/users"       className="nav-item"><UsersIcon size={17} strokeWidth={1.75}/><span>Utenti</span></NavLink>
            </div>
          )}

          {/* ── Configurazione avanzata ── */}
          {/* Super admin: vede tutto. Admin solo se config-manage è attivo. */}
          {(isSuper || adminHasConfig) && (isSuper ? true : hasTenant !== false) && (
            <div className="nav-section">
              <div className="nav-section-label">Configurazione</div>

              {/* Dati da raccogliere: super + admin con config-manage */}
              {(isSuper || adminHasConfig) && (
                <NavLink to="/collect-fields" className="nav-item"><ClipboardList size={17} strokeWidth={1.75}/><span>Dati da raccogliere</span></NavLink>
              )}

              {/* Moduli: super può toccarli, admin li vede read-only */}
              {(isSuper || adminHasConfig) && (
                <NavLink to="/modules" className="nav-item"><Blocks size={17} strokeWidth={1.75}/><span>Moduli</span></NavLink>
              )}

              {/* Flussi: super + admin con config-manage, solo se modulo flows attivo */}
              {(isSuper || adminHasConfig) && enabledModules.has('flows') && (
                <NavLink to="/flows" className="nav-item"><Zap size={17} strokeWidth={1.75}/><span>Flussi</span></NavLink>
              )}

              {/* Embed: super + admin con config-manage */}
              {(isSuper || adminHasConfig) && (
                <NavLink to="/embed" className="nav-item"><Code2 size={17} strokeWidth={1.75}/><span>Embed</span></NavLink>
              )}

              {/* Connetti API: solo super admin */}
              {isSuper && (
                <NavLink to="/endpoints" className="nav-item"><PlugZap size={17} strokeWidth={1.75}/><span>Connetti API</span></NavLink>
              )}
              {/* Database: super admin vede sempre; admin se modulo attivo */}
              {(isSuper || (!isSuper && enabledModules.has('database'))) && (
                <NavLink to="/database" className="nav-item">
                  <ion-icon name="server-outline" style={{ fontSize: 17, flexShrink: 0 }}/>
                  <span>Database</span>
                </NavLink>
              )}
            </div>
          )}

          {/* ── Credenziali SIP: super admin + admin (sempre visibile, a prescindere da config-manage) ── */}
          {(isSuper || isAdmin) && !isMember && (isSuper ? hasTenant : true) && (
            <div className="nav-section">
              <div className="nav-section-label">Telefonia</div>
              <NavLink to="/sip" className="nav-item"><Phone size={17} strokeWidth={1.75}/><span>Credenziali SIP</span></NavLink>
            </div>
          )}

          {/* ── Amministrazione: solo super admin ── */}
          {isSuper && (
            <div className="nav-section">
              <div className="nav-section-label">Amministrazione</div>
              <NavLink to="/tenants"       className="nav-item"><Building2 size={17} strokeWidth={1.75}/><span>Aziende</span></NavLink>
              <NavLink to="/apikeys"       className="nav-item"><KeyRound size={17} strokeWidth={1.75}/><span>API Key</span></NavLink>
              <NavLink to="/api-reference" className="nav-item"><BookOpen size={17} strokeWidth={1.75}/><span>Riferimento API</span></NavLink>
            </div>
          )}

        </nav>
        <div className="sidebar-foot">
          <NavLink to="/settings" className="nav-item">
            <Settings size={17} strokeWidth={1.75}/><span>Impostazioni</span>
          </NavLink>
          <button className="nav-item nav-logout" onClick={async () => { await logout(); navigate('/'); }}>
            <LogOut size={17} strokeWidth={1.75}/><span>Esci</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            {isSuper && (
              <TenantSwitcher
                tenants={tenants} activeId={activeId}
                activeTenant={activeTenant} onSelect={selectTenant}
                onManage={() => navigate('/tenants')}
              />
            )}
          </div>
          <div className="topbar-user">
            <span className={`role-pill role-${user.role.toLowerCase()}`}>
              {user.role === 'SUPER_ADMIN' ? 'Super Admin' : user.role === 'ADMIN' ? 'Admin' : 'Utente'}
            </span>
            <div className="avatar">{initials}</div>
            <div className="user-meta">
              <div className="user-name">{user.name || user.email}</div>
              <div className="user-email">{user.email}</div>
            </div>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

// ── Sotto-menu Dati (database visibili in sidebar) ───────────────────────────
function DatiGroup({ enabledModules }) {
  const location = useLocation();
  const [dbSchemas, setDbSchemas] = useState([]);
  const isActive = location.pathname.startsWith('/database');

  const loadSchemas = useCallback(() => {
    if (!enabledModules.has('database')) return;
    api('/db/schemas').then(({ schemas }) => {
      setDbSchemas((schemas || []).filter(s => s.showInSidebar));
    }).catch(() => {});
  }, [enabledModules]);

  useEffect(() => { loadSchemas(); }, [loadSchemas]);

  // Aggiornamenti realtime schema
  useEffect(() => {
    window.addEventListener('sophia:db:schema:created', loadSchemas);
    window.addEventListener('sophia:db:schema:updated', loadSchemas);
    window.addEventListener('sophia:db:schema:deleted', loadSchemas);
    return () => {
      window.removeEventListener('sophia:db:schema:created', loadSchemas);
      window.removeEventListener('sophia:db:schema:updated', loadSchemas);
      window.removeEventListener('sophia:db:schema:deleted', loadSchemas);
    };
  }, [loadSchemas]);

  if (!enabledModules.has('database') || dbSchemas.length === 0) return null;

  // ≤5 database → flat (primo livello, no dropdown), >5 → dropdown espandibile
  const flat = dbSchemas.length <= 5;

  return (
    <div className="nav-section">
      <div className="nav-section-label">Dati</div>
      {flat ? (
        // Flat: ogni database è direttamente una voce di primo livello
        dbSchemas.map(s => (
          <NavLink key={s.id} to={`/database/${s.id}`} className="nav-item">
            <ion-icon name={s.icon || 'server-outline'} style={{ fontSize: 17, flexShrink: 0 }}/>
            <span>{s.name}</span>
          </NavLink>
        ))
      ) : (
        // Dropdown espandibile
        <ChatGroup_Dati dbSchemas={dbSchemas} isActive={isActive} />
      )}
    </div>
  );
}

// Sotto-menu espandibile per >5 database
function ChatGroup_Dati({ dbSchemas, isActive }) {
  const [open, setOpen] = useState(isActive);
  useEffect(() => { if (isActive) setOpen(true); }, [isActive]);
  return (
    <div className="nav-group">
      <button className={`nav-item nav-group-btn${isActive ? ' active' : ''}`} onClick={() => setOpen(o => !o)}>
        <ion-icon name="server-outline" style={{ fontSize: 17, flexShrink: 0 }}/>
        <span>Tutti i database</span>
        <ChevronDown size={14} className={`group-chevron${open ? ' open' : ''}`}/>
      </button>
      {open && (
        <div className="nav-group-children">
          {dbSchemas.map(s => (
            <NavLink key={s.id} to={`/database/${s.id}`} className="nav-item nav-child">
              <ion-icon name={s.icon || 'server-outline'} style={{ fontSize: 15, flexShrink: 0 }}/>
              <span>{s.name}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
function ChatGroup() {
  const location = useLocation();
  const navigate = useNavigate();
  const isActive = location.pathname.startsWith('/chat') || location.pathname.startsWith('/external-chats');
  const [open, setOpen] = useState(isActive);
  useEffect(() => { if (isActive) setOpen(true); }, [isActive]);

  // Naviga alla chat esterna più recente se disponibile
  const openLatestExternalChat = async (e) => {
    // Se siamo già in external-chats con un id specifico, non fare nulla
    if (location.pathname.startsWith('/external-chats/')) return;
    // Se siamo già in external-chats senza id, non navigare altrove
    if (location.pathname === '/external-chats') return;
    try {
      const { chats } = await api('/external-chats');
      if (chats && chats.length > 0) {
        // L'API ritorna già ordinata per updatedAt desc
        navigate(`/external-chats/${chats[0].id}`);
      } else {
        navigate('/external-chats');
      }
    } catch {
      navigate('/external-chats');
    }
  };

  return (
    <div className="nav-group">
      <button className={`nav-item nav-group-btn${isActive ? ' active' : ''}`} onClick={() => setOpen(o => !o)}>
        <MessageSquare size={17} strokeWidth={1.75}/>
        <span>Chat</span>
        <ChevronDown size={14} className={`group-chevron${open ? ' open' : ''}`}/>
      </button>
      {open && (
        <div className="nav-group-children">
          <NavLink to="/chat"           className="nav-item nav-child"><MessageSquare size={15} strokeWidth={1.75}/><span>Le tue chat</span></NavLink>
          <NavLink to="/external-chats" className="nav-item nav-child" onClick={openLatestExternalChat}>
            <WhatsAppIcon size={15}/><span>WhatsApp e altro</span>
          </NavLink>
        </div>
      )}
    </div>
  );
}

// ── Tenant switcher ──────────────────────────────────────────────────────────
function TenantSwitcher({ tenants, activeId, activeTenant, onSelect, onManage }) {
  if (!tenants.length) {
    return <button className="tenant-switch empty" onClick={onManage}><Building2 size={16}/> Crea la prima azienda</button>;
  }
  return (
    <div className="tenant-switch">
      <Building2 size={16} className="ts-icon"/>
      <select className="ts-select" value={activeId || ''} onChange={e => onSelect(e.target.value)}>
        {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      {activeTenant && <Check size={15} className="ts-check"/>}
    </div>
  );
}
