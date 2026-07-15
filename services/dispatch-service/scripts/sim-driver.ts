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
  InternalAudience,
  signInternalIdentity,
  type AuthenticatedUser,
} from '@veo/auth';
import { createEnvelope, createKafka, KafkaEventProducer, topicForEvent } from '@veo/events';

// ── Conductor dev (default = el de dev-stack/seed-dev-driver.sql). Override por env para correr VARIOS
// sims a la vez (uno por conductor) — cada conductor solo puede estar EN UN viaje, así que N viajes
// IN_PROGRESS simultáneos exigen N conductores/sims. `veo.sh seed trips N` los siembra y arranca. ──
const USER_ID = process.env.SIM_USER_ID ?? 'd0000000-0000-4000-8000-000000000001';
const DRIVER_ID = process.env.SIM_DRIVER_ID ?? 'd0000000-0000-4000-8000-0000000000a1'; // Driver.id (perfil) — lo que usa el hot-index y la oferta
const VEHICLE_ID = process.env.SIM_VEHICLE_ID ?? 'd0000000-0000-4000-8000-0000000000b1';
// Carlos DEBE estar cerca del pickup del pasajero (si no, queda fuera del k-ring del matching y no ve
// la puja). Configurable por env SIM_LAT/SIM_LON; default = pickup de prueba del pasajero.
const POINT = {
  lat: Number(process.env.SIM_LAT ?? -12.003267),
  lon: Number(process.env.SIM_LON ?? -77.063354),
};

// Puertos del boot local (boot-passenger-stack.sh): dispatch 3093, trip 3092. Override por env.
const DISPATCH = process.env.DISPATCH_URL ?? 'http://localhost:3093/api/v1';
const TRIP = process.env.TRIP_URL ?? 'http://localhost:3092/api/v1';
const SECRET = process.env.INTERNAL_IDENTITY_SECRET;
if (!SECRET) {
  throw new Error(
    'Falta INTERNAL_IDENTITY_SECRET (pasalo desde dev-stack/secrets/internal-identity-secret.txt)',
  );
}

// SIM_STOP_AT: hasta dónde progresa el sim el viaje. `IN_PROGRESS` lo deja EN CURSO (no llama complete) —
// lo usa `veo.sh seed trips` para dejar viajes clavados en IN_PROGRESS. `COMPLETED` (default) = flujo
// completo de punta a punta (uso histórico intacto). Cualquier otro valor cae a COMPLETED.
const STOP_AT: 'IN_PROGRESS' | 'COMPLETED' =
  (process.env.SIM_STOP_AT ?? 'COMPLETED').toUpperCase() === 'IN_PROGRESS'
    ? 'IN_PROGRESS'
    : 'COMPLETED';

// Identidad interna del conductor (lo que el driver-bff firmaría: type driver + driverId resuelto).
const driverIdentity: AuthenticatedUser = {
  userId: USER_ID,
  type: 'driver',
  roles: [],
  sessionId: 'sim-driver',
  driverId: DRIVER_ID,
};

function authHeaders(): Record<string, string> {
  // Riel driver-rail (ADR-025): el guard de los servicios verifica la AUDIENCIA firmada (fail-closed).
  // dispatch acota /bids y /dispatch/offers a DRIVER_RAIL; trip acepta cualquier riel permitido. Sin este
  // 3er argumento la identidad viaja SIN `aud` → los guards la RECHAZAN (401) y el sim no puede operar.
  const { header, signature } = signInternalIdentity(
    driverIdentity,
    SECRET as string,
    InternalAudience.DRIVER_RAIL,
  );
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

const kafka = createKafka({
  clientId: `sim-driver-${DRIVER_ID}`,
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
});
const producer = new KafkaEventProducer(kafka);

// ── Consumer de ofertas FIXED ────────────────────────────────────────────────────────────────────────
// En FIXED (modo por defecto del catálogo, p.ej. veo_economico) dispatch NO abre board de puja: OFERTA UN
// viaje concreto a un conductor publicando `dispatch.offered` (topic `dispatch`) y el conductor debe ACEPTAR
// el match (POST /dispatch/offers/:matchId/accept → dispatch.match_found → trip ASSIGNED). El poll de
// /bids/open SOLO cubre PUJA (que además necesita el accept del pasajero). Sin este consumer el sim NO puede
// llevar un viaje FIXED a IN_PROGRESS de forma headless.
// groupId ÚNICO por conductor: con varios sims un grupo compartido repartiría particiones y un sim en la
// partición equivocada DESCARTARÍA la oferta de otro conductor (filtra por su driverId) → el conductor real
// nunca la vería. Grupo propio ⇒ cada sim recibe TODOS los `dispatch.offered` del topic y filtra el suyo.
const offerConsumer = kafka.consumer({
  groupId: `sim-driver-offers-${DRIVER_ID}`,
  sessionTimeout: 30_000,
});
let consumerReady = false;
offerConsumer.on(offerConsumer.events.GROUP_JOIN, () => {
  if (consumerReady) return;
  consumerReady = true;
  // Marcador que `veo.sh seed trips` espera ANTES de crear viajes: una oferta FIXED perdida durante el
  // rebalance NO se re-oferta al mismo conductor (queda como único candidato ya intentado → el viaje EXPIRA).
  log('SIM_CONSUMER_READY (grupo unido; escuchando dispatch.offered para ofertas FIXED)');
});

const acceptedMatches = new Set<string>();
async function startOfferConsumer(): Promise<void> {
  await offerConsumer.connect();
  await offerConsumer.subscribe({
    topic: topicForEvent('dispatch.offered'),
    fromBeginning: false,
  });
  await offerConsumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      let env: { eventType?: string; payload?: Record<string, unknown> };
      try {
        env = JSON.parse(message.value.toString()) as {
          eventType?: string;
          payload?: Record<string, unknown>;
        };
      } catch {
        return; // body no-JSON: ignorar (poison-safe)
      }
      if (env.eventType !== 'dispatch.offered') return;
      const p = env.payload ?? {};
      if (p.driverId !== DRIVER_ID) return; // la oferta no es para este conductor
      // `bidCents` presente ⇒ broadcast de PUJA (lo maneja pollAndOffer + el accept del pasajero). Ausente ⇒
      // oferta directa FIXED: ESTE sim la acepta para materializar el match.
      if (p.bidCents !== undefined) return;
      const matchId = String(p.matchId ?? '');
      const tripId = String(p.tripId ?? '');
      if (!matchId || !tripId || acceptedMatches.has(matchId)) return;
      acceptedMatches.add(matchId);
      log(`oferta FIXED ${matchId} (trip ${tripId}) → acepto el match`);
      const r = await api('POST', `${DISPATCH}/dispatch/offers/${matchId}/accept`);
      log(`  accept match → ${r.status}`, r.status >= 400 ? r.json : '');
      if (r.status < 400) void watchTrip(tripId);
    },
  });
}

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
  if (STOP_AT === 'IN_PROGRESS') {
    log('  ⏸ SIM_STOP_AT=IN_PROGRESS → dejo el viaje EN CURSO (no lo completo)');
    return;
  }
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
  await startOfferConsumer();
  log(
    `conductor "Carlos" online · driverId=${DRIVER_ID} · vehicleId=${VEHICLE_ID} · ${POINT.lat},${POINT.lon} · stopAt=${STOP_AT}`,
  );
  await pingLocation();
  log('ubicación publicada. Ofertas FIXED por Kafka (dispatch.offered) · PUJA por /bids/open.');
  setInterval(() => void pingLocation(), 15000);
  setInterval(() => void pollAndOffer(), 4000);
}

void main();
