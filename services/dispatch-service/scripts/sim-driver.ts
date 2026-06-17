/**
 * Simulador de CONDUCTOR para dev (sin driver-app). Actúa como el conductor seedeado "Carlos"
 * (dev-stack/seed-dev-driver.sql) para que el flujo de viaje del pasajero se complete de punta a punta:
 *
 *   1) Ubicación: publica `driver.location_updated` a Kafka cada 15s (entra al hot-index del dispatch
 *      cerca del pickup; TTL ~60s → re-ping).
 *   2) Oferta: poll `GET /bids/open` y por cada puja OPEN cercana hace `POST /bids/:tripId/offers`
 *      (ACCEPT_PRICE al bid del pasajero). La identidad interna se FIRMA con HMAC (driverId = Driver.id;
 *      la oferta lo deriva de @CurrentUser().driverId).
 *   3) Progresión: una vez que el pasajero acepta (dispatch asigna → trip ASSIGNED), el conductor
 *      avanza el viaje en trip-service: accept → arriving → arrived → start → complete (espaciado para
 *      poder VERLO en la pantalla del pasajero).
 *
 * Uso (desde services/dispatch-service):
 *   INTERNAL_IDENTITY_SECRET=$(cat ../../dev-stack/secrets/internal-identity-secret.txt) \
 *   KAFKA_BROKERS=localhost:9094 pnpm tsx scripts/sim-driver.ts
 */
import {
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  signInternalIdentity,
  type AuthenticatedUser,
} from '@veo/auth';
import { createEnvelope, createKafka, KafkaEventProducer } from '@veo/events';

// ── Conductor dev (coincide con dev-stack/seed-dev-driver.sql) ──
const USER_ID = 'd0000000-0000-4000-8000-000000000001';
const DRIVER_ID = 'd0000000-0000-4000-8000-0000000000a1'; // Driver.id (perfil) — lo que usa el hot-index y la oferta
const VEHICLE_ID = 'd0000000-0000-4000-8000-0000000000b1';
// Carlos DEBE estar cerca del pickup del pasajero (si no, queda fuera del k-ring del matching y no ve
// la puja). Configurable por env SIM_LAT/SIM_LON; default = pickup de prueba del pasajero.
const POINT = {
  lat: Number(process.env.SIM_LAT ?? -12.003267),
  lon: Number(process.env.SIM_LON ?? -77.063354),
};

const DISPATCH = 'http://localhost:3003/api/v1';
const TRIP = 'http://localhost:3002/api/v1';
const SECRET = process.env.INTERNAL_IDENTITY_SECRET;
if (!SECRET) {
  throw new Error(
    'Falta INTERNAL_IDENTITY_SECRET (pasalo desde dev-stack/secrets/internal-identity-secret.txt)',
  );
}

// Identidad interna del conductor (lo que el driver-bff firmaría: type driver + driverId resuelto).
const driverIdentity: AuthenticatedUser = {
  userId: USER_ID,
  type: 'driver',
  roles: [],
  sessionId: 'sim-driver',
  driverId: DRIVER_ID,
};

function authHeaders(): Record<string, string> {
  const { header, signature } = signInternalIdentity(driverIdentity, SECRET as string);
  return {
    [INTERNAL_IDENTITY_HEADER]: header,
    [INTERNAL_IDENTITY_SIG_HEADER]: signature,
    'content-type': 'application/json',
  };
}

async function api(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* respuestas sin body (204) */
  }
  return { status: res.status, json };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]): void =>
  console.log(`[sim ${new Date().toISOString().slice(11, 19)}]`, ...a);

const producer = new KafkaEventProducer(
  createKafka({
    clientId: 'sim-driver',
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
  }),
);

async function pingLocation(): Promise<void> {
  await producer.publish(
    createEnvelope({
      eventType: 'driver.location_updated',
      producer: 'sim-driver',
      // `h3`/`at` los exige el schema, pero dispatch RECALCULA el h3 desde `point` (ingestLocation →
      // toH3(point)); el h3 del evento se ignora → placeholder válido como string basta.
      payload: {
        driverId: DRIVER_ID,
        point: POINT,
        h3: 'sim',
        at: new Date().toISOString(),
        vehicleType: 'CAR',
      },
    }),
    DRIVER_ID,
  );
}

/** Avanza un viaje ASIGNADO a este conductor hasta completarlo, espaciado para verlo en la app. */
const progressing = new Set<string>();
async function progressTrip(tripId: string): Promise<void> {
  if (progressing.has(tripId)) return;
  progressing.add(tripId);
  log(`viaje ${tripId} ASSIGNED → progresando…`);
  await api('POST', `${TRIP}/trips/${tripId}/accept`, { etaSeconds: 240 });
  log('  → ACCEPTED (conductor aceptó)');
  await sleep(3000);
  await api('POST', `${TRIP}/trips/${tripId}/arriving`, { etaSeconds: 120 });
  log('  → ARRIVING (en camino al recojo)');
  await sleep(5000);
  await api('POST', `${TRIP}/trips/${tripId}/arrived`);
  log('  → ARRIVED (llegó al punto de recojo)');
  await sleep(5000);
  await api('POST', `${TRIP}/trips/${tripId}/start`, { driverId: DRIVER_ID });
  log('  → IN_PROGRESS (viaje iniciado)');
  await sleep(15000);
  // EFECTIVO (decisión del dueño): el conductor, al dar por terminado, marca que COBRÓ el efectivo en
  // mano (cashCollected=true = su lado de la confirmación bilateral, driverConfirmed). Lo mandamos
  // SIEMPRE: es INOFENSIVO para los viajes digitales (trip-service lo ignora si el método no es CASH) y
  // CIERRA el dominó del CASH en dev → el viaje CASH queda PENDING solo a la espera de que el PASAJERO
  // confirme "pagué" en la app, y al confirmar → CAPTURED (nunca queda un efectivo pending colgado).
  await api('POST', `${TRIP}/trips/${tripId}/complete`, { cashCollected: true });
  log(
    '  → COMPLETED ✅ (cashCollected=true: si el viaje es CASH, falta solo que el pasajero confirme)',
  );
}

/** Tras ofertar, vigila el estado del viaje; cuando lo asignan a este conductor, lo progresa. */
const watching = new Set<string>();
async function watchTrip(tripId: string): Promise<void> {
  if (watching.has(tripId)) return;
  watching.add(tripId);
  for (let i = 0; i < 120; i++) {
    const { status, json } = await api('GET', `${TRIP}/trips/${tripId}`);
    const trip = json as { status?: string; driverId?: string } | null;
    if (status === 200 && trip?.status && trip.driverId === DRIVER_ID) {
      if (['ASSIGNED', 'ACCEPTED'].includes(trip.status)) {
        await progressTrip(tripId);
        return;
      }
      if (['COMPLETED', 'CANCELLED', 'FAILED', 'EXPIRED'].includes(trip.status)) {
        log(`viaje ${tripId} terminó en ${trip.status} (sin asignarme) — dejo de vigilar`);
        return;
      }
    }
    await sleep(2000);
  }
}

const offered = new Set<string>();
async function pollAndOffer(): Promise<void> {
  const { status, json } = await api('GET', `${DISPATCH}/bids/open`);
  if (status !== 200 || !Array.isArray(json)) {
    if (status !== 200) log(`GET /bids/open → ${status}`, json);
    return;
  }
  for (const bid of json as Array<{ tripId: string; bidCents: number; vehicleType: string }>) {
    if (offered.has(bid.tripId)) continue;
    offered.add(bid.tripId);
    log(
      `puja abierta ${bid.tripId} (S/${(bid.bidCents / 100).toFixed(2)}) → ofertando ACCEPT_PRICE`,
    );
    // OJO: el GET /bids/open devuelve `bidCents`, pero el submit (SubmitOfferDto) espera `priceCents`
    // (ACCEPT_PRICE == el bid del pasajero). Mandar `bidCents` acá → ValidationPipe 400.
    const r = await api('POST', `${DISPATCH}/bids/${bid.tripId}/offers`, {
      kind: 'ACCEPT_PRICE',
      priceCents: bid.bidCents,
    });
    log(`  oferta → ${r.status}`, r.status >= 400 ? r.json : '');
    void watchTrip(bid.tripId);
  }
}

async function main(): Promise<void> {
  await producer.connect();
  log(
    `conductor "Carlos" online · driverId=${DRIVER_ID} · vehicleId=${VEHICLE_ID} · ${POINT.lat},${POINT.lon}`,
  );
  await pingLocation();
  log('ubicación publicada. Pedí un viaje desde la app — ofertaré y completaré el viaje.');
  setInterval(() => void pingLocation(), 15000);
  setInterval(() => void pollAndOffer(), 4000);
}

void main();
