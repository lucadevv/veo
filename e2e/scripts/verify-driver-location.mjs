/**
 * Verificación e2e del LOTE 1: el pasajero recibe `driver:location` SIN familiar conectado.
 * Reproduce el bug original (gate isActive=/family) y confirma el fix.
 *
 * Flujo: login passenger → crea viaje con bid → driver (GPS publisher ya corriendo) acepta vía API →
 * conecta socket /passenger, se suscribe al viaje → escucha driver:location 12s → reporta.
 */
import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY_LOG = resolve(HERE, '..', '.logs', 'identity-service.log');
const PUB = 'http://localhost:4001/api/v1';
const DRV = 'http://localhost:4002/api/v1';
const PUB_SOCKET = 'http://localhost:4001/passenger';
const PHONE = '+51911111111';
const DRIVER_PHONE = '+51900000001';
const BID_CENTS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastOtp(phone) {
  const log = readFileSync(IDENTITY_LOG, 'utf8');
  const esc = phone.replace(/[+]/g, '\\+');
  const all = [...log.matchAll(new RegExp(`SANDBOX SMS\\] → ${esc}: Tu código VEO es (\\d{6})`, 'g'))];
  return all[all.length - 1][1];
}

async function login(base, phone, type) {
  await fetch(`${base}/auth/otp/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(type ? { phone, type } : { phone }),
  });
  await sleep(1500);
  const code = lastOtp(phone);
  const res = await fetch(`${base}/auth/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(type ? { phone, code, type } : { phone, code }),
  });
  const t = await res.json();
  return t.accessToken;
}

async function main() {
  const token = await login(PUB, PHONE, 'PASSENGER');
  console.log('[verify] passenger login OK');
  const dtoken = await login(DRV, DRIVER_PHONE);
  console.log('[verify] driver login OK');

  // Limpieza: si quedó un viaje activo de una corrida previa, cancelarlo (bloquea uno nuevo).
  const activeRes = await fetch(`${PUB}/trips/active`, { headers: { Authorization: `Bearer ${token}` } });
  if (activeRes.ok) {
    const active = await activeRes.json().catch(() => null);
    const activeId = active?.id ?? active?.trip?.id;
    if (activeId) {
      await fetch(`${PUB}/trips/${activeId}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}',
      });
      console.log(`[verify] viaje activo previo ${activeId} cancelado`);
      await sleep(1500);
    }
  }

  // Crear viaje con bid cerca del driver (Carabayllo).
  const tripRes = await fetch(`${PUB}/trips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'idempotency-key': `verify-${token.slice(-12)}` },
    body: JSON.stringify({ origin: { lat: -11.8975, lon: -77.026 }, destination: { lat: -12.0464, lon: -77.0428 }, paymentMethod: 'CASH', category: 'veo_economico', bidCents: 1500 }),
  });
  const trip = await tripRes.json();
  if (!trip.id) { console.log('[verify] FALLÓ crear viaje:', JSON.stringify(trip)); process.exit(1); }
  console.log(`[verify] viaje ${trip.id} status=${trip.status}`);

  // El driver responde la puja con ACCEPT_PRICE (lo que en la app hace el botón "Aceptar S/X").
  await sleep(2000); // dar tiempo a que el board difunda al driver
  const offerRes = await fetch(`${DRV}/bids/${trip.id}/offer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dtoken}` },
    body: JSON.stringify({ kind: 'ACCEPT_PRICE', priceCents: BID_CENTS }),
  });
  console.log(`[verify] driver ofertó ACCEPT_PRICE: ${offerRes.status}`);

  // El pasajero ve la oferta y la acepta.
  let driverId = null;
  for (let i = 0; i < 15 && !driverId; i++) {
    await sleep(1000);
    const oRes = await fetch(`${PUB}/trips/${trip.id}/offers`, { headers: { Authorization: `Bearer ${token}` } });
    const o = await oRes.json();
    if (o.offers?.length) driverId = o.offers[0].driverId;
  }
  if (!driverId) { console.log('[verify] FALLÓ: ninguna oferta visible en /offers en 15s'); process.exit(1); }
  await fetch(`${PUB}/trips/${trip.id}/offers/${driverId}/accept`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}',
  });
  console.log(`[verify] oferta aceptada, driver ${driverId} asignado`);

  // Conectar socket /passenger — SIN ningún familiar conectado (ese es el punto del test).
  // El handshake autentica y suscribe: auth.token (JWT passenger) + auth.tripId.
  const socket = io(PUB_SOCKET, { transports: ['websocket'], auth: { token, tripId: trip.id }, reconnection: false });
  let locationsReceived = 0;
  socket.on('driver:location', (msg) => {
    locationsReceived++;
    console.log(`[verify] ✅ driver:location #${locationsReceived} point=${JSON.stringify(msg.point)} heading=${msg.heading}`);
  });
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timeout socket')), 8000);
    socket.on('connect', () => { clearTimeout(timer); res(); });
    socket.on('connect_error', (e) => { clearTimeout(timer); rej(e); });
  });
  console.log('[verify] socket /passenger conectado y suscrito (SIN familiar). Escuchando driver:location…');

  await sleep(13000);
  socket.disconnect();

  console.log('');
  if (locationsReceived > 0) {
    console.log(`[verify] ✅✅ RESULTADO: el pasajero recibió ${locationsReceived} driver:location SIN familiar conectado. LOTE 1 OK.`);
    process.exit(0);
  } else {
    console.log('[verify] ❌ RESULTADO: 0 driver:location recibidos. El fix NO funciona o el viaje no quedó mapeado.');
    process.exit(2);
  }
}

main().catch((e) => { console.error('[verify] error:', e.message); process.exit(3); });
