/**
 * Verificación e2e del LOTE 3: el cash domino CIERRA cuando el conductor confirma el cobro.
 * Reproduce el bug (driver completaba sin cashCollected → CASH PENDING eterno) y confirma el fix:
 * el driver app ahora envía cashCollected=true → driverConfirmed; con el passenger confirmado, captura.
 *
 * Flujo: passenger+driver login → viaje CASH bid → driver acepta → passenger acepta → ASSIGNED →
 *   driver FSM arriving→arrived→start (IN_PROGRESS) → driver complete {cashCollected:true} →
 *   passenger confirma efectivo → GET /payments/by-trip → debe ser CAPTURED.
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
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const json = (t) => ({ 'Content-Type': 'application/json', ...auth(t) });

function lastOtp(phone) {
  const log = readFileSync(IDENTITY_LOG, 'utf8');
  const esc = phone.replace(/[+]/g, '\\+');
  const all = [...log.matchAll(new RegExp(`SANDBOX SMS\\] → ${esc}: Tu código VEO es (\\d{6})`, 'g'))];
  return all[all.length - 1][1];
}

async function login(base, phone, type) {
  await fetch(`${base}/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(type ? { phone, type } : { phone }) });
  await sleep(1500);
  const code = lastOtp(phone);
  const res = await fetch(`${base}/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(type ? { phone, code, type } : { phone, code }) });
  return (await res.json()).accessToken;
}

async function main() {
  const ptoken = await login(PUB, PHONE, 'PASSENGER');
  const dtoken = await login(DRV, DRIVER_PHONE);
  console.log('[verify] passenger + driver login OK');

  // Limpiar viaje activo previo.
  const act = await (await fetch(`${PUB}/trips/active`, { headers: auth(ptoken) })).json().catch(() => null);
  const actId = act?.id ?? act?.trip?.id;
  if (actId) {
    await fetch(`${PUB}/trips/${actId}/cancel`, { method: 'POST', headers: json(ptoken), body: '{}' });
    await sleep(1500);
  }

  // Crear viaje CASH + match.
  const trip = await (await fetch(`${PUB}/trips`, {
    method: 'POST', headers: { ...json(ptoken), 'idempotency-key': `l3-${Date.now()}` },
    body: JSON.stringify({ origin: { lat: -11.8975, lon: -77.026 }, destination: { lat: -12.0464, lon: -77.0428 }, paymentMethod: 'CASH', category: 'veo_economico', bidCents: BID_CENTS }),
  })).json();
  if (!trip.id) { console.log('[verify] FALLÓ crear viaje:', JSON.stringify(trip)); process.exit(1); }
  console.log(`[verify] viaje CASH ${trip.id} ${trip.status}`);

  await sleep(2000);
  await fetch(`${DRV}/bids/${trip.id}/offer`, { method: 'POST', headers: json(dtoken), body: JSON.stringify({ kind: 'ACCEPT_PRICE', priceCents: BID_CENTS }) });
  let driverId = null;
  for (let i = 0; i < 15 && !driverId; i++) {
    await sleep(1000);
    const o = await (await fetch(`${PUB}/trips/${trip.id}/offers`, { headers: auth(ptoken) })).json();
    if (o.offers?.length) driverId = o.offers[0].driverId;
  }
  if (!driverId) { console.log('[verify] FALLÓ: sin oferta'); process.exit(1); }
  await fetch(`${PUB}/trips/${trip.id}/offers/${driverId}/accept`, { method: 'POST', headers: json(ptoken), body: '{}' });
  console.log('[verify] ASSIGNED');

  // Driver FSM hasta IN_PROGRESS. accept (ASSIGNED→ACCEPTED) PRIMERO: en la app lo hace
  // useEnsureTripAccepted al abrir la pantalla; sin él, arriving da 409.
  await sleep(1000);
  for (const step of ['accept', 'arriving', 'arrived', 'start']) {
    const r = await fetch(`${DRV}/trips/${trip.id}/${step}`, { method: 'POST', headers: json(dtoken), body: '{}' });
    console.log(`[verify] driver ${step}: ${r.status}`);
    await sleep(800);
  }

  // EL FIX: el driver completa declarando que cobró el efectivo (lo que ahora hace el sheet de la app).
  const completeRes = await fetch(`${DRV}/trips/${trip.id}/complete`, { method: 'POST', headers: json(dtoken), body: JSON.stringify({ cashCollected: true }) });
  const completeBody = await completeRes.json();
  console.log(`[verify] driver complete {cashCollected:true}: ${completeRes.status} status=${completeBody.status}`);
  await sleep(2000);

  // Estado del pago tras la confirmación del conductor (driverConfirmed). Falta el pasajero.
  let pay = await (await fetch(`${PUB}/payments/by-trip/${trip.id}`, { headers: auth(ptoken) })).json();
  console.log(`[verify] pago tras driver-confirm: status=${pay.status} (espera confirmación del pasajero)`);

  // El pasajero confirma su lado → ambos confirmados → captureCash.
  const confirmRes = await fetch(`${PUB}/payments/${pay.id}/cash/confirm`, { method: 'POST', headers: json(ptoken), body: '{}' });
  console.log(`[verify] passenger cash/confirm: ${confirmRes.status}`);
  await sleep(2000);

  pay = await (await fetch(`${PUB}/payments/by-trip/${trip.id}`, { headers: auth(ptoken) })).json();
  console.log(`[verify] pago final: status=${pay.status}`);

  console.log('');
  if (pay.status === 'CAPTURED') {
    console.log('[verify] ✅✅ LOTE 3 OK: cash domino cerró — driver cobró + passenger confirmó → CAPTURED.');
    process.exit(0);
  } else {
    console.log(`[verify] ❌ LOTE 3 FALLA: el pago quedó en ${pay.status}, no CAPTURED.`);
    process.exit(2);
  }
}

main().catch((e) => { console.error('[verify] error:', e.message); process.exit(3); });
