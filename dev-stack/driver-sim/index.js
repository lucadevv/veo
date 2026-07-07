#!/usr/bin/env node
/**
 * driver-sim · CLI de simulación de conductor VEO por ETAPAS, contra el dev-stack VIVO.
 *
 * Las recetas (HTTP/Redis/SQL/socket) están copiadas 1:1 del harness e2e del golden path:
 *   - e2e/lib/fixtures.ts       → injectOtp (OTP en Redis), approveDriverByUserId (SQL identity)
 *   - e2e/lib/driver-socket.ts  → socket /driver (location + dispatch:offer/dispatch:match)
 *   - e2e/lib/http.ts           → cliente BFF (prefijo /api/v1, Bearer)
 *   - e2e/lib/config.ts         → URLs/puertos (driver-bff 4002, Redis 6379, pg veo-postgres)
 *   - e2e/golden-path/golden-path.e2e.spec.ts → orden exacto de onboarding/turno/FSM
 *   - services/bff/driver-bff/src/dispatch/bids.controller.ts → GET /bids, POST /bids/:tripId/offer
 *
 * Etapas (cada una es una invocación separada; el estado vive en .state.json):
 *   node driver-sim ready --lat <LAT> --lon <LON>       # login+onboarding+turno; queda VIVO publicando GPS
 *   node driver-sim offer [--price <SOLES>]             # oferta a la puja abierta (o accept de oferta FIXED)
 *   node driver-sim fsm <accept|arriving|arrived|start|complete>
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Redis } from 'ioredis';
import { io } from 'socket.io-client';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(HERE, '.state.json');

// ── Config (misma que e2e/lib/config.ts; overridable por env) ──
const DRIVER_BFF = process.env.DRIVER_SIM_BFF_URL ?? 'http://localhost:4002';
const REDIS_URL = process.env.DRIVER_SIM_REDIS_URL ?? 'redis://localhost:6379';
const PG_CONTAINER = process.env.DRIVER_SIM_PG_CONTAINER ?? 'veo-postgres';
const SIM_PHONE = process.env.DRIVER_SIM_PHONE ?? '999000222'; // teléfono FIJO del conductor sim
const OTP_CODE = '424242';
const LOCATION_INTERVAL_MS = 3000;

// ── Logging (tuteo, sin emojis) ──
const ts = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[driver-sim ${ts()}] ${msg}`);
const warn = (msg) => console.warn(`[driver-sim ${ts()}] AVISO: ${msg}`);
function fatal(msg) {
  console.error(`[driver-sim ${ts()}] ERROR: ${msg}`);
  process.exit(1);
}

// ── Estado persistente (.state.json): merge sobre lectura fresca para convivir con el proceso `ready` ──
function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(patch) {
  const merged = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(STATE_FILE, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

// ── Cliente HTTP del BFF (receta de e2e/lib/http.ts: prefijo /api/v1 + Bearer) ──
async function api(method, path, { token, body, headers } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(`${DRIVER_BFF}/api/v1${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const bodyText = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    const err = new Error(`${method} ${path} → ${res.status}: ${bodyText}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

/** Si el BFF devuelve 401, el access token (15m) venció: hay que re-correr `ready`. */
function explainAuthError(err) {
  if (err?.status === 401) {
    return `${err.message}\n  → token vencido o inválido (access dura 15m): corré \`node driver-sim ready --lat .. --lon ..\` de nuevo.`;
  }
  return err?.message ?? String(err);
}

// ── Fixtures (copiadas de e2e/lib/fixtures.ts) ──

/** Normaliza al formato canónico peruPhoneSchema: últimos 9 dígitos con prefijo +51. */
function normalizePeruPhone(raw) {
  const digits = raw.replace(/\D/g, '');
  return `+51${digits.slice(-9)}`;
}

/**
 * Inyecta el OTP en Redis con el MISMO formato que OtpService (equivale a "leer el SMS"):
 *   key veo:otp:<phone> · value {hash: sha256(code), attempts: 0, issuedAt} · TTL 300s
 */
async function injectOtp(phone, code) {
  const redis = new Redis(REDIS_URL);
  try {
    const hash = createHash('sha256').update(code).digest('hex');
    const record = JSON.stringify({ hash, attempts: 0, issuedAt: Date.now() });
    await redis.set(`veo:otp:${normalizePeruPhone(phone)}`, record, 'EX', 300);
  } finally {
    redis.disconnect();
  }
}

/** Aprueba al conductor en la DB de identity (seed de back-office, vía docker exec psql). */
async function approveDriverByUserId(userId) {
  const sql = [
    `UPDATE identity.drivers SET background_check_status='CLEARED' WHERE user_id='${userId}';`,
    `UPDATE identity.users SET kyc_status='VERIFIED' WHERE id='${userId}';`,
    `SELECT count(*) FROM identity.drivers WHERE user_id='${userId}' AND background_check_status='CLEARED';`,
  ].join(' ');
  const { stdout } = await execFileAsync('docker', [
    'exec',
    PG_CONTAINER,
    'psql',
    '-U',
    'veo',
    '-d',
    'veo',
    '-tAc',
    sql,
  ]);
  return stdout.trim().endsWith('1');
}

/**
 * Fallback biométrico para stacks con VEO_BIOMETRIC_MODE=live (ONNX real, imposible de pasar con
 * frames sintéticos): la MISMA receta SQL del seed oficial del dev-stack (seed-dev-driver.sql),
 * que enrola y deja AVAILABLE por DB "para simular el flujo de viaje sin la driver-app".
 */
async function seedShiftAvailableByUserId(userId) {
  const sql = [
    `UPDATE identity.drivers SET face_embedding='{}', current_status='AVAILABLE',`,
    `last_verified_at=now(), suspended_at=NULL WHERE user_id='${userId}';`,
    `SELECT count(*) FROM identity.drivers WHERE user_id='${userId}' AND current_status='AVAILABLE';`,
  ].join(' ');
  const { stdout } = await execFileAsync('docker', [
    'exec',
    PG_CONTAINER,
    'psql',
    '-U',
    'veo',
    '-d',
    'veo',
    '-tAc',
    sql,
  ]);
  return stdout.trim().endsWith('1');
}

/** Paso tolerante a re-corridas (onboard/enroll/vehículo ya hechos en corridas previas). */
async function tryStep(label, fn) {
  try {
    const out = await fn();
    log(`${label}: OK`);
    return out;
  } catch (err) {
    warn(
      `${label} falló (${err.status ?? '?'}): ${err.message} — sigo (probablemente ya estaba hecho)`,
    );
    return undefined;
  }
}

// ═══════════════════════ etapa 1 · ready ═══════════════════════

async function cmdReady(latRaw, lonRaw) {
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    fatal('pasame --lat y --lon numéricos (ej: --lat -12.121 --lon -77.03)');
  }

  // 1. Login OTP (mismo flujo que golden path paso 2: request → inyectar OTP en Redis → verify).
  log(`login OTP del conductor sim (${SIM_PHONE}) contra ${DRIVER_BFF}`);
  await api('POST', '/auth/otp/request', { body: { phone: SIM_PHONE, type: 'DRIVER' } });
  await injectOtp(SIM_PHONE, OTP_CODE);
  const tokens = await api('POST', '/auth/otp/verify', {
    body: { phone: SIM_PHONE, code: OTP_CODE, type: 'DRIVER' },
  });
  const token = tokens.accessToken;
  const userId = tokens.user.id;
  log(`login OK · userId ${userId} · kyc ${tokens.user.kycStatus}`);
  saveState({ phone: SIM_PHONE, userId, accessToken: token, refreshToken: tokens.refreshToken });

  // 2. Onboarding de licencia (tolerante: en re-corridas ya existe).
  await tryStep('onboard licencia', () =>
    api('POST', '/drivers/onboard', {
      token,
      body: {
        licenseNumber: 'A1-SIM001',
        licenseExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      },
    }),
  );

  // 3. Aprobación por SQL en identity (seed de back-office del golden path).
  const approved = await approveDriverByUserId(userId);
  if (!approved) fatal(`no pude aprobar al conductor en la DB de identity (userId ${userId})`);
  log('conductor aprobado en identity (background CLEARED + kyc VERIFIED)');

  // 4. Vehículo CAR (tolerante: la placa fija ya puede estar registrada). Antes del turno, para que
  // el driver-bff selle CAR (server-authoritative) en el ping de ubicación.
  await tryStep('registro de vehículo CAR', () =>
    api('POST', '/drivers/vehicles', {
      token,
      body: { vehicleType: 'CAR', plate: 'SIM-001', make: 'Toyota', model: 'Yaris', year: 2021 },
    }),
  );

  // 5. Gate biométrico + inicio de turno. Primero el camino HTTP del golden path (funciona con
  // VEO_BIOMETRIC_MODE=sandbox: enroll → challenge → verify → shift/start). Si el stack corre
  // biometría LIVE (ONNX real, dev-stack actual), ese camino es imposible con frames sintéticos:
  // caemos a la receta SQL del seed oficial (seed-dev-driver.sql) que deja AVAILABLE por DB.
  let shiftViaHttp = false;
  try {
    // identity endureció el borde: `photo` debe ser base64 VÁLIDO ≥2000 chars (FRAME_BASE64_MIN).
    // Selfie sintética DETERMINISTA (en sandbox el embedding sale del hash de la foto).
    const simSelfieB64 = Buffer.from('veo-driver-sim-selfie-ref-'.repeat(80)).toString('base64');
    await api('POST', '/drivers/biometric/enroll', { token, body: { photo: simSelfieB64 } });
    const challenge = await api('POST', '/drivers/shift/biometric/challenge', { token, body: {} });
    const verify = await api('POST', '/drivers/shift/biometric/verify', {
      token,
      body: { challengeId: challenge.challengeId, frames: ['f1', 'f2', 'f3'] },
    });
    log(`gate biométrico sandbox OK · sessionRef ${verify.sessionRef}`);
    await api('POST', '/drivers/shift/start', {
      token,
      body: { sessionRef: verify.sessionRef, geoLat: lat, geoLon: lon },
    });
    shiftViaHttp = true;
  } catch (err) {
    warn(`gate biométrico HTTP no pasó (${err.status ?? '?'}): ${err.message}`);
    log('caigo a la receta del seed oficial del dev-stack (SQL: enrol + AVAILABLE por DB)');
    const seeded = await seedShiftAvailableByUserId(userId);
    if (!seeded) fatal(`el seed SQL de turno tampoco anduvo (userId ${userId})`);
  }

  const shiftState = await api('GET', '/drivers/shift/state', { token });
  if (shiftState.status !== 'AVAILABLE') {
    fatal(`el turno NO quedó AVAILABLE (estado actual: ${JSON.stringify(shiftState)})`);
  }
  log(`turno iniciado (${shiftViaHttp ? 'HTTP golden path' : 'seed SQL'}): shift AVAILABLE`);
  saveState({ shiftStatus: 'AVAILABLE', lat, lon });

  // 7. Socket /driver (receta de e2e/lib/driver-socket.ts) + publicación de ubicación cada 3s.
  const socket = io(`${DRIVER_BFF}/driver`, {
    transports: ['websocket'],
    auth: { token },
    reconnection: true,
  });

  const publishLocation = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout ack location')), 5000);
      socket.emit(
        'location',
        {
          lat,
          lon,
          heading: 0,
          speed: 0,
          accuracy: 5,
          ts: new Date().toISOString(),
          vehicleType: 'CAR',
        },
        (ack) => {
          clearTimeout(timer);
          resolve(ack);
        },
      );
    });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout conectando /driver socket')), 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`connect_error /driver: ${err.message}`));
    });
  });
  log('socket /driver conectado');

  // Eventos que le interesan al sim: oferta directa (FIXED), match (cierre de puja) y updates del viaje.
  socket.on('dispatch:offer', (envelope) => {
    const offer = envelope?.payload;
    if (!offer) return;
    log(`OFERTA por socket (dispatch:offer): ${JSON.stringify(offer)}`);
    saveState({
      lastOffer: { ...offer, receivedAt: new Date().toISOString(), consumed: false },
      tripId: offer.tripId,
      driverId: offer.driverId,
    });
    log(`→ guardé tripId/matchId en .state.json; corré \`node driver-sim offer\` para aceptarla`);
  });
  socket.on('dispatch:match', (envelope) => {
    const match = envelope?.payload;
    if (!match) return;
    log(`MATCH confirmado (dispatch:match): ${JSON.stringify(match)}`);
    saveState({ match, tripId: match.tripId ?? loadState().tripId, driverId: match.driverId });
    log('→ el viaje va a quedar ASSIGNED; seguí con `node driver-sim fsm accept`');
  });
  socket.on('bid:closed', (envelope) => {
    log(`puja cerrada sin vos (bid:closed): ${JSON.stringify(envelope?.payload ?? envelope)}`);
  });
  socket.on('trip:update', (envelope) => {
    log(`trip:update ${envelope?.eventType ?? ''}: ${JSON.stringify(envelope?.payload ?? {})}`);
  });
  socket.on('payment:tip', (envelope) => {
    log(`propina en vivo (payment:tip): ${JSON.stringify(envelope?.payload ?? {})}`);
  });
  socket.on('disconnect', (reason) =>
    warn(`socket desconectado (${reason}) — reintento automático`),
  );

  // Primer ack con poll (el handshake resuelve el driverId async DESPUÉS de `connect`; el primer
  // `location` puede caer en 'unauthenticated' — misma receta que el golden path paso 3).
  const deadline = Date.now() + 10_000;
  let firstAck;
  for (;;) {
    firstAck = await publishLocation().catch((err) => ({ ok: false, error: err.message }));
    if (firstAck.ok || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!firstAck.ok) fatal(`el socket no acepta location: ${firstAck.error ?? 'sin detalle'}`);

  log(
    `AVAILABLE y publicando en ${lat},${lon} cada ${LOCATION_INTERVAL_MS / 1000}s — Ctrl-C para cortar`,
  );
  let published = 1;
  const interval = setInterval(async () => {
    const ack = await publishLocation().catch((err) => ({ ok: false, error: err.message }));
    if (ack.ok) {
      published += 1;
      if (published % 10 === 0) log(`ubicación publicada x${published} (último ack OK)`);
    } else {
      warn(`ack de location falló: ${ack.error ?? 'sin detalle'}`);
    }
  }, LOCATION_INTERVAL_MS);

  process.on('SIGINT', () => {
    clearInterval(interval);
    socket.disconnect();
    log(`corto: publiqué ${published} ubicaciones. El token queda en .state.json para offer/fsm.`);
    process.exit(0);
  });
}

// ═══════════════════════ etapa 2 · offer ═══════════════════════

async function cmdOffer(priceRaw) {
  const st = loadState();
  if (!st.accessToken)
    fatal('no hay sesión en .state.json — corré primero `node driver-sim ready`');
  const token = st.accessToken;

  // Camino FIXED: llegó una oferta directa por el socket (dispatch:offer) → se acepta como el golden
  // path paso 4: POST /dispatch/offers/:matchId/accept (dispatch.controller.ts del driver-bff).
  if (st.lastOffer && !st.lastOffer.consumed) {
    log(
      `hay una oferta directa pendiente (FIXED) · trip ${st.lastOffer.tripId} · match ${st.lastOffer.matchId} — la acepto`,
    );
    await api('POST', `/dispatch/offers/${st.lastOffer.matchId}/accept`, { token });
    saveState({
      tripId: st.lastOffer.tripId,
      matchId: st.lastOffer.matchId,
      lastOffer: { ...st.lastOffer, consumed: true },
    });
    log(
      `oferta aceptada · tripId ${st.lastOffer.tripId} guardado. Seguí con \`node driver-sim fsm accept\``,
    );
    return;
  }

  // Camino PUJA: listar pujas OPEN cercanas (GET /bids) y ofertar (POST /bids/:tripId/offer),
  // exactamente como la app del conductor (bids.controller.ts + http-bidding-repository.ts).
  const bids = await api('GET', '/bids', { token });
  if (!Array.isArray(bids) || bids.length === 0) {
    fatal(
      'no hay pujas abiertas (GET /bids devolvió vacío) ni oferta FIXED pendiente en .state.json.\n' +
        '  → ¿el pasajero ya pidió el viaje? ¿el proceso `ready` sigue vivo publicando cerca del pickup?',
    );
  }
  const bid = bids[0];
  log(
    `puja abierta: trip ${bid.tripId} · el pasajero ofrece S/ ${(bid.bidCents / 100).toFixed(2)} · ` +
      `pickup ${bid.originLat},${bid.originLon} · vence ${new Date(bid.expiresAt).toISOString()}`,
  );

  const priceCents = priceRaw !== undefined ? Math.round(Number(priceRaw) * 100) : bid.bidCents;
  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    fatal(`precio inválido: --price ${priceRaw} (esperaba soles, ej: --price 12.50)`);
  }
  // ACCEPT_PRICE debe IGUALAR el bid; COUNTER debe superarlo (reglas en dispatch downstream).
  const kind = priceCents === bid.bidCents ? 'ACCEPT_PRICE' : 'COUNTER';
  const view = await api('POST', `/bids/${bid.tripId}/offer`, {
    token,
    body: { kind, priceCents },
  });
  saveState({ tripId: bid.tripId, driverId: view.driverId, submittedOffer: view });
  log(
    `oferta enviada (${kind} S/ ${(priceCents / 100).toFixed(2)}) → status ${view.status} · ` +
      `tripId ${bid.tripId} guardado en .state.json`,
  );
  if (kind === 'COUNTER') {
    log(
      'ahora el pasajero elige: mirá el proceso `ready` (loguea dispatch:match / trip:update cuando te elijan)',
    );
  } else {
    log(
      'aceptaste el precio del pasajero: mirá el proceso `ready` para el match y seguí con `fsm accept`',
    );
  }
}

// ═══════════════════════ etapa 3 · fsm ═══════════════════════

/** Rutas EXACTAS del golden path paso 5 (driver-bff → trip-service). */
const FSM_STAGES = {
  accept: { body: { etaSeconds: 120 }, expect: 'ACCEPTED' },
  arriving: { body: { etaSeconds: 60 }, expect: 'ARRIVING' },
  arrived: { body: {}, expect: 'ARRIVED' },
  start: { body: {}, expect: 'IN_PROGRESS' },
  complete: { body: { cashCollected: true }, expect: 'COMPLETED' },
};

async function cmdFsm(stage, tripFlag) {
  const spec = FSM_STAGES[stage];
  if (!spec)
    fatal(`etapa desconocida: "${stage}". Usá una de: ${Object.keys(FSM_STAGES).join('|')}`);

  const st = loadState();
  if (!st.accessToken)
    fatal('no hay sesión en .state.json — corré primero `node driver-sim ready`');
  const token = st.accessToken;

  let tripId = tripFlag ?? st.tripId;
  if (!tripId) {
    // Rehidratación (regla #4 del dominio): con un viaje VIVO, GET /trips/active lo devuelve sin id.
    const active = await api('GET', '/trips/active', { token });
    tripId = active?.id;
  }
  if (!tripId)
    fatal('no tengo tripId: ni en .state.json, ni --trip, ni viaje activo en /trips/active');

  log(`transiciono trip ${tripId}: ${stage} → espero ${spec.expect}`);
  await api('POST', `/trips/${tripId}/${stage}`, { token, body: spec.body });

  // Poll del estado (la materialización es async, igual que expectState del golden path).
  const deadline = Date.now() + 15_000;
  for (;;) {
    const view = await api('GET', `/trips/${tripId}/state`, { token });
    if (view.status === spec.expect) {
      log(`listo: trip ${tripId} → ${view.status}`);
      saveState({ tripId, tripStatus: view.status });
      return;
    }
    if (Date.now() > deadline) {
      fatal(`el viaje no llegó a ${spec.expect} en 15s (último estado: ${view.status})`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

// ═══════════════════════ main ═══════════════════════

const USAGE = `driver-sim · simulador de conductor VEO por etapas (dev-stack vivo)

  node driver-sim ready --lat <LAT> --lon <LON>    login+onboarding+turno AVAILABLE; queda vivo publicando GPS (Ctrl-C corta)
  node driver-sim offer [--price <SOLES>]          oferta a la puja abierta (sin --price acepta el precio del pasajero);
                                                   si hay oferta FIXED pendiente del socket, la acepta
  node driver-sim fsm <accept|arriving|arrived|start|complete> [--trip <ID>]

Estado (tokens, tripId, matchId) en ${STATE_FILE}
Env opcional: DRIVER_SIM_BFF_URL, DRIVER_SIM_REDIS_URL, DRIVER_SIM_PG_CONTAINER, DRIVER_SIM_PHONE`;

/** Parser propio: node:util.parseArgs rechaza valores negativos (--lat -12.121) y acá son la norma. */
function parseCli(argv) {
  const positionals = [];
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) values[arg.slice(2, eq)] = arg.slice(eq + 1);
      else values[arg.slice(2)] = argv[(i += 1)];
    } else {
      positionals.push(arg);
    }
  }
  return { values, positionals };
}

async function main() {
  const { values, positionals } = parseCli(process.argv.slice(2));
  const [command, subarg] = positionals;

  switch (command) {
    case 'ready':
      return cmdReady(values.lat, values.lon);
    case 'offer':
      return cmdOffer(values.price);
    case 'fsm':
      return cmdFsm(subarg, values.trip);
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  fatal(explainAuthError(err));
});
