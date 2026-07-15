#!/usr/bin/env node
/**
 * otp-viewer · Visor de OTPs de PRUEBA para DESARROLLO (solo dev — nunca en prod).
 *
 * En dev los OTP nunca se guardan en claro (solo su sha256 en Redis). El código en claro existe
 * únicamente cuando se "envía" por el sandbox sender. Por eso cada sandbox sender (SMS de identity,
 * SMS de share, email de notification) hace un fire-and-forget `POST /ingest` a este visor con el
 * mensaje completo. Acá se guardan en MEMORIA (anillo acotado, efímero) y se sirven en un HTML que
 * se auto-refresca, agrupado por app/canal. Cero dependencias (http nativo de Node 20).
 *
 * Puerto fijo del proyecto: 5190 (rango frontends veo 5000–5299, ver REGISTRO-PUERTOS).
 *   node dev-stack/otp-viewer/server.mjs        # usa PORT o 5190
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { totp } from '../lib/totp.mjs'; // TOTP compartido (antes duplicado acá) — misma fuente que login.mjs

const PORT = Number(process.env.OTP_VIEWER_PORT ?? process.env.PORT ?? 5190);
const MAX_ENTRIES = 100; // anillo acotado: solo los últimos N (es un visor de dev, no un historial)
const PG_CONT = process.env.DEV_PG_CONTAINER ?? 'veo-postgres'; // mismo contenedor que usa veo.sh

// ─── Admin panel (solo dev) ──────────────────────────────────────────────────────────────────
// Credenciales del SUPERADMIN de dev (seed: services/identity-service/scripts/seed.ts) + secreto TOTP
// FIJO de dev. DEV_ADMIN_TOTP_SECRET DEBE coincidir EXACTO con DEV_TOTP_SECRET del seed para que el
// código calculado acá valide contra identity. Todo esto es DEV — nunca toca prod (en prod el TOTP es random).
const ADMIN = {
  email: process.env.DEV_ADMIN_EMAIL ?? 'admin@veo.pe',
  password: process.env.DEV_ADMIN_PASSWORD ?? 'ChangeMe_VEO_2026!',
  totpSecret: process.env.DEV_ADMIN_TOTP_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
};

/** Estado del panel admin: credenciales + TOTP vivo + segundos hasta que rota. */
function adminState() {
  const now = Date.now();
  return {
    email: ADMIN.email,
    password: ADMIN.password,
    totp: totp(ADMIN.totpSecret, now),
    secondsLeft: 30 - (Math.floor(now / 1000) % 30),
  };
}

/** @type {Array<{id:number, service:string, channel:string, to:string, message:string, code:string|null, at:number}>} */
const entries = [];
let seq = 0;

/** Extrae el primer grupo de 4–8 dígitos del mensaje (el OTP), o null si no hay. Solo para resaltar. */
function extractCode(message) {
  const match = /\b(\d{4,8})\b/.exec(String(message ?? ''));
  return match ? match[1] : null;
}

function addEntry(payload) {
  const message = String(payload.message ?? '');
  entries.unshift({
    id: ++seq,
    service: String(payload.service ?? 'desconocido'),
    channel: String(payload.channel ?? 'sms'),
    to: String(payload.to ?? ''),
    message,
    code: payload.code ? String(payload.code) : extractCode(message),
    at: typeof payload.at === 'number' ? payload.at : Date.now(),
  });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
}

// ─── Backfill desde la DB (lo mismo que `veo.sh otp`) ────────────────────────────────────────
// El ingest en vivo es fire-and-forget a memoria: cualquier OTP emitido con el visor caído se pierde.
// Pero TODO OTP de driver/pasajero (SMS sandbox o email) queda en notification.notifications
// (payload->>'code'), que es exactamente lo que lee `veo.sh otp`. Este poller trae esas filas cada
// POLL_MS vía `docker exec psql` (cero deps npm) y las mergea con dedup, así el visor muestra el
// historial completo aunque se reinicie. Si docker/psql no está, falla silencioso: el ingest sigue.
const POLL_MS = 3000;
const seenDbKeys = new Set(); // "epoch|destino|código" de filas ya mergeadas

const DB_QUERY = `SELECT extract(epoch from created_at)::bigint, channel,
       COALESCE(payload->>'to', payload->>'email', payload->>'recipient', '?'),
       payload->>'code', status
  FROM notification.notifications WHERE payload ? 'code'
  ORDER BY created_at DESC LIMIT 30;`;

function pollDb() {
  execFile(
    'docker',
    ['exec', PG_CONT, 'psql', '-U', 'veo', '-d', 'veo', '-t', '-A', '-F', '\t', '-c', DB_QUERY],
    { timeout: 5000 },
    (err, stdout) => {
      if (err) return; // infra abajo o docker ausente — el visor sigue con el ingest en vivo
      for (const line of stdout.split('\n')) {
        const [epoch, channel, to, code, status] = line.split('\t');
        if (!epoch || !code) continue;
        const key = `${epoch}|${to}|${code}`;
        if (seenDbKeys.has(key)) continue;
        seenDbKeys.add(key);
        const at = Number(epoch) * 1000;
        // El sender ya lo pudo haber ingestado en vivo: mismo código+destino cerca en el tiempo → skip.
        if (entries.some((e) => e.code === code && e.to === to && Math.abs(e.at - at) < 90_000)) continue;
        addEntry({ service: 'driver/pasajero (db)', channel, to, message: `estado: ${status}`, code, at });
      }
      entries.sort((a, b) => b.at - a.at);
      if (seenDbKeys.size > 500) seenDbKeys.clear(); // acotado; el dedup contra `entries` sigue cubriendo
    },
  );
}
pollDb();
setInterval(pollDb, POLL_MS).unref();

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Ingesta desde los sandbox senders (fire-and-forget). Acepta un OTP o un array.
  if (req.method === 'POST' && url.pathname === '/ingest') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(); // guard anti-payload gigante
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(raw || '{}');
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) addEntry(item);
        send(res, 202, JSON.stringify({ ok: true, count: entries.length }));
      } catch {
        send(res, 400, JSON.stringify({ ok: false, error: 'json inválido' }));
      }
    });
    return;
  }

  // Feed JSON que el HTML poll-ea.
  if (req.method === 'GET' && url.pathname === '/api/otps') {
    send(res, 200, JSON.stringify({ entries, admin: adminState(), now: Date.now() }));
    return;
  }

  // Limpiar (botón del HTML).
  if (req.method === 'POST' && url.pathname === '/api/clear') {
    entries.length = 0;
    send(res, 200, JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    send(res, 200, HTML, 'text/html; charset=utf-8');
    return;
  }

  send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[otp-viewer] visor de OTPs de dev en http://localhost:${PORT}  (ingest: POST /ingest)`);
});

const HTML = /* html */ `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VEO · OTPs de prueba (dev)</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0b0e14; color: #e6e9ef; }
  header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px;
    padding: 14px 20px; background: #11151f; border-bottom: 1px solid #1e2433; }
  header h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: .2px; }
  header .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #1b2333; color: #8fa0bf; }
  header .spacer { flex: 1; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: #2dd4a7; box-shadow: 0 0 8px #2dd4a7; }
  header button { background: #1b2333; color: #c7d0e0; border: 1px solid #2a3346; border-radius: 8px;
    padding: 6px 12px; font-size: 12px; cursor: pointer; }
  header button:hover { background: #232c3e; }
  .wrap { padding: 18px 20px 60px; max-width: 1100px; margin: 0 auto; }
  .empty { text-align: center; color: #6b7891; padding: 80px 20px; }
  .group { margin-bottom: 26px; }
  .group h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .8px; color: #7c8aa8;
    margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
  .group h2 .n { background: #1b2333; color: #9fb0d0; border-radius: 999px; padding: 1px 8px; font-size: 11px; }
  .card { background: #121826; border: 1px solid #1e2738; border-radius: 12px; padding: 12px 14px;
    margin-bottom: 8px; display: flex; align-items: center; gap: 14px; transition: background .3s; }
  .card.fresh { background: #15233a; border-color: #2a4a6b; }
  .card .code { font: 600 22px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 4px;
    color: #5eead4; background: #0e1a17; border: 1px solid #1c3a33; border-radius: 8px; padding: 8px 12px;
    cursor: pointer; min-width: 120px; text-align: center; }
  .card .code.none { color: #6b7891; letter-spacing: 0; font-size: 13px; }
  .card .meta { flex: 1; min-width: 0; }
  .card .to { font-weight: 600; color: #dfe5f0; }
  .card .msg { color: #8492ab; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .time { color: #6b7891; font-size: 12px; white-space: nowrap; }
  .pill { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid #2a3346; color: #8fa0bf; }
  .pill.email { color: #c4b5fd; border-color: #4c3f7a; }
  .pill.sms { color: #7dd3fc; border-color: #2a4d63; }
  .admin-card { background: linear-gradient(180deg,#1a2236,#141a28); border: 1px solid #2c3a5a;
    border-radius: 14px; padding: 16px 18px; margin-bottom: 26px; }
  .admin-card .hd { font-size: 12px; text-transform: uppercase; letter-spacing: .8px; color: #8aa0c8;
    margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
  .admin-card .hd .tag { background: #2a3450; color: #b9c6e6; border-radius: 999px; padding: 1px 8px; font-size: 10.5px; }
  .admin-grid { display: flex; flex-wrap: wrap; gap: 10px; align-items: stretch; }
  .field { background: #0e1422; border: 1px solid #20293c; border-radius: 10px; padding: 8px 12px; flex: 1; min-width: 200px; }
  .field .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .6px; color: #6b7891; }
  .field .v { font: 600 15px/1.4 ui-monospace, Menlo, monospace; color: #e6e9ef; cursor: pointer;
    word-break: break-all; }
  .field.totp { background: #0e1a17; border-color: #1c3a33; }
  .field.totp .v { font-size: 26px; letter-spacing: 5px; color: #5eead4; }
  .field .ring { float: right; font: 600 11px/1 ui-monospace, monospace; color: #5eead4; opacity: .8; }
</style>
</head>
<body>
<header>
  <span class="dot"></span>
  <h1>VEO · OTPs de prueba</h1>
  <span class="badge">solo desarrollo</span>
  <span class="spacer"></span>
  <span id="status" class="badge">conectando…</span>
  <button id="clear">Limpiar</button>
</header>
<div class="wrap">
  <div id="admin"></div>
  <div id="root" class="empty">Esperando OTPs… generá uno en cualquier app.</div>
</div>
<script>
  const root = document.getElementById('root');
  const statusEl = document.getElementById('status');
  document.getElementById('clear').onclick = async () => { await fetch('/api/clear', {method:'POST'}); load(); };

  function timeAgo(ts, now) {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return 'hace ' + s + 's';
    const m = Math.floor(s / 60); if (m < 60) return 'hace ' + m + 'm';
    return new Date(ts).toLocaleTimeString('es-PE');
  }
  function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  async function load() {
    let data;
    try { data = await (await fetch('/api/otps')).json(); statusEl.textContent = 'en vivo'; }
    catch { statusEl.textContent = 'sin conexión'; return; }
    const { entries, now, admin } = data;
    if (admin) {
      const adminEl = document.getElementById('admin');
      adminEl.innerHTML = \`
        <div class="admin-card">
          <div class="hd">Panel Admin (admin-web) <span class="tag">solo dev</span></div>
          <div class="admin-grid">
            <div class="field" onclick="navigator.clipboard.writeText('\${esc(admin.email)}')">
              <div class="k">correo</div><div class="v">\${esc(admin.email)}</div></div>
            <div class="field" onclick="navigator.clipboard.writeText('\${esc(admin.password)}')">
              <div class="k">password</div><div class="v">\${esc(admin.password)}</div></div>
            <div class="field totp" onclick="navigator.clipboard.writeText('\${esc(admin.totp)}')">
              <div class="k">código TOTP <span class="ring">\${admin.secondsLeft}s</span></div>
              <div class="v">\${esc(admin.totp)}</div></div>
          </div>
        </div>\`;
    }
    if (!entries.length) { root.className = 'empty'; root.textContent = 'Esperando OTPs… generá uno en cualquier app.'; return; }
    root.className = '';
    const groups = {};
    for (const e of entries) (groups[e.service] ??= []).push(e);
    root.innerHTML = Object.entries(groups).map(([service, list]) => \`
      <div class="group">
        <h2>\${esc(service)} <span class="n">\${list.length}</span></h2>
        \${list.map(e => \`
          <div class="card \${(now - e.at) < 8000 ? 'fresh' : ''}">
            <div class="code \${e.code ? '' : 'none'}" title="click para copiar"
                 onclick="navigator.clipboard.writeText('\${esc(e.code ?? '')}')">\${e.code ? esc(e.code) : 's/código'}</div>
            <div class="meta">
              <div class="to">\${esc(e.to || '—')} <span class="pill \${esc(e.channel)}">\${esc(e.channel)}</span></div>
              <div class="msg">\${esc(e.message)}</div>
            </div>
            <div class="time">\${timeAgo(e.at, now)}</div>
          </div>\`).join('')}
      </div>\`).join('');
  }
  load();
  setInterval(load, 2000);
</script>
</body>
</html>`;
