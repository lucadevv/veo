/**
 * Publicador de GPS de DESARROLLO para el conductor (uso: probar en simulador iOS, donde el
 * GPS nativo de la app no emite — gap conocido de TSLocationManager con ubicación simulada).
 *
 * Hace exactamente lo que hace la app del conductor:
 *   1. Login OTP (sandbox: lee el código del log del identity-service),
 *   2. conecta el socket /driver del driver-bff con Bearer,
 *   3. publica `location` cada 4s (→ driver.location_updated → hot index del dispatch).
 *
 * Uso:  node e2e/scripts/dev-driver-gps.mjs [+51900000001] [lat] [lon] [CAR|MOTO]
 * Parar: Ctrl+C (o matar el proceso).
 */
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY_LOG = resolve(HERE, '..', '.logs', 'identity-service.log');
const BFF = 'http://localhost:4002/api/v1';
const SOCKET_URL = 'http://localhost:4002/driver';

const phone = process.argv[2] ?? '+51900000001';
const lat = Number(process.argv[3] ?? -11.8975);
const lon = Number(process.argv[4] ?? -77.026);
const vehicleType = process.argv[5] ?? 'CAR';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const reqRes = await fetch(`${BFF}/auth/otp/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  if (!reqRes.ok) throw new Error(`otp/request ${reqRes.status}`);
  await sleep(1500);
  const log = readFileSync(IDENTITY_LOG, 'utf8');
  const matches = [...log.matchAll(/SANDBOX SMS\].*?código VEO es (\d{6})/g)];
  if (matches.length === 0) throw new Error('no encontré el código OTP en el log');
  const code = matches[matches.length - 1][1];
  const verRes = await fetch(`${BFF}/auth/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
  if (!verRes.ok) throw new Error(`otp/verify ${verRes.status}`);
  const tokens = await verRes.json();
  console.log(`[gps] login OK driver user=${tokens.user.id}`);
  return tokens.accessToken;
}

async function run() {
  const token = await login();
  const socket = io(SOCKET_URL, {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
  });

  await new Promise((resolveConn, rejectConn) => {
    const timer = setTimeout(() => rejectConn(new Error('timeout socket /driver')), 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolveConn();
    });
    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      rejectConn(new Error(`connect_error: ${e.message}`));
    });
  });
  console.log(`[gps] socket /driver conectado — publicando ${vehicleType} en ${lat},${lon} cada 4s`);

  let n = 0;
  while (socket.connected) {
    // Jitter mínimo (~20m) para que la muestra sea "viva" sin salir de la celda H3.
    const report = {
      lat: lat + (n % 5) * 0.0001,
      lon: lon + (n % 3) * 0.0001,
      heading: 90,
      speed: 5,
      accuracy: 10,
      ts: new Date().toISOString(),
      vehicleType,
    };
    socket.emit('location', report, () => undefined);
    n += 1;
    if (n % 15 === 0) console.log(`[gps] ${n} reportes publicados`);
    await sleep(4000);
  }
  console.log('[gps] socket desconectado');
}

// Reintenta indefinidamente: si el BFF se reinicia o el token expira, re-login + reconexión.
for (;;) {
  try {
    await run();
  } catch (e) {
    console.error(`[gps] error: ${e.message} — reintento en 5s`);
  }
  await sleep(5000);
}
