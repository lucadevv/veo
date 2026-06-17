/* VEO Admin — pantallas compartidas (clicable + lienzo). Inyecta CSS y exporta window.ADM. */
if (!document.getElementById('adm-css')) {
  const st = document.createElement('style');
  st.id = 'adm-css';
  st.textContent = `
  :root{
    --bg:#f4f6f9;--surface:#ffffff;--surface2:#eef1f6;--sidebar:#141b2d;--sidebar2:#1d2540;
    --ink:#1b2235;--ink-muted:#5b6478;--ink-subtle:#8a93a4;
    --border:#e6e9ef;--border-strong:#d3d8e2;
    --brand:#27304a;--accent:#1f7fd4;--accent-soft:#e8f1fb;--on-accent:#fff;
    --success:#1f9d6b;--success-soft:#e6f5ee;--warn:#c98a16;--warn-soft:#fbf2df;
    --danger:#d8453e;--danger-soft:#fbe9e8;
    --font-u:'Inter',sans-serif;--font-m:'JetBrains Mono',monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
  html,body{height:100%;}
  body{font-family:var(--font-u);background:#0c1018;color:var(--ink);display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden;}
  #stage{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;}
  #scaler{width:1360px;height:850px;flex:none;transform-origin:center;}
  #root{width:100%;height:100%;}
  .app{width:100%;height:100%;background:var(--bg);border-radius:14px;overflow:hidden;display:flex;box-shadow:0 30px 80px -20px rgba(0,0,0,.6);}
  .mono{font-family:var(--font-m);font-variant-numeric:tabular-nums;}
  .muted{color:var(--ink-muted);}.sub{color:var(--ink-subtle);}
  /* sidebar */
  .side{width:236px;background:var(--sidebar);color:#c4cbdb;flex:none;display:flex;flex-direction:column;padding:18px 14px;}
  .side .brand{display:flex;align-items:center;gap:10px;padding:6px 8px 18px;}
  .side .grp{font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#6c7790;margin:16px 8px 6px;}
  .nav{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:9px;font-size:13.5px;font-weight:500;cursor:pointer;color:#aab2c5;transition:.12s;}
  .nav:hover{background:var(--sidebar2);color:#fff;}
  .nav.on{background:rgba(31,127,212,.18);color:#5db0f0;font-weight:600;}
  .nav .ct{margin-left:auto;font-size:11px;font-weight:700;background:var(--danger);color:#fff;border-radius:99px;padding:1px 7px;}
  /* main */
  .main{flex:1;display:flex;flex-direction:column;min-width:0;}
  .top{height:60px;flex:none;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:16px;padding:0 22px;}
  .search{flex:1;max-width:420px;height:38px;background:var(--surface2);border:1px solid var(--border);border-radius:9px;display:flex;align-items:center;gap:9px;padding:0 12px;color:var(--ink-subtle);font-size:13px;}
  .badge{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:8px;font-size:12px;font-weight:600;}
  .body{flex:1;overflow:auto;padding:22px 24px;}
  .h1{font-size:22px;font-weight:700;letter-spacing:-.01em;}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;}
  .pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:99px;font-size:11.5px;font-weight:600;}
  .dot{width:7px;height:7px;border-radius:50%;}
  .btn{appearance:none;border:none;cursor:pointer;font-family:var(--font-u);font-weight:600;border-radius:9px;height:38px;padding:0 16px;font-size:13.5px;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:.12s;}
  .btn-accent{background:var(--accent);color:#fff;}.btn-accent:hover{filter:brightness(1.05);}
  .btn-ghost{background:var(--surface);color:var(--ink);border:1px solid var(--border-strong);}
  .btn-danger{background:var(--danger);color:#fff;}
  .btn-sm{height:32px;padding:0 12px;font-size:12.5px;border-radius:8px;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{text-align:left;font-size:11px;font-weight:600;color:var(--ink-subtle);text-transform:uppercase;letter-spacing:.04em;padding:11px 14px;border-bottom:1px solid var(--border);}
  td{padding:11px 14px;border-bottom:1px solid var(--border);}
  tr.clk{cursor:pointer;}tr.clk:hover td{background:var(--surface2);}
  .tabs{display:flex;gap:4px;background:var(--surface2);border:1px solid var(--border);border-radius:9px;padding:3px;}
  .tabs button{border:none;background:transparent;font-family:var(--font-u);font-weight:600;font-size:12.5px;color:var(--ink-muted);padding:7px 14px;border-radius:7px;cursor:pointer;}
  .tabs button.on{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.06);}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;}
  .kpi .v{font-size:26px;font-weight:700;margin-top:6px;}
  .map{background:#e9ecf1;border-radius:12px;position:relative;overflow:hidden;}
  .panicbar{background:var(--danger);color:#fff;display:flex;align-items:center;gap:12px;padding:11px 22px;font-size:13.5px;font-weight:600;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.45;}}
  .pulse{animation:pulse 1.4s ease-in-out infinite;}
  .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1b2235;color:#fff;font-size:13px;font-weight:500;padding:11px 18px;border-radius:10px;z-index:80;box-shadow:0 12px 30px rgba(0,0,0,.3);}
  .modal-bg{position:absolute;inset:0;background:rgba(15,20,30,.45);display:flex;align-items:center;justify-content:center;z-index:60;}
  .modal{background:var(--surface);border-radius:14px;width:420px;padding:24px;box-shadow:0 30px 80px -20px rgba(0,0,0,.4);}
`;
  document.head.appendChild(st);
}
const { useState, useEffect } = React;
function fit() {
  const s = document.getElementById('scaler');
  if (!s) return;
  const k = Math.min(window.innerWidth / 1360, window.innerHeight / 850);
  s.style.transform = 'scale(' + k + ')';
}
window.addEventListener('resize', fit);

const I = {
  eye: () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  grid: () => (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  car: () => (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11M5 11h14v5H5z" />
      <circle cx="8" cy="16" r="1.3" />
      <circle cx="16" cy="16" r="1.3" />
    </svg>
  ),
  users: () => (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 6" />
    </svg>
  ),
  shield: () => (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6z" />
    </svg>
  ),
  shieldAlert: () => (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6z" />
      <path d="M12 9v3.5" strokeLinecap="round" />
      <circle cx="12" cy="15.5" r="0.6" fill="currentColor" />
    </svg>
  ),
  video: () => (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="M16 10l5-3v10l-5-3z" />
    </svg>
  ),
  truck: () => (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <rect x="2" y="6" width="12" height="10" rx="1.5" />
      <path d="M14 9h4l3 3v4h-7z" />
      <circle cx="6" cy="18" r="1.6" />
      <circle cx="17" cy="18" r="1.6" />
    </svg>
  ),
  money: () => (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="9" />
      <path
        d="M12 7v10M9.5 9a2.5 2 0 0 1 5 0c0 2.5-5 1.5-5 4a2.5 2 0 0 0 5 0"
        strokeLinecap="round"
      />
    </svg>
  ),
  file: () => (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  ),
  search: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  ),
  sun: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" />
    </svg>
  ),
  check: () => (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12l5 5 9-10" />
    </svg>
  ),
  x: () => (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
  lock: () => (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="4" y="10" width="16" height="11" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  ),
  chev: () => (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  arrowL: () => (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  ),
  up: () => (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  ),
};
const Pill = ({ tone, children, pulse }) => {
  const m = {
    success: ['var(--success-soft)', 'var(--success)'],
    warn: ['var(--warn-soft)', 'var(--warn)'],
    danger: ['var(--danger-soft)', 'var(--danger)'],
    accent: ['var(--accent-soft)', 'var(--accent)'],
    neutral: ['var(--surface2)', 'var(--ink-muted)'],
  }[tone] || ['var(--surface2)', 'var(--ink-muted)'];
  return (
    <span className={'pill' + (pulse ? ' pulse' : '')} style={{ background: m[0], color: m[1] }}>
      <span className="dot" style={{ background: m[1] }} />
      {children}
    </span>
  );
};

function MiniMap({ panics = 2 }) {
  return (
    <div className="map" style={{ height: '100%', minHeight: 300 }}>
      <svg
        viewBox="0 0 800 460"
        style={{ width: '100%', height: '100%' }}
        preserveAspectRatio="xMidYMid slice"
      >
        <rect width="800" height="460" fill="#e9ecf1" />
        <g opacity="0.8">
          {Array.from({ length: 5 }).map((_, r) =>
            Array.from({ length: 9 }).map((_, c) => (
              <rect
                key={r + '-' + c}
                x={c * 92 - 20}
                y={r * 100 - 10}
                width="74"
                height="80"
                rx="6"
                fill="#f1f3f6"
              />
            )),
          )}
        </g>
        <g stroke="#dde1e8" strokeWidth="8" fill="none">
          {[80, 180, 280, 380].map((y) => (
            <path key={y} d={`M-20 ${y} H820`} />
          ))}
          {[120, 300, 480, 660].map((x) => (
            <path key={x} d={`M${x} -20 V480`} />
          ))}
        </g>
        {[
          [180, 140, '#1f7fd4'],
          [420, 250, '#1f7fd4'],
          [560, 120, '#1f7fd4'],
          [300, 360, '#1f9d6b'],
          [650, 330, '#1f7fd4'],
          [240, 200, '#1f7fd4'],
        ].map((d, k) => (
          <g key={k}>
            <circle cx={d[0]} cy={d[1]} r="9" fill={d[2]} stroke="#fff" strokeWidth="2.5" />
          </g>
        ))}
        {Array.from({ length: panics }).map((_, k) => (
          <g key={k}>
            <circle
              cx={k ? 620 : 140}
              cy={k ? 200 : 300}
              r="18"
              fill="rgba(216,69,62,.18)"
              className="pulse"
            />
            <circle
              cx={k ? 620 : 140}
              cy={k ? 200 : 300}
              r="10"
              fill="#d8453e"
              stroke="#fff"
              strokeWidth="2.5"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}

/* ---- sections ---- */
function Ops({ go, panicsOpen }) {
  const kpis = [
    ['Viajes activos', '142'],
    ['Conductores en línea', '318'],
    ['Pánicos abiertos', String(panicsOpen), panicsOpen > 0],
    ['Completados hoy', '2,841'],
    ['Cancelados hoy', '86'],
    ['Recaudación hoy', 'S/ 38,420'],
    ['ETA promedio', '4.2 min'],
  ];
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 18,
        }}
      >
        <div>
          <div className="h1">Operación en vivo</div>
          <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>
            Conductores, viajes y alertas en tiempo real.
          </div>
        </div>
        <Pill tone="success" pulse>
          En vivo
        </Pill>
      </div>
      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 12, marginBottom: 18 }}
      >
        {kpis.map((k, i) => (
          <div
            key={i}
            className="kpi"
            style={k[2] ? { borderColor: 'var(--danger)', background: 'var(--danger-soft)' } : null}
          >
            <div
              className="sub"
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                color: k[2] ? 'var(--danger)' : 'var(--ink-subtle)',
              }}
            >
              {k[2] && I.shieldAlert()}
              {k[0]}
            </div>
            <div className="v mono" style={k[2] ? { color: 'var(--danger)' } : null}>
              {k[1]}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 16 }}>
        <div className="card" style={{ padding: 6 }}>
          <MiniMap panics={panicsOpen} />
        </div>
        <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14 }}>Viajes activos</div>
            <span
              className="accent"
              style={{ color: 'var(--accent)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Ver todos
            </span>
          </div>
          {[
            ['a4f29b1c', 'En viaje', 'S/ 13.00', '2 min'],
            ['7e10c3da', 'Recogiendo', 'S/ 22.50', '5 min'],
            ['d2k309fe', 'Solicitado', 'S/ 16.00', '—'],
            ['b81f4427', 'En viaje', 'S/ 11.00', '8 min'],
          ].map((t, k) => (
            <div
              key={k}
              onClick={() => go && go('triplive')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 0',
                borderBottom: k < 3 ? '1px solid var(--border)' : 'none',
                cursor: 'pointer',
              }}
            >
              <span className="mono" style={{ fontSize: 12.5, color: 'var(--ink-muted)' }}>
                {t[0]}
              </span>
              <Pill tone={t[1] === 'En viaje' ? 'accent' : 'neutral'}>{t[1]}</Pill>
              <span className="mono" style={{ marginLeft: 'auto', fontWeight: 600, fontSize: 13 }}>
                {t[2]}
              </span>
              <span className="sub mono" style={{ fontSize: 12, width: 36, textAlign: 'right' }}>
                {t[3]}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Panics({ go }) {
  const [tab, setTab] = useState('open');
  const rows = [
    [
      'Crítico',
      'danger',
      'Disparado · hace 2 min',
      'a4f29b1c',
      '71****68',
      'Abierto',
      'danger',
      '—',
    ],
    [
      'Crítico',
      'danger',
      'Disparado · hace 14 min',
      '7e10c3da',
      '40****12',
      'Abierto',
      'danger',
      '—',
    ],
    [
      'Medio',
      'warn',
      'Disparado · hace 1 h',
      'c83b1190',
      '22****55',
      'Reconocido',
      'warn',
      'hace 50 min',
    ],
    ['Bajo', 'neutral', 'Disparado · ayer', '9f02ab44', '18****03', 'Resuelto', 'success', 'ayer'],
  ];
  const f = rows.filter(
    (r) =>
      tab === 'all' ||
      (tab === 'open' && r[5] === 'Abierto') ||
      (tab === 'ack' && r[5] === 'Reconocido'),
  );
  return (
    <div>
      <div className="h1" style={{ marginBottom: 3 }}>
        Alertas de pánico
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
        Cola priorizada por gravedad · atención y resolución de incidentes.
      </div>
      <div className="tabs" style={{ marginBottom: 14, width: 'fit-content' }}>
        {[
          ['open', 'Abiertos'],
          ['ack', 'Reconocidos'],
          ['all', 'Todos'],
        ].map((t) => (
          <button key={t[0]} className={tab === t[0] ? 'on' : ''} onClick={() => setTab(t[0])}>
            {t[1]}
          </button>
        ))}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Gravedad</th>
              <th>Disparado</th>
              <th>Viaje</th>
              <th>Pasajero</th>
              <th>Estado</th>
              <th>Reconocido</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {f.map((r, k) => (
              <tr key={k} className="clk" onClick={() => go('panicDetail')}>
                <td>
                  <Pill tone={r[1]}>{r[0]}</Pill>
                </td>
                <td>
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      color: r[6] === 'danger' ? 'var(--danger)' : 'var(--ink)',
                      fontWeight: 600,
                    }}
                  >
                    {I.shieldAlert()}
                    {r[2]}
                  </span>
                </td>
                <td className="mono">{r[3]}</td>
                <td className="mono">{r[4]}</td>
                <td>
                  <Pill tone={r[6]}>{r[5]}</Pill>
                </td>
                <td className="sub" style={{ fontSize: 12.5 }}>
                  {r[7]}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--ink-subtle)' }}>{I.chev()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PanicDetail({ go, notify }) {
  const [dlg, setDlg] = useState(null);
  const [claimed, setClaimed] = useState(false);
  return (
    <div>
      {!claimed && (
        <div
          className="card"
          style={{
            padding: '12px 16px',
            marginBottom: 14,
            display: 'flex',
            gap: 11,
            alignItems: 'center',
            background: 'var(--warn-soft)',
            borderColor: 'var(--warn)',
          }}
        >
          <span style={{ color: 'var(--warn)' }}>{I.lock()}</span>
          <span style={{ fontSize: 13, flex: 1 }}>
            Caso sin asignar. <b>Reclámalo</b> para bloquearlo y evitar que dos operadores lo
            atiendan a la vez.
          </span>
          <span
            className="btn btn-accent btn-sm"
            onClick={() => {
              setClaimed(true);
              notify('Caso reclamado · bloqueado para otros operadores');
            }}
          >
            Reclamar caso
          </span>
        </div>
      )}
      {claimed && (
        <div
          className="card"
          style={{
            padding: '12px 16px',
            marginBottom: 14,
            display: 'flex',
            gap: 11,
            alignItems: 'center',
            background: 'var(--accent-soft)',
            borderColor: 'var(--accent)',
          }}
        >
          <span style={{ color: 'var(--accent)' }}>{I.lock()}</span>
          <span style={{ fontSize: 13, flex: 1 }}>
            Lo estás atendiendo tú (Operador L2) · bloqueado para otros desde 21:14.
          </span>
          <span
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setClaimed(false);
              notify('Caso liberado');
            }}
          >
            Liberar
          </span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div className="btn btn-ghost btn-sm" onClick={() => go('panics', true)}>
          {I.arrowL()} Volver
        </div>
        <div className="h1" style={{ fontSize: 19 }}>
          Pánico · a4f29b1c
        </div>
        <Pill tone="danger">Abierto</Pill>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <div
            className="btn btn-accent btn-sm"
            style={claimed ? {} : { opacity: 0.4, pointerEvents: 'none' }}
            onClick={() => setDlg('ack')}
          >
            Reconocer
          </div>
          <div
            className="btn btn-ghost btn-sm"
            style={claimed ? {} : { opacity: 0.4, pointerEvents: 'none' }}
            onClick={() => setDlg('res')}
          >
            Resolver
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Incidente</div>
            {[
              ['Viaje', 'a4f29b1c'],
              ['Pasajero', '71****68'],
              ['Conductor', 'ABC-481 · Khalid R.'],
              ['Disparado', 'Hoy · 21:14:03'],
              ['Tipo', 'Automático (triple volumen)'],
              ['Atendido por', '—'],
            ].map((r, k) => (
              <div
                key={k}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: k < 5 ? '1px solid var(--border)' : 'none',
                  fontSize: 13,
                }}
              >
                <span className="muted">{r[0]}</span>
                <span className="mono" style={{ fontWeight: 500 }}>
                  {r[1]}
                </span>
              </div>
            ))}
          </div>
          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Evidencia</div>
            {[
              ['Ubicación GPS firmada', '21:14:03'],
              ['Audio de cabina', '21:14:05'],
              ['Frame de cámara', '21:14:08'],
            ].map((r, k) => (
              <div
                key={k}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 0',
                  borderBottom: k < 2 ? '1px solid var(--border)' : 'none',
                }}
              >
                <span style={{ color: 'var(--accent)' }}>{I.file()}</span>
                <span style={{ flex: 1, fontSize: 13 }}>{r[0]}</span>
                <span className="sub mono" style={{ fontSize: 12 }}>
                  {r[1]}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="card" style={{ padding: 6 }}>
          <div className="map" style={{ height: '100%', minHeight: 420 }}>
            <svg
              viewBox="0 0 500 460"
              style={{ width: '100%', height: '100%' }}
              preserveAspectRatio="xMidYMid slice"
            >
              <rect width="500" height="460" fill="#e9ecf1" />
              <g stroke="#dde1e8" strokeWidth="8" fill="none">
                {[80, 200, 320].map((y) => (
                  <path key={y} d={`M-20 ${y} H520`} />
                ))}
                {[120, 280, 420].map((x) => (
                  <path key={x} d={`M${x} -20 V480`} />
                ))}
              </g>
              <circle cx="250" cy="230" r="40" fill="rgba(216,69,62,.16)" className="pulse" />
              <circle cx="250" cy="230" r="13" fill="#d8453e" stroke="#fff" strokeWidth="3" />
            </svg>
          </div>
        </div>
      </div>
      {dlg && (
        <div className="modal-bg" onClick={() => setDlg(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              {dlg === 'ack' ? 'Reconocer alerta' : 'Resolver alerta'}
            </div>
            <p className="muted" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
              {dlg === 'ack'
                ? 'Confirmas que estás atendiendo esta alerta de pánico. Esta acción queda auditada.'
                : 'Registra el desenlace del incidente. Esta acción queda auditada.'}
            </p>
            {dlg === 'res' && (
              <textarea
                placeholder="Notas de resolución (obligatorio)…"
                style={{
                  width: '100%',
                  height: 80,
                  marginTop: 12,
                  border: '1px solid var(--border-strong)',
                  borderRadius: 9,
                  padding: 10,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  resize: 'none',
                }}
              />
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
              <div className="btn btn-ghost btn-sm" onClick={() => setDlg(null)}>
                Cancelar
              </div>
              <div
                className={'btn btn-sm ' + (dlg === 'ack' ? 'btn-accent' : 'btn-accent')}
                onClick={() => {
                  setDlg(null);
                  notify(dlg === 'ack' ? 'Alerta reconocida' : 'Alerta resuelta · auditada');
                }}
              >
                {dlg === 'ack' ? 'Reconocer' : 'Resolver'}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Drivers({ go, notify }) {
  const [tab, setTab] = useState('pend');
  const rows = [
    ['Marko Vega', 'm-7741', '+51 ··· 882', 'En revisión', 'warn', '4.99', 'Limpio', 'pend'],
    ['Ana Quispe', 'a-2210', '+51 ··· 114', 'En revisión', 'warn', '—', 'Pendiente', 'pend'],
    ['Khalid Ríos', 'abc-481', '+51 ··· 321', 'Activo', 'success', '4.97', 'Limpio', 'act'],
    ['José Pérez', 'd2k-309', '+51 ··· 220', 'Activo', 'success', '4.88', 'Limpio', 'act'],
    ['Luis Tapia', 'x-5582', '+51 ··· 907', 'Suspendido', 'danger', '3.9', 'Limpio', 'susp'],
  ];
  const f = rows.filter((r) => tab === 'all' || r[7] === tab);
  return (
    <div>
      <div className="h1" style={{ marginBottom: 3 }}>
        Conductores
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
        Aprobación de altas, estado de la flota y reglas automáticas.
      </div>
      <div
        className="card"
        style={{
          padding: '12px 14px',
          marginBottom: 14,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          background: 'var(--warn-soft)',
          borderColor: 'var(--warn)',
        }}
      >
        <span style={{ color: 'var(--warn)' }}>{I.shieldAlert()}</span>
        <span style={{ fontSize: 13, flex: 1 }}>
          <b>Regla automática:</b> 5 cancelaciones en 24 h o rating &lt; 4.0 → suspensión y
          revisión.
        </span>
        <span className="btn btn-ghost btn-sm" onClick={() => notify('Regla configurada')}>
          Configurar
        </span>
      </div>
      <div className="tabs" style={{ marginBottom: 14, width: 'fit-content' }}>
        {[
          ['pend', 'Pendientes'],
          ['act', 'Activos'],
          ['susp', 'Suspendidos'],
          ['all', 'Todos'],
        ].map((t) => (
          <button key={t[0]} className={tab === t[0] ? 'on' : ''} onClick={() => setTab(t[0])}>
            {t[1]}
          </button>
        ))}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Conductor</th>
              <th>Teléfono</th>
              <th>Estado</th>
              <th>Rating</th>
              <th>Antecedentes</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {f.map((r, k) => (
              <tr key={k} className="clk" onClick={() => go && go('driverdetail')}>
                <td>
                  <div style={{ fontWeight: 600 }}>{r[0]}</div>
                  <div className="mono sub" style={{ fontSize: 11.5 }}>
                    {r[1]}
                  </div>
                </td>
                <td className="mono">{r[2]}</td>
                <td>
                  <Pill tone={r[4]}>{r[3]}</Pill>
                </td>
                <td
                  className="mono"
                  style={{ color: parseFloat(r[5]) < 4 ? 'var(--danger)' : 'var(--ink)' }}
                >
                  {r[5]}
                </td>
                <td>
                  <Pill tone={r[6] === 'Limpio' ? 'success' : 'warn'}>{r[6]}</Pill>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {r[7] === 'pend' ? (
                    <span style={{ display: 'flex', gap: 7, justifyContent: 'flex-end' }}>
                      <span
                        className="btn btn-accent btn-sm"
                        onClick={() => notify('Conductor aprobado')}
                      >
                        Aprobar
                      </span>
                      <span
                        className="btn btn-ghost btn-sm"
                        onClick={() => notify('Conductor rechazado')}
                      >
                        Rechazar
                      </span>
                    </span>
                  ) : r[7] === 'susp' ? (
                    <span
                      className="btn btn-ghost btn-sm"
                      onClick={() => notify('Conductor reactivado')}
                    >
                      Reactivar
                    </span>
                  ) : (
                    <span className="sub">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Fleet() {
  const [tab, setTab] = useState('venc');
  return (
    <div>
      <div className="h1" style={{ marginBottom: 3 }}>
        Flota
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
        Documentos, vehículos, inspecciones y vencimientos.
      </div>
      <div className="tabs" style={{ marginBottom: 14, width: 'fit-content' }}>
        {[
          ['doc', 'Documentos'],
          ['veh', 'Vehículos'],
          ['venc', 'Vencimientos'],
        ].map((t) => (
          <button key={t[0]} className={tab === t[0] ? 'on' : ''} onClick={() => setTab(t[0])}>
            {t[1]}
          </button>
        ))}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {tab === 'venc' ? (
          <table>
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Titular</th>
                <th>Vence</th>
                <th>Días restantes</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['SOAT', 'ABC-481', '18/06/2026', '6', true],
                ['Licencia', 'm-7741', '02/07/2026', '28', false],
                ['Tarjeta prop.', 'd2k-309', '15/12/2026', '—', false],
              ].map((r, k) => (
                <tr key={k}>
                  <td>{r[0]}</td>
                  <td className="mono">{r[1]}</td>
                  <td className="mono">{r[2]}</td>
                  <td>
                    {r[0] === 'Tarjeta prop.' ? (
                      <span className="sub">vigente</span>
                    ) : (
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 7,
                          color: r[4] ? 'var(--danger)' : 'var(--warn)',
                          fontWeight: 600,
                        }}
                      >
                        {r[4] && I.shieldAlert()}
                        {r[3]} días
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{tab === 'doc' ? 'Documento' : 'Placa'}</th>
                <th>Titular</th>
                <th>Estado</th>
                <th style={{ textAlign: 'right' }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Licencia', 'Khalid R.', 'Vigente', 'success'],
                ['SOAT', 'José P.', 'Por vencer', 'warn'],
                ['Tarjeta prop.', 'Marko V.', 'En revisión', 'neutral'],
              ].map((r, k) => (
                <tr key={k}>
                  <td>{r[0]}</td>
                  <td>{r[1]}</td>
                  <td>
                    <Pill tone={r[3]}>{r[2]}</Pill>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="btn btn-ghost btn-sm">Revisar</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Finance({ notify }) {
  const [tab, setTab] = useState('pend');
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 16,
        }}
      >
        <div>
          <div className="h1" style={{ marginBottom: 3 }}>
            Liquidaciones
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Pagos a conductores y reembolsos a pasajeros.
          </div>
        </div>
        <div className="btn btn-ghost btn-sm" onClick={() => notify('Nuevo reembolso')}>
          Reembolso
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <div className="tabs" style={{ width: 'fit-content' }}>
          {[
            ['pend', 'Pendientes'],
            ['paid', 'Pagadas'],
            ['all', 'Todas'],
          ].map((t) => (
            <button key={t[0]} className={tab === t[0] ? 'on' : ''} onClick={() => setTab(t[0])}>
              {t[1]}
            </button>
          ))}
        </div>
        <span
          className="badge"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          {I.lock()} Ejecutar pago: solo rol FINANCE
        </span>
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Liquidación</th>
              <th>Conductor</th>
              <th>Periodo</th>
              <th>Monto</th>
              <th>Estado</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['lq-2231', 'abc-481', 'Sem 23', 'S/ 86.50', 'Pendiente', 'warn', true],
              ['lq-2230', 'd2k-309', 'Sem 23', 'S/ 142.00', 'Pendiente', 'warn', true],
              ['lq-2229', 'm-7741', 'Sem 22', 'S/ 98.00', 'Pagado', 'success', false],
            ].map((r, k) => (
              <tr key={k}>
                <td className="mono">{r[0]}</td>
                <td className="mono">{r[1]}</td>
                <td>{r[2]}</td>
                <td className="mono" style={{ fontWeight: 600 }}>
                  {r[3]}
                </td>
                <td>
                  <Pill tone={r[5]}>{r[4]}</Pill>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {r[6] ? (
                    <span
                      className="btn btn-accent btn-sm"
                      onClick={() => notify('Pago ejecutado · idempotente · auditado')}
                    >
                      Ejecutar pago
                    </span>
                  ) : (
                    <span className="sub">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Media({ notify }) {
  const [step, setStep] = useState(false);
  return (
    <div>
      <div className="h1" style={{ marginBottom: 3 }}>
        Acceso a video
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
        Solicitud y aprobación de grabaciones · doble autenticación.
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Viaje</th>
              <th>Motivo</th>
              <th>Solicitante</th>
              <th>Estado</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['a4f29b1c', 'Investigación de pánico', 'sup_l2', 'Pendiente', 'warn'],
              ['7e10c3da', 'Reclamo de pasajero', 'comp_sup', 'Aprobada', 'success'],
              ['b81f4427', 'Auditoría aleatoria', 'admin', 'Rechazada', 'danger'],
            ].map((r, k) => (
              <tr key={k}>
                <td className="mono">{r[0]}</td>
                <td>{r[1]}</td>
                <td className="mono">{r[2]}</td>
                <td>
                  <Pill tone={r[4]}>{r[3]}</Pill>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {r[3] === 'Pendiente' ? (
                    <span style={{ display: 'flex', gap: 7, justifyContent: 'flex-end' }}>
                      <span className="btn btn-accent btn-sm" onClick={() => setStep(true)}>
                        Aprobar
                      </span>
                      <span
                        className="btn btn-ghost btn-sm"
                        onClick={() => notify('Solicitud rechazada')}
                      >
                        Rechazar
                      </span>
                    </span>
                  ) : r[3] === 'Aprobada' ? (
                    <span className="btn btn-ghost btn-sm" onClick={() => setStep(true)}>
                      {I.video()} Reproducir
                    </span>
                  ) : (
                    <span className="sub">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {step && (
        <div className="modal-bg" onClick={() => setStep(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                fontWeight: 700,
                fontSize: 16,
              }}
            >
              {I.lock()} Verificación adicional (MFA)
            </div>
            <p className="muted" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
              Aprobar o reproducir grabaciones requiere un código TOTP fresco. Toda reproducción
              queda auditada.
            </p>
            <input
              className="mono"
              placeholder="••• •••"
              style={{
                width: '100%',
                marginTop: 14,
                height: 46,
                textAlign: 'center',
                letterSpacing: '.4em',
                fontSize: 20,
                border: '1px solid var(--border-strong)',
                borderRadius: 10,
              }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
              <div className="btn btn-ghost btn-sm" onClick={() => setStep(false)}>
                Cancelar
              </div>
              <div
                className="btn btn-accent btn-sm"
                onClick={() => {
                  setStep(false);
                  notify('Acceso autorizado · auditado');
                }}
              >
                Verificar
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Pricing({ notify }) {
  const [tab, setTab] = useState('tarifa');
  const [base, setBase] = useState(3.5),
    [km, setKm] = useState(1.2),
    [min, setMin] = useState(0.35),
    [mini, setMini] = useState(7),
    [comm, setComm] = useState(10);
  const Field = ({ label, val, set, step = 0.5, pre = 'S/' }) => (
    <div
      className="card"
      style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14 }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          className="btn btn-ghost btn-sm"
          style={{ width: 34, padding: 0 }}
          onClick={() => set((v) => Math.max(0, +(v - step).toFixed(2)))}
        >
          −
        </div>
        <div
          className="mono"
          style={{ minWidth: 74, textAlign: 'center', fontWeight: 700, fontSize: 15 }}
        >
          {pre} {val.toFixed(2)}
        </div>
        <div
          className="btn btn-ghost btn-sm"
          style={{ width: 34, padding: 0 }}
          onClick={() => set((v) => +(v + step).toFixed(2))}
        >
          +
        </div>
      </div>
    </div>
  );
  const sample = (d, t) => base + d * km + t * min;
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 16,
        }}
      >
        <div>
          <div className="h1" style={{ marginBottom: 3 }}>
            Tarifas y zonas
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            El motor del precio: define la tarifa recomendada y el mínimo por zona.
          </div>
        </div>
        <div
          className="btn btn-accent btn-sm"
          onClick={() => notify('Tarifa publicada · auditado')}
        >
          {I.check()} Publicar cambios
        </div>
      </div>
      <div className="tabs" style={{ marginBottom: 14, width: 'fit-content' }}>
        {[
          ['tarifa', 'Tarifa base'],
          ['zonas', 'Zonas'],
          ['surge', 'Demanda'],
          ['comis', 'Comisión y peajes'],
        ].map((t) => (
          <button key={t[0]} className={tab === t[0] ? 'on' : ''} onClick={() => setTab(t[0])}>
            {t[1]}
          </button>
        ))}
      </div>
      {tab === 'tarifa' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Field label="Tarifa base (banderazo)" val={base} set={setBase} />
            <Field label="Por kilómetro" val={km} set={setKm} step={0.1} />
            <Field label="Por minuto" val={min} set={setMin} step={0.05} />
            <Field label="Tarifa mínima (piso anti-abuso)" val={mini} set={setMini} step={1} />
          </div>
          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>
              Simulador de tarifa recomendada
            </div>
            {[
              ['Miraflores → Surco', '9.2 km · 22 min', 9.2, 22],
              ['Centro corto', '3.0 km · 9 min', 3, 9],
              ['Aeropuerto', '14 km · 35 min', 14, 35],
            ].map((r, k) => {
              const v = Math.max(mini, sample(r[2], r[3]));
              return (
                <div
                  key={k}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 0',
                    borderBottom: k < 2 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{r[0]}</div>
                    <div className="sub" style={{ fontSize: 11.5 }}>
                      {r[1]}
                    </div>
                  </div>
                  <div className="mono" style={{ fontWeight: 700, fontSize: 16 }}>
                    S/ {v.toFixed(0)}
                    <span className="sub" style={{ fontSize: 11 }}>
                      {' '}
                      ± sugerido
                    </span>
                  </div>
                </div>
              );
            })}
            <div className="sub" style={{ fontSize: 11.5, marginTop: 12, lineHeight: 1.5 }}>
              El pasajero ve este monto como “sugerido” y puede ofrecer igual o más. Nunca por
              debajo del mínimo.
            </div>
          </div>
        </div>
      )}
      {tab === 'zonas' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table>
            <thead>
              <tr>
                <th>Zona</th>
                <th>Mínimo</th>
                <th>Multiplicador</th>
                <th>Estado</th>
                <th style={{ textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Miraflores / San Isidro', 'S/ 8.00', '1.0x', 'Activa', 'success'],
                ['Centro de Lima', 'S/ 7.00', '1.0x', 'Activa', 'success'],
                ['Callao / Aeropuerto', 'S/ 12.00', '1.15x', 'Activa', 'success'],
                ['Periferia noche', 'S/ 9.00', '1.3x', 'Revisión', 'warn'],
              ].map((r, k) => (
                <tr key={k}>
                  <td style={{ fontWeight: 600 }}>{r[0]}</td>
                  <td className="mono">{r[1]}</td>
                  <td className="mono">{r[2]}</td>
                  <td>
                    <Pill tone={r[4]}>{r[3]}</Pill>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="btn btn-ghost btn-sm">Editar</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'surge' && (
        <div className="card" style={{ padding: 18, maxWidth: 560 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
            Multiplicador por demanda
          </div>
          <div className="muted" style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
            Se aplica al mínimo y al sugerido cuando la demanda supera a la oferta. Tope de
            seguridad para no abusar del pasajero.
          </div>
          {[
            ['Demanda normal', '1.0x', 'neutral'],
            ['Demanda alta (hora punta)', '1.3x', 'warn'],
            ['Tope máximo permitido', '1.8x', 'danger'],
          ].map((r, k) => (
            <div
              key={k}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '11px 0',
                borderBottom: k < 2 ? '1px solid var(--border)' : 'none',
              }}
            >
              <span style={{ fontSize: 13.5 }}>{r[0]}</span>
              <Pill tone={r[2]}>{r[1]}</Pill>
            </div>
          ))}
        </div>
      )}
      {tab === 'comis' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560 }}>
          <Field label="Comisión VEO por viaje (%)" val={comm} set={setComm} step={1} pre="" />
          <div className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
              Peajes y tasas de aeropuerto
            </div>
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              No se incluyen en la tarifa negociada. Los paga el pasajero aparte, y se muestran por
              separado en el recibo.
            </div>
            <div style={{ marginTop: 10 }}>
              <Pill tone="accent">Excluidos de la tarifa</Pill>
            </div>
          </div>
          <div
            className="sub"
            style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'flex-start' }}
          >
            <span style={{ marginTop: 1 }}>{I.lock()}</span>Cambiar comisión requiere rol FINANCE +
            doble autorización. Todo cambio de tarifa queda auditado.
          </div>
        </div>
      )}
    </div>
  );
}

function TripLive({ go, notify }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div className="btn btn-ghost btn-sm" onClick={() => go('ops', true)}>
          {I.arrowL()} Volver
        </div>
        <div className="h1" style={{ fontSize: 19 }}>
          Viaje · a4f29b1c
        </div>
        <Pill tone="accent">En viaje</Pill>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <div className="btn btn-ghost btn-sm" onClick={() => go('media', true)}>
            {I.video()} Solicitar video
          </div>
          <div
            className="btn btn-danger btn-sm"
            onClick={() => notify('Marcado para seguimiento de seguridad')}
          >
            {I.shieldAlert()} Marcar
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 16 }}>
        <div className="card" style={{ padding: 6 }}>
          <MiniMap panics={0} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: 16 }}>
            {[
              ['Pasajero', 'María F. · 71****68'],
              ['Conductor', 'Khalid R. · ABC-481'],
              ['Vehículo', 'Toyota Yaris · Plomo'],
              ['Tarifa acordada', 'S/ 13.00'],
              ['Origen', 'Av. Pardo y Aliaga'],
              ['Destino', 'Jockey Plaza, Surco'],
            ].map((r, k) => (
              <div
                key={k}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '7px 0',
                  borderBottom: k < 5 ? '1px solid var(--border)' : 'none',
                  fontSize: 13,
                }}
              >
                <span className="muted">{r[0]}</span>
                <span className="mono" style={{ fontWeight: 500 }}>
                  {r[1]}
                </span>
              </div>
            ))}
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Línea de tiempo</div>
            {[
              ['Solicitado', '21:02', 'done'],
              ['Aceptado por Khalid', '21:03', 'done'],
              ['Recogió al pasajero', '21:09', 'done'],
              ['En viaje', '21:09', 'active'],
              ['Destino estimado', '21:31', 'pend'],
            ].map((r, k) => (
              <div
                key={k}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    background:
                      r[2] === 'done'
                        ? 'var(--success)'
                        : r[2] === 'active'
                          ? 'var(--accent)'
                          : 'var(--border-strong)',
                  }}
                />
                <span style={{ flex: 1, fontSize: 13 }}>{r[0]}</span>
                <span className="sub mono" style={{ fontSize: 12 }}>
                  {r[1]}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Tickets({ go, notify }) {
  const [tab, setTab] = useState('open');
  const rows = [
    ['TK-3391', 'Conductor no llegó', 'Pasajero · 71****68', 'Alta', 'Abierto', 'danger'],
    ['TK-3390', 'Cobro duplicado', 'Pasajero · 22****55', 'Media', 'Abierto', 'warn'],
    ['TK-3388', 'Objeto perdido', 'Pasajero · 40****12', 'Baja', 'En curso', 'accent'],
    ['TK-3385', 'Pago de Semana 22', 'Conductor · m-7741', 'Media', 'Resuelto', 'success'],
  ];
  const f = rows.filter(
    (r) =>
      tab === 'all' ||
      (tab === 'open' && r[4] === 'Abierto') ||
      (tab === 'prog' && r[4] === 'En curso'),
  );
  return (
    <div>
      <div className="h1" style={{ marginBottom: 3 }}>
        Soporte
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
        Tickets de pasajeros y conductores · SLA y asignación.
      </div>
      <div className="tabs" style={{ marginBottom: 14, width: 'fit-content' }}>
        {[
          ['open', 'Abiertos'],
          ['prog', 'En curso'],
          ['all', 'Todos'],
        ].map((t) => (
          <button key={t[0]} className={tab === t[0] ? 'on' : ''} onClick={() => setTab(t[0])}>
            {t[1]}
          </button>
        ))}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Asunto</th>
              <th>De</th>
              <th>Prioridad</th>
              <th>Estado</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {f.map((r, k) => (
              <tr key={k}>
                <td className="mono">{r[0]}</td>
                <td style={{ fontWeight: 600 }}>{r[1]}</td>
                <td className="mono sub" style={{ fontSize: 12 }}>
                  {r[2]}
                </td>
                <td>
                  <Pill tone={r[5]}>{r[3]}</Pill>
                </td>
                <td>
                  <Pill
                    tone={r[4] === 'Resuelto' ? 'success' : r[4] === 'En curso' ? 'accent' : 'warn'}
                  >
                    {r[4]}
                  </Pill>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {r[4] !== 'Resuelto' ? (
                    <span
                      className="btn btn-accent btn-sm"
                      onClick={() => notify('Ticket ' + r[0] + ' atendido')}
                    >
                      Atender
                    </span>
                  ) : (
                    <span className="sub">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DriverDetail({ go, notify }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div className="btn btn-ghost btn-sm" onClick={() => go('drivers', true)}>
          {I.arrowL()} Volver
        </div>
        <div className="h1" style={{ fontSize: 19 }}>
          Khalid Ríos
        </div>
        <Pill tone="success">Activo</Pill>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <div className="btn btn-ghost btn-sm" onClick={() => notify('Mensaje enviado')}>
            Contactar
          </div>
          <div
            className="btn btn-danger btn-sm"
            onClick={() => notify('Conductor suspendido · auditado')}
          >
            Suspender
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card" style={{ padding: 18 }}>
          {[
            ['DNI', '71****68'],
            ['Placa', 'ABC-481'],
            ['Vehículo', 'Toyota Yaris 2019 · Plomo'],
            ['Rating', '4.97 · 248 viajes'],
            ['Antecedentes', 'Limpio'],
            ['Antigüedad', '1 año 3 meses'],
          ].map((r, k) => (
            <div
              key={k}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '8px 0',
                borderBottom: k < 5 ? '1px solid var(--border)' : 'none',
                fontSize: 13,
              }}
            >
              <span className="muted">{r[0]}</span>
              <span className="mono" style={{ fontWeight: 500 }}>
                {r[1]}
              </span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Documentos</div>
            {[
              ['Licencia', 'Vigente', 'success'],
              ['SOAT', 'Vence en 6 días', 'warn'],
              ['Tarjeta prop.', 'Vigente', 'success'],
            ].map((r, k) => (
              <div
                key={k}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 0',
                  borderBottom: k < 2 ? '1px solid var(--border)' : 'none',
                }}
              >
                <span style={{ fontSize: 13 }}>{r[0]}</span>
                <Pill tone={r[2]}>{r[1]}</Pill>
              </div>
            ))}
          </div>
          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Seguridad</div>
            {[
              ['Pánicos en sus viajes', '0'],
              ['Cancelaciones (30d)', '2'],
              ['Reportes recibidos', '1'],
            ].map((r, k) => (
              <div
                key={k}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: k < 2 ? '1px solid var(--border)' : 'none',
                  fontSize: 13,
                }}
              >
                <span className="muted">{r[0]}</span>
                <span className="mono" style={{ fontWeight: 600 }}>
                  {r[1]}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminAccess({ notify }) {
  const [size, setSize] = useState(1);
  const [lang, setLang] = useState('es');
  const [hc, setHc] = useState(false);
  const S = {
    es: [
      'Tamaño de texto',
      'Idioma de la consola',
      'Alto contraste',
      'Así se verá',
      'Operación en vivo',
      'Guardar',
    ],
    en: ['Text size', 'Console language', 'High contrast', 'Preview', 'Live operations', 'Save'],
    qu: ['Qillqa sayaynin', 'Rimay', 'Sinchi llimphi', 'Rikuchiy', 'Kawsay puriy', 'Waqaychay'],
  }[lang];
  return (
    <div>
      <div className="h1" style={{ marginBottom: 3 }}>
        Accesibilidad e idioma
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
        Preferencias de la consola del operador · WCAG AA.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, maxWidth: 760 }}>
        <div className="card" style={{ padding: 18 }}>
          <div className="sub" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            {S[0]}
          </div>
          <div className="tabs" style={{ marginBottom: 14 }}>
            {[0.9, 1, 1.15].map((o, i) => (
              <button
                key={i}
                className={size === o ? 'on' : ''}
                style={{ fontSize: 12 + i * 3 + 'px' }}
                onClick={() => setSize(o)}
              >
                A
              </button>
            ))}
          </div>
          <div className="sub" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            {S[1]}
          </div>
          <div className="tabs" style={{ marginBottom: 14 }}>
            {[
              ['es', 'Español'],
              ['en', 'English'],
              ['qu', 'Runa Simi'],
            ].map((o) => (
              <button
                key={o[0]}
                className={lang === o[0] ? 'on' : ''}
                onClick={() => setLang(o[0])}
              >
                {o[1]}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{S[2]}</span>
            <span
              onClick={() => setHc(!hc)}
              style={{
                width: 44,
                height: 26,
                borderRadius: 99,
                background: hc ? 'var(--accent)' : 'var(--surface2)',
                border: '1px solid var(--border-strong)',
                position: 'relative',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 3,
                  left: hc ? 21 : 3,
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: hc ? '#fff' : 'var(--ink-subtle)',
                }}
              />
            </span>
          </div>
        </div>
        <div
          className="card"
          style={{
            padding: 18,
            background: hc ? '#000' : 'var(--surface)',
            border: hc ? '2px solid #fff' : '1px solid var(--border)',
          }}
        >
          <div
            className="sub"
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              marginBottom: 8,
              color: hc ? '#bbb' : 'var(--ink-subtle)',
            }}
          >
            {S[3]}
          </div>
          <div style={{ fontWeight: 700, fontSize: 22 * size, color: hc ? '#fff' : 'var(--ink)' }}>
            {S[4]}
          </div>
          <div
            className="mono"
            style={{ fontSize: 14 * size, marginTop: 8, color: hc ? '#5db0f0' : 'var(--accent)' }}
          >
            142 viajes · 318 conductores
          </div>
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <div
          className="btn btn-accent btn-sm"
          onClick={() =>
            notify(
              lang === 'en'
                ? 'Preferences saved'
                : lang === 'qu'
                  ? 'Waqaychasqa'
                  : 'Preferencias guardadas',
            )
          }
        >
          {S[5]}
        </div>
      </div>
    </div>
  );
}

function AdminSearch({ go }) {
  const [q, setQ] = useState('a4f');
  const res = [
    ['Viaje', 'a4f29b1c', 'En viaje · S/ 13.00', 'triplive'],
    ['Viaje', 'a4f00921', 'Completado · ayer', 'triplive'],
    ['Conductor', 'Khalid Ríos · ABC-481', 'Activo · 4.97', 'driverdetail'],
  ];
  const f = res.filter((r) => (r[1] + r[0]).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="h1" style={{ marginBottom: 12 }}>
        Buscar
      </div>
      <div className="search" style={{ maxWidth: 520, marginBottom: 16 }}>
        {I.search()}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--ink)',
            fontSize: 13,
          }}
          autoFocus
        />
      </div>
      <div className="card" style={{ overflow: 'hidden', maxWidth: 680 }}>
        <table>
          <tbody>
            {f.length ? (
              f.map((r, k) => (
                <tr key={k} className="clk" onClick={() => go(r[3])}>
                  <td style={{ width: 90 }}>
                    <Pill tone="neutral">{r[0]}</Pill>
                  </td>
                  <td className="mono" style={{ fontWeight: 600 }}>
                    {r[1]}
                  </td>
                  <td className="sub" style={{ fontSize: 12.5 }}>
                    {r[2]}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--ink-subtle)' }}>{I.chev()}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td style={{ padding: '24px', textAlign: 'center' }} className="sub">
                  Sin resultados para “{q}”
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Reports({ notify }) {
  const [tab, setTab] = useState('7d');
  const bars = [62, 74, 58, 80, 69, 91, 77];
  const days = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  const max = Math.max(...bars);
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 16,
        }}
      >
        <div>
          <div className="h1" style={{ marginBottom: 3 }}>
            Reportes
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Tendencias de operación, ingresos y seguridad.
          </div>
        </div>
        <div className="tabs" style={{ width: 'fit-content' }}>
          {[
            ['7d', '7 días'],
            ['30d', '30 días'],
          ].map((t) => (
            <button key={t[0]} className={tab === t[0] ? 'on' : ''} onClick={() => setTab(t[0])}>
              {t[1]}
            </button>
          ))}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          marginTop: -8,
          marginBottom: 8,
        }}
      >
        <div
          className="btn btn-ghost btn-sm"
          onClick={() => notify && notify('Reporte exportado · CSV')}
        >
          {I.file()} Exportar CSV
        </div>
        <div
          className="btn btn-ghost btn-sm"
          onClick={() => notify && notify('Reporte exportado · PDF')}
        >
          {I.file()} PDF
        </div>
      </div>
      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 16 }}
      >
        {[
          ['Viajes', '18,420', '+12%'],
          ['Ingresos', 'S/ 248k', '+9%'],
          ['Cancelación', '4.2%', '-0.8%'],
          ['Pánicos', '11', '-3'],
        ].map((k, i) => (
          <div key={i} className="kpi">
            <div className="sub" style={{ fontSize: 11.5, fontWeight: 600 }}>
              {k[0]}
            </div>
            <div className="v mono" style={{ fontSize: 22 }}>
              {k[1]}
            </div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color:
                  k[2].startsWith('-') && i !== 2 && i !== 3 ? 'var(--danger)' : 'var(--success)',
                marginTop: 2,
              }}
            >
              {k[2]} vs anterior
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        <div className="card" style={{ padding: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 16 }}>Viajes por día</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height: 160 }}>
            {bars.map((b, k) => (
              <div
                key={k}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    width: '100%',
                    height: (b / max) * 130 + 'px',
                    background: 'linear-gradient(180deg,var(--accent),#7fc7ed)',
                    borderRadius: '6px 6px 0 0',
                  }}
                />
                <span className="sub" style={{ fontSize: 11 }}>
                  {days[k]}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="card" style={{ padding: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>
            Top zonas por demanda
          </div>
          {[
            ['Miraflores', 86],
            ['Surco', 72],
            ['San Isidro', 64],
            ['Callao', 48],
          ].map((z, k) => (
            <div key={k} style={{ marginBottom: 12 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 12.5,
                  marginBottom: 5,
                }}
              >
                <span>{z[0]}</span>
                <span className="mono sub">{z[1]}%</span>
              </div>
              <div
                style={{
                  height: 7,
                  borderRadius: 99,
                  background: 'var(--surface2)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: z[1] + '%',
                    background: 'var(--accent)',
                    borderRadius: 99,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Revenue() {
  const [tab, setTab] = useState('streams');
  const streams = [
    ['Comisión por viaje', '6–12% por viaje completado', 'S/ 144,200', '58%', 'accent'],
    ['Suscripciones conductor', 'VEO Pro · S/ 19–49 / mes', 'S/ 34,800', '14%', 'success'],
    ['Delivery / Courier', 'Comisión sobre envíos', 'S/ 29,700', '12%', 'success'],
    ['Publicidad in-app', 'Marcas locales · banners', 'S/ 17,300', '7%', 'neutral'],
    ['Comisión de retiro', 'Retiro instantáneo', 'S/ 12,400', '5%', 'neutral'],
    ['B2B / Corporativo', 'Cuentas empresa', 'S/ 9,900', '4%', 'neutral'],
  ];
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 16,
        }}
      >
        <div>
          <div className="h1" style={{ marginBottom: 3 }}>
            Ingresos
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Cómo gana VEO · comisión baja × volumen + servicios.
          </div>
        </div>
        <div className="tabs" style={{ width: 'fit-content' }}>
          {[
            ['streams', 'Fuentes'],
            ['subs', 'Suscripciones'],
          ].map((t) => (
            <button key={t[0]} className={tab === t[0] ? 'on' : ''} onClick={() => setTab(t[0])}>
              {t[1]}
            </button>
          ))}
        </div>
      </div>
      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 16 }}
      >
        {[
          ['Ingreso bruto mes', 'S/ 248,300', '+11%'],
          ['Comisión promedio', '9.2%', '—'],
          ['Conductores Pro', '1,284', '+8%'],
          ['Take rate neto', 'S/ 3.10 / viaje', '+2%'],
        ].map((k, i) => (
          <div key={i} className="kpi">
            <div className="sub" style={{ fontSize: 11.5, fontWeight: 600 }}>
              {k[0]}
            </div>
            <div className="v mono" style={{ fontSize: 21 }}>
              {k[1]}
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--success)', marginTop: 2 }}>
              {k[2]} vs mes anterior
            </div>
          </div>
        ))}
      </div>
      {tab === 'streams' ? (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table>
            <thead>
              <tr>
                <th>Fuente de ingreso</th>
                <th>Cómo funciona</th>
                <th>Mes</th>
                <th>Mezcla</th>
              </tr>
            </thead>
            <tbody>
              {streams.map((r, k) => (
                <tr key={k}>
                  <td style={{ fontWeight: 600 }}>{r[0]}</td>
                  <td className="sub" style={{ fontSize: 12.5 }}>
                    {r[1]}
                  </td>
                  <td className="mono" style={{ fontWeight: 600 }}>
                    {r[2]}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div
                        style={{
                          flex: 1,
                          height: 6,
                          borderRadius: 99,
                          background: 'var(--surface2)',
                          overflow: 'hidden',
                          minWidth: 80,
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: r[3],
                            background:
                              r[4] === 'accent'
                                ? 'var(--accent)'
                                : r[4] === 'success'
                                  ? 'var(--success)'
                                  : 'var(--border-strong)',
                            borderRadius: 99,
                          }}
                        />
                      </div>
                      <span className="mono sub" style={{ fontSize: 12, width: 32 }}>
                        {r[3]}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
          {[
            ['Básico', 'Gratis', 'Comisión 12% · cola normal', 'neutral'],
            ['VEO Pro', 'S/ 19/mes', 'Comisión 8% · prioridad en zonas', 'accent'],
            ['VEO Pro+', 'S/ 49/mes', 'Comisión 6% · boost + soporte 24/7', 'success'],
          ].map((p, k) => (
            <div
              key={k}
              className="card"
              style={{
                padding: 18,
                borderColor: p[3] === 'accent' ? 'var(--accent)' : 'var(--border)',
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 16 }}>{p[0]}</div>
              <div className="display mono" style={{ fontSize: 24, margin: '8px 0' }}>
                {p[1]}
              </div>
              <div className="sub" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                {p[2]}
              </div>
              <div style={{ marginTop: 12 }}>
                <Pill tone={p[3]}>
                  {k === 0 ? '1,090 conductores' : k === 1 ? '940 conductores' : '344 conductores'}
                </Pill>
              </div>
            </div>
          ))}
        </div>
      )}
      <div
        className="card"
        style={{
          marginTop: 16,
          padding: '13px 16px',
          display: 'flex',
          gap: 11,
          alignItems: 'flex-start',
          background: 'var(--surface2)',
        }}
      >
        <span style={{ color: 'var(--accent)', marginTop: 1 }}>{I.shield()}</span>
        <span className="sub" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Afiliación: el conductor entra <b style={{ color: 'var(--ink)' }}>gratis</b> y paga 0% de
          comisión sus primeras semanas. VEO gana por <b style={{ color: 'var(--ink)' }}>volumen</b>
          , no por margen por viaje. A futuro: VEO Money (préstamos a conductores, ya en Perú).
        </span>
      </div>
    </div>
  );
}

function Revenue_END() {}
function Roles({ notify }) {
  const rows = [
    ['Ana M.', 'Super Admin', 'Todo · incluye facturación', 'danger'],
    ['Carlos R.', 'Operador L2', 'Ops · pánicos · soporte', 'accent'],
    ['Lucía P.', 'Finanzas', 'Liquidaciones · ejecutar pagos', 'success'],
    ['Diego S.', 'Soporte L1', 'Tickets · solo lectura ops', 'neutral'],
  ];
  const perms = [
    ['Operación en vivo', 'Todos'],
    ['Atender pánicos', 'L2 + Seguridad'],
    ['Acceso a video', 'Seguridad + MFA'],
    ['Ejecutar pagos', 'Solo FINANCE'],
    ['Cambiar tarifas', 'Admin + FINANCE'],
    ['Auditoría', 'Admin'],
  ];
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 16,
        }}
      >
        <div>
          <div className="h1" style={{ marginBottom: 3 }}>
            Roles y accesos
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            RBAC · cada acción sensible exige rol + doble auth.
          </div>
        </div>
        <div className="btn btn-accent btn-sm" onClick={() => notify('Invitar operador')}>
          + Invitar operador
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16 }}>
        <div className="card" style={{ overflow: 'hidden' }}>
          <table>
            <thead>
              <tr>
                <th>Operador</th>
                <th>Rol</th>
                <th>Alcance</th>
                <th style={{ textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, k) => (
                <tr key={k}>
                  <td style={{ fontWeight: 600 }}>{r[0]}</td>
                  <td>
                    <Pill tone={r[3]}>{r[1]}</Pill>
                  </td>
                  <td className="sub" style={{ fontSize: 12.5 }}>
                    {r[2]}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span
                      className="btn btn-ghost btn-sm"
                      onClick={() => notify('Editar permisos de ' + r[0])}
                    >
                      Editar
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card" style={{ padding: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Matriz de permisos</div>
          {perms.map((p, k) => (
            <div
              key={k}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '9px 0',
                borderBottom: k < perms.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <span style={{ fontSize: 13 }}>{p[0]}</span>
              <span className="pill" style={{ height: 24, fontSize: 11 }}>
                {I.lock()} {p[1]}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Audit({ notify }) {
  const [v, setV] = useState(null);
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 16,
        }}
      >
        <div>
          <div className="h1" style={{ marginBottom: 3 }}>
            Auditoría
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Registro append-only con cadena de hash verificable.
          </div>
        </div>
        <div className="btn btn-accent btn-sm" onClick={() => setV('ok')}>
          {I.shield()} Verificar cadena
        </div>
      </div>
      {v && (
        <div
          className="card"
          style={{
            padding: '12px 16px',
            marginBottom: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'var(--success-soft)',
            borderColor: 'var(--success)',
            color: 'var(--success)',
            fontWeight: 600,
            fontSize: 13.5,
          }}
        >
          {I.check()} Cadena íntegra · 48,210 entradas verificadas · hoy 21:30
        </div>
      )}
      <div className="card" style={{ overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Seq</th>
              <th>Fecha</th>
              <th>Acción</th>
              <th>Recurso</th>
              <th>Actor</th>
            </tr>
          </thead>
          <tbody>
            {[
              [
                '48211',
                '21:15:—',
                'trip.route_change',
                'trip · a4f29b1c · S/13→S/18',
                'pasajero+conductor',
              ],
              ['48210', '21:14:04', 'panic.create', 'trip · a4f29b1c', 'sistema'],
              ['48209', '21:13:50', 'payout.execute', 'liq · lq-2229', 'finance_01'],
              ['48208', '21:12:31', 'media.approve', 'trip · 7e10c3da', 'comp_sup'],
              ['48207', '21:10:02', 'driver.approve', 'driver · m-7741', 'admin_02'],
            ].map((r, k) => (
              <tr key={k}>
                <td className="mono">{r[0]}</td>
                <td className="mono sub">{r[1]}</td>
                <td className="mono" style={{ color: 'var(--accent)' }}>
                  {r[2]}
                </td>
                <td className="mono">{r[3]}</td>
                <td className="mono">{r[4]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const NAV = [
  [
    'Operación',
    [
      ['ops', 'Operación en vivo', I.grid],
      ['drivers', 'Conductores', I.users],
      ['reports', 'Reportes', I.up],
    ],
  ],
  [
    'Seguridad',
    [
      ['panics', 'Pánicos', I.shieldAlert, 'open'],
      ['media', 'Video', I.video],
    ],
  ],
  ['Flota', [['fleet', 'Flota', I.truck]]],
  [
    'Finanzas',
    [
      ['finance', 'Liquidaciones', I.money],
      ['pricing', 'Tarifas y zonas', I.up],
      ['revenue', 'Ingresos', I.money],
    ],
  ],
  ['Soporte', [['tickets', 'Tickets', I.file]]],
  [
    'Cumplimiento',
    [
      ['audit', 'Auditoría', I.file],
      ['roles', 'Roles y accesos', I.users],
      ['adminaccess', 'Accesibilidad', I.eye],
    ],
  ],
];

function App() {
  const [view, setView] = useState('login');
  const [stack, setStack] = useState(['ops']);
  const [toast, setToast] = useState(null);
  const [banner, setBanner] = useState(true);
  const [mfaFresh] = useState(true);
  const panicsOpen = 2;
  useEffect(() => {
    fit();
  }, [view]);
  const cur = stack[stack.length - 1];
  const go = (s, rep) => setStack((p) => (rep ? [...p.slice(0, -1), s] : [...p, s]));
  const notify = (m) => {
    setToast(m);
    clearTimeout(window.__at);
    window.__at = setTimeout(() => setToast(null), 1900);
  };
  const SECS = {
    ops: <Ops go={go} panicsOpen={panicsOpen} />,
    triplive: <TripLive go={go} notify={notify} />,
    panics: <Panics go={go} />,
    panicDetail: <PanicDetail go={go} notify={notify} />,
    drivers: <Drivers go={go} notify={notify} />,
    fleet: <Fleet />,
    pricing: <Pricing notify={notify} />,
    tickets: <Tickets go={go} notify={notify} />,
    reports: <Reports notify={notify} />,
    revenue: <Revenue />,
    roles: <Roles notify={notify} />,
    driverdetail: <DriverDetail go={go} notify={notify} />,
    adminsearch: <AdminSearch go={go} />,
    adminaccess: <AdminAccess notify={notify} />,
    finance: <Finance notify={notify} />,
    media: <Media notify={notify} />,
    audit: <Audit notify={notify} />,
  };
  if (view === 'login')
    return (
      <div
        className="app"
        style={{ alignItems: 'center', justifyContent: 'center', background: '#0f1626' }}
      >
        <div className="card" style={{ width: 380, padding: 30 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 9,
                background: 'var(--accent)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {I.shield()}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 17 }}>VEO</div>
              <div className="sub" style={{ fontSize: 12 }}>
                Operación y Seguridad
              </div>
            </div>
          </div>
          <div style={{ fontWeight: 700, fontSize: 18, marginTop: 18 }}>Inicia sesión</div>
          <div className="muted" style={{ fontSize: 13, marginTop: 4, marginBottom: 18 }}>
            Acceso restringido al personal autorizado.
          </div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)' }}>
            Correo corporativo
          </label>
          <input
            defaultValue="operador@veo.pe"
            style={{
              width: '100%',
              height: 44,
              margin: '6px 0 12px',
              border: '1px solid var(--border-strong)',
              borderRadius: 9,
              padding: '0 12px',
              fontSize: 14,
            }}
          />
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)' }}>
            Contraseña
          </label>
          <input
            type="password"
            defaultValue="123456"
            style={{
              width: '100%',
              height: 44,
              margin: '6px 0 12px',
              border: '1px solid var(--border-strong)',
              borderRadius: 9,
              padding: '0 12px',
              fontSize: 14,
            }}
          />
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)' }}>
            Código TOTP
          </label>
          <input
            className="mono"
            defaultValue="481 207"
            style={{
              width: '100%',
              height: 44,
              margin: '6px 0 16px',
              border: '1px solid var(--border-strong)',
              borderRadius: 9,
              padding: '0 12px',
              fontSize: 16,
              letterSpacing: '.2em',
              textAlign: 'center',
            }}
          />
          <div className="btn btn-accent" style={{ width: '100%' }} onClick={() => setView('app')}>
            Continuar
          </div>
        </div>
      </div>
    );
  return (
    <div className="app">
      <div className="side">
        <div className="brand">
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: 'var(--accent)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {I.shield()}
          </div>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>
            VEO <span style={{ color: '#7b86a0', fontWeight: 500, fontSize: 13 }}>Admin</span>
          </div>
        </div>
        {NAV.map((g, i) => (
          <div key={i}>
            <div className="grp">{g[0]}</div>
            {g[1].map((it) => (
              <div
                key={it[0]}
                className={
                  'nav' +
                  (cur === it[0] || (it[0] === 'panics' && cur === 'panicDetail') ? ' on' : '')
                }
                onClick={() => go(it[0], true)}
              >
                {it[2]()}
                <span>{it[1]}</span>
                {it[3] && panicsOpen > 0 && <span className="ct">{panicsOpen}</span>}
              </div>
            ))}
          </div>
        ))}
        <div
          style={{
            marginTop: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 8px',
            borderTop: '1px solid rgba(255,255,255,.08)',
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              background: '#2a3454',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            OP
          </div>
          <div style={{ fontSize: 12 }}>
            <div style={{ color: '#fff', fontWeight: 600 }}>Operador L2</div>
            <div style={{ color: '#7b86a0' }}>SUPPORT_L2</div>
          </div>
        </div>
      </div>
      <div className="main">
        <div className="top">
          <div className="search" style={{ cursor: 'pointer' }} onClick={() => go('adminsearch')}>
            {I.search()} Buscar viaje, conductor, ID…
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              className="badge"
              style={
                mfaFresh
                  ? { background: 'var(--success-soft)', color: 'var(--success)' }
                  : { background: 'var(--surface2)', color: 'var(--ink-muted)' }
              }
            >
              {I.lock()} {mfaFresh ? 'MFA fresco' : 'MFA inactivo'}
            </span>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: 'var(--surface2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--ink-muted)',
                cursor: 'pointer',
              }}
            >
              {I.sun()}
            </div>
          </div>
        </div>
        {banner && (
          <div className="panicbar">
            <span className="pulse" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {I.shieldAlert()} PÁNICO ACTIVO · {panicsOpen} alertas en curso
            </span>
            <span style={{ opacity: 0.85, fontWeight: 500 }}>Viaje a4f29b1c · hace 2 min</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              <div
                className="btn btn-sm"
                style={{ background: '#fff', color: 'var(--danger)' }}
                onClick={() => go('panics', true)}
              >
                Atender
              </div>
              <span style={{ cursor: 'pointer', opacity: 0.8 }} onClick={() => setBanner(false)}>
                {I.x()}
              </span>
            </div>
          </div>
        )}
        <div className="body">{SECS[cur]}</div>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

window.ADM = {
  Ops,
  TripLive,
  Panics,
  PanicDetail,
  Drivers,
  DriverDetail,
  AdminSearch,
  AdminAccess,
  Fleet,
  Pricing,
  Tickets,
  Reports,
  Revenue,
  Roles,
  Finance,
  Media,
  Audit,
  App,
  NAV,
  Pill,
  I,
  MiniMap,
  fit,
};
