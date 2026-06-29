import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  MessageSquare, Users as UsersIcon, Blocks, KeyRound, Building2, Activity,
  Coins, ArrowDownToLine, DatabaseZap, ArrowUpFromLine,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useTenant } from '../context/TenantContext.jsx';

const STAT_LINKS = {
  conversations: '/chat',
  users: '/users',
  activeModules: '/modules',
  aiMessages7d: '/external-chats',
  apiKeys: '/apikeys',
  tenants: '/tenants',
};

const ICONS = {
  conversations: MessageSquare,
  users: UsersIcon,
  activeModules: Blocks,
  apiKeys: KeyRound,
  tenants: Building2,
  aiMessages7d: Activity,
};

const LABELS = {
  conversations: 'Conversazioni',
  users: 'Utenti',
  activeModules: 'Moduli attivi',
  apiKeys: 'API Key',
  tenants: 'Aziende',
  aiMessages7d: 'Messaggi AI (7g)',
};

const intFmt = new Intl.NumberFormat('it-IT');
const fmtInt = (n) => intFmt.format(Math.round(n || 0));
function fmtEur(n) {
  const v = Number(n) || 0;
  const decimals = v !== 0 && Math.abs(v) < 1 ? 4 : 2;
  return '€' + v.toLocaleString('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const PERIODS = [
  { days: 7, label: '7 giorni' },
  { days: 30, label: '30 giorni' },
  { days: 90, label: '90 giorni' },
];

function StatCard({ k, value }) {
  const navigate = useNavigate();
  const Icon = ICONS[k] || Activity;
  const link = STAT_LINKS[k];
  return (
    <div
      className={`stat-card card${link ? ' stat-card-link' : ''}`}
      onClick={link ? () => navigate(link) : undefined}
      role={link ? 'button' : undefined}
      tabIndex={link ? 0 : undefined}
      onKeyDown={link ? (e) => e.key === 'Enter' && navigate(link) : undefined}
    >
      <div className="stat-icon"><Icon size={18} strokeWidth={1.75} /></div>
      <div className="stat-value">{value ?? 0}</div>
      <div className="stat-label">{LABELS[k] || k}</div>
    </div>
  );
}

function CostSection() {
  const { activeId } = useTenant();
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    const qs = `?from=${from.toISOString()}&to=${to.toISOString()}`;
    api(`/usage/summary${qs}`)
      .then((res) => { if (alive) { setData(res); setLoading(false); } })
      .catch(() => { if (alive) { setError(true); setLoading(false); } });
    return () => { alive = false; };
  }, [days, activeId]);

  const totals = data?.totals;
  const hasData = totals && totals.calls > 0;

  return (
    <section className="cost-block">
      <div className="cost-head">
        <div>
          <h2 className="section-title">Consumo e costi</h2>
          <p className="section-sub">
            {data?.scope === 'all'
              ? 'Token e spesa stimata di tutte le aziende.'
              : 'Token e spesa stimata per l\'azienda selezionata.'}
          </p>
        </div>
        <div className="seg">
          {PERIODS.map((p) => (
            <button key={p.days} className={`seg-btn${days === p.days ? ' active' : ''}`} onClick={() => setDays(p.days)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="cost-grid">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}
        </div>
      ) : error ? (
        <div className="card panel"><p className="empty">Impossibile caricare i consumi. Riprova tra poco.</p></div>
      ) : !hasData ? (
        <div className="card empty-state">
          <div className="empty-icon"><Coins size={24} strokeWidth={1.75} /></div>
          <h3>Ancora nessun consumo</h3>
          <p>I token e i costi appariranno qui non appena l'assistente verrà utilizzato.</p>
        </div>
      ) : (
        <>
          <div className="cost-grid">
            <div className="cost-card hero card">
              <div className="cost-icon primary"><Coins size={18} strokeWidth={1.75} /></div>
              <div className="cost-value">{fmtEur(totals.costUsd)}</div>
              <div className="cost-label">Costo stimato</div>
              <div className="cost-foot">{fmtInt(totals.calls)} richieste AI nel periodo</div>
            </div>
            <div className="cost-card card">
              <div className="cost-icon"><ArrowDownToLine size={18} strokeWidth={1.75} /></div>
              <div className="cost-value">{fmtInt(totals.inputTokens)}</div>
              <div className="cost-label">Token input</div>
            </div>
            <div className="cost-card card">
              <div className="cost-icon"><DatabaseZap size={18} strokeWidth={1.75} /></div>
              <div className="cost-value">{fmtInt(totals.cachedInputTokens)}</div>
              <div className="cost-label">Token input in cache</div>
            </div>
            <div className="cost-card card">
              <div className="cost-icon"><ArrowUpFromLine size={18} strokeWidth={1.75} /></div>
              <div className="cost-value">{fmtInt(totals.outputTokens)}</div>
              <div className="cost-label">Token output</div>
            </div>
          </div>

          <div className="cost-cols">
            <section className="card panel">
              <div className="panel-head">
                <h3 className="panel-title">Andamento spesa giornaliera</h3>
                <span className="panel-meta">{data.series.length} giorni</span>
              </div>
              <CostChart series={data.series} />
            </section>

            <section className="card panel">
              <div className="panel-head"><h3 className="panel-title">Spesa per canale</h3></div>
              {data.bySource.length === 0 ? <p className="empty small">Nessun dato.</p> : (
                <ul className="bar-list">
                  {data.bySource.map((s) => {
                    const max = data.bySource[0].costUsd || 1;
                    const pct = Math.max(3, Math.round((s.costUsd / max) * 100));
                    return (
                      <li key={s.key} className="bar-row">
                        <div className="bar-row-top">
                          <span className="bar-name">{s.label}</span>
                          <span className="bar-val">{fmtEur(s.costUsd)}</span>
                        </div>
                        <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
                        <span className="bar-sub">{fmtInt(s.totalTokens)} token</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          {data.byTenant?.length > 0 && (
            <section className="card panel">
              <div className="panel-head">
                <h3 className="panel-title">Consumo per azienda</h3>
                <span className="panel-meta">{data.byTenant.length} aziende</span>
              </div>
              <div className="cost-table-wrap">
                <table className="cost-table">
                  <thead>
                    <tr>
                      <th>Azienda</th>
                      <th className="num">Input</th>
                      <th className="num">In cache</th>
                      <th className="num">Output</th>
                      <th className="num">Richieste</th>
                      <th className="num">Costo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byTenant.map((t) => (
                      <tr key={t.tenantId}>
                        <td className="cell-name">{t.name}</td>
                        <td className="num">{fmtInt(t.inputTokens)}</td>
                        <td className="num">{fmtInt(t.cachedInputTokens)}</td>
                        <td className="num">{fmtInt(t.outputTokens)}</td>
                        <td className="num">{fmtInt(t.calls)}</td>
                        <td className="num strong">{fmtEur(t.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </section>
  );
}

function CostChart({ series }) {
  const { bars, max, ticks } = useMemo(() => {
    const max = Math.max(0, ...series.map((d) => d.costUsd));
    const n = series.length;
    const step = n > 0 ? 100 / n : 100;
    const gap = Math.min(step * 0.3, 1.4);
    const bw = Math.max(0.4, step - gap);
    const bars = series.map((d, i) => ({ x: i * step + (step - bw) / 2, w: bw, h: max > 0 ? (d.costUsd / max) * 100 : 0, d }));
    const tickCount = Math.min(6, n);
    const ticks = [];
    if (tickCount > 1) {
      for (let i = 0; i < tickCount; i++) {
        const idx = Math.round((i * (n - 1)) / (tickCount - 1));
        const dt = new Date(series[idx].date);
        ticks.push({ x: idx * step + step / 2, label: `${dt.getUTCDate()}/${dt.getUTCMonth() + 1}` });
      }
    }
    return { bars, max, ticks };
  }, [series]);

  if (!series.length) return <p className="empty small">Nessun dato.</p>;

  return (
    <div className="chart">
      <svg viewBox="0 0 100 56" preserveAspectRatio="none" className="chart-svg">
        <line x1="0" y1="48" x2="100" y2="48" className="chart-axis" />
        {bars.map((b, i) => (
          <rect key={i} x={b.x} y={48 - (b.h / 100) * 46} width={b.w} height={Math.max(0, (b.h / 100) * 46)} rx="0.4" className="chart-bar">
            <title>{`${new Date(b.d.date).toLocaleDateString('it-IT')} — ${fmtEur(b.d.costUsd)} (${fmtInt(b.d.totalTokens)} token)`}</title>
          </rect>
        ))}
        {ticks.map((t, i) => (
          <text key={i} x={t.x} y="54" className="chart-tick" textAnchor="middle">{t.label}</text>
        ))}
      </svg>
      <div className="chart-legend"><span>Max giorno: <strong>{fmtEur(max)}</strong></span></div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const isManager = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN';

  useEffect(() => {
    api('/dashboard').then(setData).catch(() => setData({ stats: {}, recentConversations: [] }));
  }, []);

  if (!data) {
    return (
      <div>
        <h1 className="page-title">Dashboard</h1>
        <div className="stat-grid">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 104 }} />)}
        </div>
      </div>
    );
  }

  const order = ['conversations', 'users', 'activeModules', 'aiMessages7d', 'apiKeys', 'tenants'];
  const stats = order.filter((k) => k in data.stats);

  return (
    <div>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-subtitle">Panoramica in tempo reale della tua attività.</p>

      <div className="stat-grid">
        {stats.map((k) => <StatCard key={k} k={k} value={data.stats[k]} />)}
      </div>

      {isManager && <CostSection />}

      <section className="card panel" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <h2 className="panel-title">Ultime conversazioni</h2>
          <Link to="/chat" className="panel-link">Apri chat</Link>
        </div>
        {(data.recentConversations || []).length === 0 ? (
          <p className="empty">Nessuna conversazione ancora. Inizia una nuova chat.</p>
        ) : (
          <ul className="list">
            {data.recentConversations.map((c) => (
              <li key={c.id}>
                <Link to={`/chat/${c.id}`} className="list-row">
                  <MessageSquare size={16} strokeWidth={1.75} className="list-icon" />
                  <span className="list-main">{c.title}</span>
                  <span className="list-meta">{new Date(c.updatedAt).toLocaleDateString('it-IT')}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
