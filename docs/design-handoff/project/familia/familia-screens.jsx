/* VEO Familia — pantallas compartidas (clicable + lienzo). Inyecta CSS y exporta window.FAM. */
const { useState, useEffect } = React;
if (!document.getElementById('fam-css')) {
  const st = document.createElement('style');
  st.id = 'fam-css';
  st.textContent = `
 .fam{--bg:#f5f6f4;--surface:#ffffff;--surface2:#eef0f3;--ink:#1c2230;--ink-muted:#5a6478;--ink-subtle:#8b94a3;
  --border:#e7e9ee;--border-strong:#d4d8e0;--brand:#27304a;--accent:#1f9bd4;--on-accent:#fff;--success:#1f9d6b;--warn:#cf9220;
  --route:#1f9bd4;--route-glow:rgba(31,155,212,.22);--font-d:'Space Grotesk',sans-serif;--font-u:'Inter',sans-serif;--font-m:'JetBrains Mono',monospace;}
 .fscreen{position:relative;width:390px;height:844px;background:var(--bg);color:var(--ink);font-family:var(--font-u);overflow:hidden;display:flex;flex-direction:column;}
 .fam .fbar{height:46px;display:flex;align-items:center;justify-content:space-between;padding:14px 24px 0;font-weight:600;font-size:14px;color:var(--ink);flex:none;}
 .fam .fbar .r{display:flex;gap:6px;}
 .fpad{padding:0 22px;}
 .fdisp{font-family:var(--font-d);font-weight:600;letter-spacing:-.02em;line-height:1.08;}
 .fmuted{color:var(--ink-muted);}.fsub{color:var(--ink-subtle);}
 .fmono{font-family:var(--font-m);font-variant-numeric:tabular-nums;}
 .fbtn{appearance:none;border:none;cursor:pointer;font-family:var(--font-u);font-weight:600;border-radius:14px;height:54px;display:flex;align-items:center;justify-content:center;gap:9px;width:100%;font-size:16px;transition:transform .1s;}
 .fbtn:active{transform:scale(.98);}
 .fbtn-accent{background:var(--accent);color:#fff;}
 .fbtn-brand{background:var(--brand);color:#fff;}
 .fbtn-ghost{background:var(--surface);color:var(--ink);border:1px solid var(--border-strong);}
 .fcard{background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:0 1px 2px rgba(20,30,50,.04),0 6px 20px rgba(20,30,50,.04);}
 .fpill{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:99px;background:var(--surface);border:1px solid var(--border);font-size:13px;font-weight:600;}
 .fdot{width:8px;height:8px;border-radius:50%;flex:none;}
 .fmap{position:absolute;inset:0;background:#e9ecef;overflow:hidden;}.fmap svg{position:absolute;inset:0;width:100%;height:100%;}
 .flead{width:44px;height:44px;border-radius:13px;background:var(--surface2);display:flex;align-items:center;justify-content:center;flex:none;color:var(--brand);}
 .fph{background:repeating-linear-gradient(135deg,#dfe3ea 0 9px,#e9ecf1 9px 18px);position:relative;overflow:hidden;}
 .fph .lbl{position:absolute;left:8px;bottom:7px;font-family:var(--font-m);font-size:9px;color:var(--ink-subtle);background:rgba(255,255,255,.7);padding:2px 6px;border-radius:5px;}
 .fskl{background:linear-gradient(90deg,#e9ebef 0%,#f1f3f6 50%,#e9ebef 100%);border-radius:12px;}
 @keyframes fpr{0%{transform:scale(.7);opacity:.5;}80%,100%{transform:scale(2.2);opacity:0;}}
 .fradar{position:relative;}.fradar::before{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--success);animation:fpr 2s ease-out infinite;}
 .fnum{width:26px;height:26px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex:none;}
`;
  document.head.appendChild(st);
}

const F = {
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
  eyeoff: () => (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.8 2.8" />
      <path d="M9.4 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3M6.2 6.3A17 17 0 0 0 2 12s3.5 7 10 7a9.5 9.5 0 0 0 3.3-.6" />
    </svg>
  ),
  clock: () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" />
    </svg>
  ),
  shield: () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6z" />
    </svg>
  ),
  phone: () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path d="M5 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L19 16l-1 3" />
      <path d="M16 21a13 13 0 0 1-13-13" />
    </svg>
  ),
  star: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17.8 6.7 19.2l1-5.8L3.5 9.2l5.9-.9z" />
    </svg>
  ),
  check: () => (
    <svg
      width="26"
      height="26"
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
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
  mapi: () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" />
      <path d="M9 4v14M15 6v14" />
    </svg>
  ),
  chevR: () => (
    <svg
      width="18"
      height="18"
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
      width="22"
      height="22"
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
  wifioff: () => (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M3 3l18 18M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 3-2M19 12.9a10 10 0 0 0-7-2.8M2 8.8a16 16 0 0 1 4-2.6M22 8.8a16 16 0 0 0-6.5-3.2" />
      <circle cx="12" cy="20" r="0.6" fill="currentColor" />
    </svg>
  ),
  broken: () => (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 13l-1 1a3.5 3.5 0 0 1-5-5l2-2M15 11l1-1a3.5 3.5 0 0 0-5-5l-1 1M9 4V2M5 8H3M15 20v2M19 16h2" />
    </svg>
  ),
  refresh: () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 1 2.6 6.4M3 18v-4h4" />
    </svg>
  ),
  signal: () => (
    <svg width="16" height="11" viewBox="0 0 18 12">
      <g fill="currentColor">
        <rect x="0" y="8" width="3" height="4" rx="1" />
        <rect x="5" y="5" width="3" height="7" rx="1" />
        <rect x="10" y="2.5" width="3" height="9.5" rx="1" />
        <rect x="15" y="0" width="3" height="12" rx="1" />
      </g>
    </svg>
  ),
  batt: () => (
    <svg width="22" height="11" viewBox="0 0 26 13">
      <rect
        x="0.5"
        y="0.5"
        width="22"
        height="12"
        rx="3.2"
        fill="none"
        stroke="currentColor"
        opacity=".4"
      />
      <rect x="2" y="2" width="17" height="9" rx="2" fill="currentColor" />
    </svg>
  ),
};
const Bar = () => (
  <div className="fbar">
    <span className="fmono">9:41</span>
    <div className="r">
      {F.signal()}
      {F.batt()}
    </div>
  </div>
);
const Mark = ({ size = 22 }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
    <div
      style={{
        width: size + 8,
        height: size + 8,
        borderRadius: 9,
        background: 'var(--brand)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {F.eye()}
    </div>
    <span className="fdisp" style={{ fontSize: size, fontWeight: 700 }}>
      VEO <span style={{ color: 'var(--ink-muted)', fontWeight: 600 }}>Family</span>
    </span>
  </div>
);
const Live = ({ on = true }) => (
  <span
    className="fpill"
    style={{
      background: 'rgba(31,157,107,.1)',
      borderColor: 'rgba(31,157,107,.3)',
      color: 'var(--success)',
    }}
  >
    <span className="fradar fdot" style={{ background: 'var(--success)' }} />
    {on ? 'En vivo' : 'Reconectando'}
  </span>
);

function FMap({ driver = true, dim = false }) {
  const route = 'M 96 612 L 96 500 L 206 500 L 206 360 L 300 360 L 300 196';
  return (
    <div className="fmap">
      <svg viewBox="0 0 390 844" preserveAspectRatio="xMidYMid slice">
        <rect x="-20" y="-20" width="430" height="884" fill="#e9ecef" />
        <g opacity="0.7">
          {Array.from({ length: 7 }).map((_, r) =>
            Array.from({ length: 5 }).map((_, c) => {
              const x = c * 92 - 30 + (r % 2) * 16,
                y = r * 120 - 40;
              return (
                <rect key={r + '-' + c} x={x} y={y} width="74" height="92" rx="6" fill="#f1f3f5" />
              );
            }),
          )}
        </g>
        <g stroke="#dde1e6" strokeWidth="9" fill="none">
          <path d="M-20 140 H410" />
          <path d="M-20 360 H410" />
          <path d="M-20 500 H410" />
          <path d="M-20 700 H410" />
          <path d="M96 -20 V860" />
          <path d="M206 -20 V860" />
          <path d="M300 -20 V860" />
        </g>
        <rect x="222" y="150" width="120" height="120" rx="14" fill="#e3efe8" />
        <path
          d={route}
          fill="none"
          stroke="var(--route-glow)"
          strokeWidth="16"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={route}
          fill="none"
          stroke="var(--route)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="96" cy="612" r="8" fill="#fff" stroke="var(--brand)" strokeWidth="3.5" />
        <circle cx="300" cy="196" r="11" fill="none" stroke="var(--brand)" strokeWidth="3.5" />
        {driver && (
          <g transform="translate(206 430)">
            <circle r="26" fill="var(--route-glow)" />
            <circle r="12" fill="var(--accent)" stroke="#fff" strokeWidth="3" />
          </g>
        )}
      </svg>
      {dim && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(245,246,244,.55)' }} />
      )}
    </div>
  );
}

/* ---------- screens ---------- */
const Landing = ({ go }) => (
  <div className="fscreen">
    <Bar />
    <div className="fpad scroll" style={{ flex: 1, overflowY: 'auto', paddingBottom: 30 }}>
      <div style={{ paddingTop: 14 }}>
        <Mark />
      </div>
      <h1 className="fdisp" style={{ fontSize: 32, marginTop: 26, lineHeight: 1.1 }}>
        Acompaña el viaje de quien quieres, en vivo.
      </h1>
      <p className="fmuted" style={{ marginTop: 14, fontSize: 15, lineHeight: 1.55 }}>
        Cuando un familiar comparte su viaje, recibes un link. Al abrirlo ves dónde está, quién
        maneja y cuánto falta. Sin instalar nada.
      </p>
      <div className="fdisp" style={{ fontSize: 16, marginTop: 26, marginBottom: 12 }}>
        Cómo funciona
      </div>
      {[
        ['Tu familiar comparte el viaje desde la app de VEO.'],
        ['Abres el link en tu teléfono — se abre el seguimiento.'],
        ['Sigues el viaje hasta que llega. El link caduca al terminar.'],
      ].map((s, k) => (
        <div
          key={k}
          style={{ display: 'flex', gap: 13, alignItems: 'flex-start', marginBottom: 14 }}
        >
          <span className="fnum">{k + 1}</span>
          <span style={{ fontSize: 14.5, lineHeight: 1.45, paddingTop: 3 }}>{s[0]}</span>
        </div>
      ))}
      <div className="fdisp" style={{ fontSize: 16, marginTop: 18, marginBottom: 12 }}>
        Qué vas a ver
      </div>
      <div className="fcard" style={{ padding: '4px 16px', marginBottom: 18 }}>
        {[
          [F.mapi, 'El recorrido en un mapa'],
          [F.clock, 'Estado y tiempo de llegada'],
          [F.shield, 'Quién maneja: nombre, placa, modelo y color'],
        ].map((r, k) => (
          <div
            key={k}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 13,
              padding: '13px 0',
              borderBottom: k < 2 ? '1px solid var(--border)' : 'none',
            }}
          >
            <span style={{ color: 'var(--accent)' }}>{r[0]()}</span>
            <span style={{ fontSize: 14.5 }}>{r[1]}</span>
          </div>
        ))}
      </div>
      <div
        className="fcard"
        style={{
          padding: 16,
          background: 'var(--surface2)',
          border: 'none',
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
        }}
      >
        <span style={{ color: 'var(--success)', marginTop: 1 }}>{F.shield()}</span>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Tu acceso es solo de lectura.</div>
          <div className="fsub" style={{ fontSize: 13, marginTop: 3, lineHeight: 1.45 }}>
            Puedes mirar el viaje, nada más. El link tiene vigencia corta y caduca solo.
          </div>
        </div>
      </div>
      <button className="fbtn fbtn-accent" style={{ marginTop: 20 }} onClick={() => go('loading')}>
        Ver demo de un viaje
      </button>
      <p
        class2="fsub"
        className="fsub"
        style={{ fontSize: 12, textAlign: 'center', marginTop: 16 }}
        onClick={() => go('access')}
      >
        <span style={{ cursor: 'pointer', textDecoration: 'underline' }}>
          Accesibilidad e idioma
        </span>{' '}
        · VEO · Movilidad segura.
      </p>
    </div>
  </div>
);

const Loading = ({ go }) => {
  useEffect(() => {
    if (go) {
      const t = setTimeout(() => go('live', true), 1500);
      return () => clearTimeout(t);
    }
  }, []);
  return (
    <div className="fscreen">
      <Bar />
      <div className="fskl" style={{ height: '46%', borderRadius: 0 }} />
      <div className="fpad" style={{ paddingTop: 18 }}>
        <div className="fskl" style={{ height: 80, borderRadius: 18, marginBottom: 14 }} />
        <div className="fskl" style={{ height: 96, borderRadius: 18, marginBottom: 14 }} />
        <div className="fskl" style={{ height: 54, borderRadius: 14 }} />
      </div>
    </div>
  );
};

function LiveTrip({ go, notify }) {
  return (
    <div className="fscreen">
      <Bar />
      <div style={{ position: 'relative', height: '48%' }}>
        <FMap />
        <div
          className="fpad"
          style={{
            position: 'absolute',
            top: 12,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span className="fpill">
            <span style={{ color: 'var(--brand)' }}>{F.eye()}</span>Vista familiar
          </span>
          <Live />
        </div>
      </div>
      <div
        className="fpad scroll"
        style={{ flex: 1, overflowY: 'auto', paddingTop: 16, paddingBottom: 24 }}
      >
        <div className="fcard" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div
              className="fsub"
              style={{
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: '.08em',
                textTransform: 'uppercase',
              }}
            >
              Estado del viaje
            </div>
            <span
              className="fpill"
              style={{
                height: 28,
                color: 'var(--accent)',
                borderColor: 'rgba(31,155,212,.3)',
                background: 'rgba(31,155,212,.08)',
              }}
            >
              En camino
            </span>
          </div>
          <div className="fdisp" style={{ fontSize: 22, marginTop: 10 }}>
            Viaje de María F.
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 8,
              color: 'var(--accent)',
            }}
          >
            {F.clock()}
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>
              Llega en unos 8 minutos
            </span>
          </div>
        </div>
        <div
          className="fcard"
          style={{ padding: 16, marginBottom: 14, display: 'flex', gap: 14, alignItems: 'center' }}
        >
          <div className="fph" style={{ width: 56, height: 56, borderRadius: 16, flex: 'none' }}>
            <span className="lbl" style={{ fontSize: 7 }}>
              foto
            </span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontWeight: 700, fontSize: 16 }}>Khalid Ríos</span>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  color: 'var(--warn)',
                  fontSize: 13,
                }}
              >
                {F.star()}
                <span style={{ color: 'var(--ink)' }}>4.97</span>
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 8,
                paddingTop: 8,
                borderTop: '1px solid var(--border)',
              }}
            >
              <span
                className="fmono"
                style={{
                  fontWeight: 700,
                  fontSize: 14,
                  letterSpacing: '.08em',
                  background: 'var(--surface2)',
                  padding: '3px 9px',
                  borderRadius: 7,
                }}
              >
                ABC-481
              </span>
              <span className="fsub" style={{ fontSize: 13 }}>
                Toyota Yaris · Plomo
              </span>
            </div>
          </div>
        </div>
        <div className="fcard" style={{ padding: 0, marginBottom: 14, overflow: 'hidden' }}>
          <div
            className="fph"
            style={{ height: 150, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <span className="lbl">cámara del viaje · en vivo</span>
            <span
              className="fpill"
              style={{
                position: 'absolute',
                top: 10,
                left: 10,
                height: 26,
                background: 'rgba(31,157,107,.12)',
                borderColor: 'rgba(31,157,107,.3)',
                color: 'var(--success)',
              }}
            >
              <span className="fdot" style={{ background: 'var(--success)' }} />
              En vivo
            </span>
          </div>
          <div style={{ padding: '12px 16px', fontWeight: 600, fontSize: 14 }}>
            Cámara del viaje
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className="fbtn fbtn-ghost"
            style={{ flex: 1 }}
            onClick={() => notify && notify('Llamando a María Fernanda…')}
          >
            {F.phone()} Llamar a María F.
          </button>
          <button
            className="fbtn"
            style={{ flex: 1, background: '#c0322c', color: '#fff' }}
            onClick={() => (go ? go('safety') : notify && notify('Reportando emergencia a VEO'))}
          >
            {F.shield()} Emergencia
          </button>
        </div>
        <p
          className="fsub"
          style={{ fontSize: 11.5, textAlign: 'center', marginTop: 8, lineHeight: 1.4 }}
        >
          "Llamar" contacta a tu familiar. "Emergencia" avisa al equipo de seguridad de VEO.
        </p>
        <p
          className="fsub"
          style={{ fontSize: 12, textAlign: 'center', marginTop: 14, lineHeight: 1.45 }}
        >
          Tu acceso es solo de lectura. El link caduca cuando el viaje termina.
        </p>
        {go && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              marginTop: 16,
              flexWrap: 'wrap',
              justifyContent: 'center',
            }}
          >
            {[
              ['safety', 'Alerta'],
              ['completed', 'Llegó'],
              ['cancelled', 'Cancelado'],
              ['expired', 'Caducó'],
              ['revoked', 'Revocado'],
              ['offline', 'Sin conexión'],
            ].map((d) => (
              <span
                key={d[0]}
                onClick={() => go(d[0])}
                style={{
                  fontSize: 11,
                  color: 'var(--ink-subtle)',
                  border: '1px dashed var(--border-strong)',
                  borderRadius: 8,
                  padding: '4px 9px',
                  cursor: 'pointer',
                }}
              >
                demo: {d[1]}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const State = ({ icon, iconBg, iconColor, title, body, cta, onCta, go }) => (
  <div className="fscreen">
    <Bar />
    <div
      className="fpad"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
      }}
    >
      <div style={{ marginBottom: 18 }}>
        <Mark size={18} />
      </div>
      <div
        style={{
          width: 88,
          height: 88,
          borderRadius: '50%',
          background: iconBg,
          color: iconColor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 22,
        }}
      >
        {icon()}
      </div>
      <h1 className="fdisp" style={{ fontSize: 27 }}>
        {title}
      </h1>
      <p
        className="fmuted"
        style={{ marginTop: 12, fontSize: 15, lineHeight: 1.55, maxWidth: 300 }}
      >
        {body}
      </p>
      {cta && (
        <button
          className="fbtn fbtn-accent"
          style={{ marginTop: 24, width: 'auto', padding: '0 26px' }}
          onClick={onCta}
        >
          {cta}
        </button>
      )}
    </div>
  </div>
);

const FamSafety = ({ go }) => (
  <div className="fscreen">
    <Bar />
    <div style={{ position: 'relative', height: '42%' }}>
      <FMap />
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(216,69,62,.10)' }} />
      <div
        className="fpad"
        style={{
          position: 'absolute',
          top: 12,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <span
          className="fpill"
          style={{
            background: 'rgba(216,69,62,.12)',
            borderColor: 'rgba(216,69,62,.4)',
            color: '#c0322c',
          }}
        >
          <span className="fdot" style={{ background: '#c0322c' }} />
          Alerta de seguridad
        </span>
      </div>
    </div>
    <div
      className="fpad scroll"
      style={{ flex: 1, overflowY: 'auto', paddingTop: 16, paddingBottom: 24 }}
    >
      <div
        className="fcard"
        style={{
          padding: 18,
          marginBottom: 14,
          borderColor: 'rgba(216,69,62,.4)',
          background: 'rgba(216,69,62,.05)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ color: '#c0322c' }}>{F.shield()}</span>
          <div className="fdisp" style={{ fontSize: 20 }}>
            María Fernanda activó el botón de ayuda
          </div>
        </div>
        <p className="fmuted" style={{ fontSize: 14, lineHeight: 1.55 }}>
          El equipo de seguridad de VEO ya fue notificado y está siguiendo el viaje en tiempo real.
          Te avisamos porque eres su contacto de confianza.
        </p>
      </div>
      <div className="fcard" style={{ padding: 16, marginBottom: 14 }}>
        {[
          [F.mapi, 'Ubicación en vivo compartida con seguridad'],
          [F.shield, 'Equipo VEO atendiendo · caso PNC-7F3A'],
          [F.eye, 'Cámara del viaje grabando'],
        ].map((r, k) => (
          <div
            key={k}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 0',
              borderBottom: k < 2 ? '1px solid var(--border)' : 'none',
            }}
          >
            <span style={{ color: 'var(--accent)' }}>{r[0]()}</span>
            <span style={{ fontSize: 14 }}>{r[1]}</span>
          </div>
        ))}
      </div>
      <button className="fbtn" style={{ background: '#c0322c', color: '#fff', marginBottom: 10 }}>
        {F.phone()} Llamar a la central de seguridad
      </button>
      <button className="fbtn fbtn-ghost" onClick={() => go && go('live', true)}>
        Ver el viaje en vivo
      </button>
      <p
        className="fsub"
        style={{ fontSize: 12, textAlign: 'center', marginTop: 14, lineHeight: 1.45 }}
      >
        Mantén la calma. El equipo de VEO está en contacto con tu familiar.
      </p>
    </div>
  </div>
);

const Completed = ({ go }) => (
  <State
    go={go}
    icon={F.check}
    iconBg="rgba(31,157,107,.12)"
    iconColor="var(--success)"
    title="El viaje terminó"
    body="Tu familiar llegó a su destino. Gracias por acompañarlo en el camino."
  />
);
const Cancelled = ({ go }) => (
  <State
    go={go}
    icon={F.x}
    iconBg="var(--surface2)"
    iconColor="var(--ink-muted)"
    title="El viaje se canceló"
    body="Este viaje no se realizó. Si tienes dudas, comunícate con tu familiar."
  />
);
const Expired = ({ go }) => (
  <State
    go={go}
    icon={F.clock}
    iconBg="var(--surface2)"
    iconColor="var(--ink-muted)"
    title="Este link ya caducó"
    body="Los links de seguimiento duran poco por seguridad. Pídele a tu familiar uno nuevo."
  />
);
const Invalid = ({ go }) => (
  <State
    go={go}
    icon={F.broken}
    iconBg="var(--surface2)"
    iconColor="var(--ink-muted)"
    title="Este link no es válido"
    body="Puede que el enlace esté incompleto. Pídele a tu familiar que te lo comparta de nuevo."
  />
);
const Revoked = ({ go }) => (
  <State
    go={go}
    icon={F.eyeoff}
    iconBg="var(--surface2)"
    iconColor="var(--ink-muted)"
    title="El viaje dejó de compartirse"
    body="Tu familiar desactivó el seguimiento. Si lo necesitas, pídele que lo comparta otra vez."
  />
);
const Offline = ({ go }) => (
  <State
    go={go}
    icon={F.wifioff}
    iconBg="var(--surface2)"
    iconColor="var(--ink-muted)"
    title="No pudimos cargar el viaje"
    body="Revisa tu conexión a internet e intenta de nuevo en un momento."
    cta="Intentar de nuevo"
    onCta={() => go && go('loading', true)}
  />
);
const NotFound = ({ go }) => (
  <State
    go={go}
    icon={F.broken}
    iconBg="var(--surface2)"
    iconColor="var(--ink-muted)"
    title="No encontramos esta página"
    body="Para ver un viaje necesitas el link que te compartió tu familiar."
    cta="Ir al inicio"
    onCta={() => go && go('landing', true)}
  />
);

const FamAccess = ({ back, go }) => {
  return <FA back={back} go={go} />;
};
function FA({ back, go }) {
  const [size, setSize] = React.useState(1);
  const [lang, setLang] = React.useState('es');
  const [hc, setHc] = React.useState(false);
  const S = {
    es: [
      'Accesibilidad e idioma',
      'Tamaño de texto',
      'Idioma',
      'Alto contraste',
      'Así se verá',
      'Viaje de María F. · en camino',
      'Listo',
    ],
    en: [
      'Accessibility & language',
      'Text size',
      'Language',
      'High contrast',
      'Preview',
      'María F. trip · on the way',
      'Done',
    ],
    qu: [
      'Accesibilidad',
      'Qillqa sayaynin',
      'Rimay',
      'Sinchi llimphi',
      'Rikuchiy',
      'María F. puriynin',
      'Listo',
    ],
  }[lang];
  return (
    <div className="fscreen">
      <Bar />
      <div
        className="fpad"
        style={{ paddingTop: 14, paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 12 }}
      >
        <div onClick={back} style={{ cursor: 'pointer', color: 'var(--ink)' }}>
          {F.arrowL()}
        </div>
        <h2 className="fdisp" style={{ fontSize: 20 }}>
          {S[0]}
        </h2>
      </div>
      <div className="fpad scroll" style={{ flex: 1, overflowY: 'auto' }}>
        <div className="fsub" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
          {S[1]}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {[0.9, 1, 1.2, 1.4].map((o, i) => (
            <button
              key={i}
              onClick={() => setSize(o)}
              className="fpill"
              style={{
                fontSize: 13 + i * 4 + 'px',
                borderColor: size === o ? 'var(--accent)' : 'var(--border)',
                color: size === o ? 'var(--accent)' : 'var(--ink)',
              }}
            >
              A
            </button>
          ))}
        </div>
        <div className="fsub" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
          {S[2]}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {[
            ['es', 'Español'],
            ['en', 'English'],
            ['qu', 'Runa Simi'],
          ].map((o) => (
            <button
              key={o[0]}
              onClick={() => setLang(o[0])}
              className="fpill"
              style={{
                borderColor: lang === o[0] ? 'var(--accent)' : 'var(--border)',
                color: lang === o[0] ? 'var(--accent)' : 'var(--ink)',
              }}
            >
              {o[1]}
            </button>
          ))}
        </div>
        <div
          className="fcard"
          style={{
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 14,
          }}
        >
          <span style={{ color: 'var(--accent)' }}>{F.shield()}</span>
          <span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>{S[3]}</span>
          <span
            onClick={() => setHc(!hc)}
            style={{
              width: 44,
              height: 26,
              borderRadius: 99,
              background: hc ? 'var(--accent)' : '#d4d8e0',
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
                background: '#fff',
              }}
            />
          </span>
        </div>
        <div className="fsub" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
          {S[4]}
        </div>
        <div
          className="fcard"
          style={{
            padding: 18,
            background: hc ? '#000' : 'var(--surface)',
            border: hc ? '2px solid #fff' : '1px solid var(--border)',
          }}
        >
          <div className="fdisp" style={{ fontSize: 20 * size, color: hc ? '#fff' : 'var(--ink)' }}>
            {S[5]}
          </div>
        </div>
      </div>
      <div className="fpad" style={{ paddingBottom: 20 }}>
        <button className="fbtn fbtn-accent" onClick={back}>
          {S[6]}
        </button>
      </div>
    </div>
  );
}

window.FAM = {
  SCR: {
    landing: Landing,
    loading: Loading,
    live: LiveTrip,
    safety: FamSafety,
    access: FamAccess,
    completed: Completed,
    cancelled: Cancelled,
    expired: Expired,
    invalid: Invalid,
    revoked: Revoked,
    offline: Offline,
    notfound: NotFound,
  },
  ORDER: [
    ['landing', 'Landing'],
    ['loading', 'Validando link'],
    ['live', 'Viaje en vivo'],
    ['safety', 'Alerta de seguridad'],
    ['access', 'Accesibilidad e idioma'],
    ['completed', 'Terminal · Llegó'],
    ['cancelled', 'Terminal · Cancelado'],
    ['expired', 'Terminal · Caducó'],
    ['invalid', 'Terminal · Inválido'],
    ['revoked', 'Terminal · Revocado'],
    ['offline', 'Terminal · Sin conexión'],
    ['notfound', '404'],
  ],
};
