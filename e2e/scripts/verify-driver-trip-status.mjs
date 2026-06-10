/**
 * Verificación e2e del LOTE 2: el driver-bff normaliza el status del dominio al contrato mobile.
 * Reproduce el bug (CANCELLED_BY_PASSENGER crudo → la app cae a UNKNOWN) y confirma el fix.
 *
 * Flujo: passenger+driver login → viaje bid → driver acepta → ASSIGNED →
 *   el PASAJERO cancela (genera CANCELLED_BY_PASSENGER en el dominio) →
 *   GET /trips/:id y /trips/:id/state desde el DRIVER-BFF → debe ser 'CANCELLED', no crudo ni 5xx.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IDENTITY_LOG = resolve(HERE, '..', '.logs', 'identity-service.log');
const PUB = 'http://localhost:4001/api/v1';
const DRV = 'http://localhost:4002/api/v1';
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
  return (await res.json()).accessToken;
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function main() {
  const ptoken = await login(PUB, PHONE, 'PASSENGER');
  const dtoken = await login(DRV, DRIVER_PHONE);
  console.log('[verify] passenger + driver login OK');

  // Limpiar viaje activo previo.
  const act = await (await fetch(`${PUB}/trips/active`, { headers: auth(ptoken) })).json().catch(() => null);
  const actId = act?.id ?? act?.trip?.id;
  if (actId) {
    await fetch(`${PUB}/trips/${actId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(ptoken) }, body: '{}' });
    await sleep(1500);
  }

  // Crear viaje + driver acepta puja + passenger acepta oferta → ASSIGNED.
  const trip = await (await fetch(`${PUB}/trips`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'idempotency-key': `l2-${Date.now()}`, ...auth(ptoken) },
    body: JSON.stringify({ origin: { lat: -11.8975, lon: -77.026 }, destination: { lat: -12.0464, lon: -77.0428 }, paymentMethod: 'CASH', category: 'veo_economico', bidCents: BID_CENTS }),
  })).json();
  if (!trip.id) { console.log('[verify] FALLÓ crear viaje:', JSON.stringify(trip)); process.exit(1); }
  console.log(`[verify] viaje ${trip.id} ${trip.status}`);

  await sleep(2000);
  await fetch(`${DRV}/bids/${trip.id}/offer`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(dtoken) }, body: JSON.stringify({ kind: 'ACCEPT_PRICE', priceCents: BID_CENTS }) });
  let driverId = null;
  for (let i = 0; i < 15 && !driverId; i++) {
    await sleep(1000);
    const o = await (await fetch(`${PUB}/trips/${trip.id}/offers`, { headers: auth(ptoken) })).json();
    if (o.offers?.length) driverId = o.offers[0].driverId;
  }
  if (!driverId) { console.log('[verify] FALLÓ: sin oferta'); process.exit(1); }
  await fetch(`${PUB}/trips/${trip.id}/offers/${driverId}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(ptoken) }, body: '{}' });
  console.log('[verify] viaje ASSIGNED');

  // El PASAJERO cancela → dominio escribe CANCELLED_BY_PASSENGER.
  await sleep(1500);
  const cancelRes = await fetch(`${PUB}/trips/${trip.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(ptoken) }, body: '{}' });
  console.log(`[verify] passenger canceló: ${cancelRes.status}`);
  await sleep(2000);

  // Verdad cruda del dominio (DB) — debe ser CANCELLED_BY_PASSENGER.
  // El DRIVER-BFF debe normalizarlo a CANCELLED (no crudo, no 5xx).
  const tripView = await fetch(`${DRV}/trips/${trip.id}`, { headers: auth(dtoken) });
  const tripBody = await tripView.json();
  const stateView = await fetch(`${DRV}/trips/${trip.id}/state`, { headers: auth(dtoken) });
  const stateBody = await stateView.json();

  console.log(`[verify] GET /trips/:id        → ${tripView.status} status=${tripBody.status}`);
  console.log(`[verify] GET /trips/:id/state  → ${stateView.status} status=${stateBody.status}`);

  const ok = tripView.status === 200 && tripBody.status === 'CANCELLED'
    && stateView.status === 200 && stateBody.status === 'CANCELLED';
  console.log('');
  if (ok) {
    console.log('[verify] ✅✅ LOTE 2 OK: driver-bff devuelve CANCELLED normalizado (200, no crudo, no 5xx).');
    process.exit(0);
  } else {
    console.log('[verify] ❌ LOTE 2 FALLA: el driver-bff no normalizó el status.');
    process.exit(2);
  }
}

main().catch((e) => { console.error('[verify] error:', e.message); process.exit(3); });
