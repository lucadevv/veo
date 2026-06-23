/**
 * E2E CROSS-SERVICIO ORQUESTADO · "golden path" de VEO.
 *
 * Levanta el stack mínimo (identity, trip, dispatch, payment, panic + public-bff + driver-bff)
 * contra el dev-stack (Postgres/Redis/Kafka) y valida el flujo extremo a extremo, hablando con los
 * BFFs REALES por HTTP/WS y verificando estados (APIs gRPC vía BFF) y eventos (Kafka).
 *
 * Flujo validado:
 *   1. Pasajero: OTP → login (identity vía public-bff).
 *   2. Conductor: login + onboarding + (aprobación seed) + enrolamiento biométrico + gate
 *      biométrico sandbox → inicia turno → AVAILABLE.
 *   3. Conductor se conecta al socket /driver y publica ubicación (→ hot index de dispatch).
 *   4. Pasajero crea viaje (public-bff → trip-service REQUESTED → trip.requested →
 *      dispatch matching → oferta por socket). El conductor ACEPTA la oferta →
 *      dispatch.match_found → trip ASSIGNED.
 *   5. Ciclo FSM: ACCEPTED → ARRIVING → ARRIVED → IN_PROGRESS → COMPLETED (driver-bff → trip-service).
 *   6. Cobro automático (payment-service consume trip.completed → payment.captured) + propina.
 *   7. Pánico: el pasajero dispara pánico firmado → ack < 3s (panic-service fan-out) + panic.triggered.
 *   8. Asserts de eventos clave (Kafka) y estados finales vía las APIs de los BFFs.
 *
 * Gate: si la infra del dev-stack no está arriba (o falta Docker), la suite se OMITE limpio
 * (describe.skip), igual que los specs de contrato existentes — pero con la lógica REAL escrita.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { checkStack } from '../lib/gate.js';
import { Orchestrator } from '../lib/orchestrator.js';
import { EventCollector } from '../lib/events.js';
import { DriverSocket } from '../lib/driver-socket.js';
import { BffClient } from '../lib/http.js';
import { BASE_URLS } from '../lib/config.js';
import { signPanic, uuidv7 } from '../lib/panic.js';
import { approveDriverByUserId, clearDispatchHotIndex, injectOtp } from '../lib/fixtures.js';
import { putModeSchedule, ruleCoveringNow } from '../lib/pricing-admin.js';
import { pollUntil } from '../lib/wait.js';

// ── Tipos mínimos de las respuestas que consumimos de los BFFs ──
interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone: string; type: string; kycStatus: string };
}
interface TripResource {
  id: string;
  status: string;
  fareCents: number;
  driverId: string | null;
}
interface TripStateView {
  id: string;
  status: string;
}
interface PanicKey {
  secret: string;
  version: string;
}
interface PanicTriggerResult {
  panicId: string;
  status: string;
  deduplicated: boolean;
}
interface BiometricChallenge {
  challengeId: string;
}
interface BiometricVerifyResult {
  sessionRef: string;
}

// Lima, dos puntos cercanos (mismo barrio → match en k-ring radio 1).
const ORIGIN = { lat: -12.0464, lon: -77.0428 };
const DESTINATION = { lat: -12.0553, lon: -77.0333 };

// Teléfonos únicos por corrida (evita choques de estado entre ejecuciones).
const run = Date.now().toString().slice(-6);
const PASSENGER_PHONE = `9${run}11`.slice(0, 9).padEnd(9, '0');
const DRIVER_PHONE = `9${run}22`.slice(0, 9).padEnd(9, '0');
const OTP_CODE = '424242';

const gate = await checkStack();
const orchestrator = new Orchestrator();

// El stack mínimo emite/consume estos topics de dominio. 'driver-location' es el topic propio del
// firehose de ubicación (driver.location_updated), aislado del 'driver' de ciclo de vida (ver
// TOPIC_OVERRIDES / topicForEvent en @veo/events).
const collector = new EventCollector([
  'trip',
  'dispatch',
  'payment',
  'panic',
  'driver',
  'driver-location',
  'user',
]);

(gate.ready ? describe : describe.skip)('VEO · golden path E2E (cross-servicio orquestado)', () => {
  const passenger = new BffClient(BASE_URLS.publicBff);
  const driverPublic = new BffClient(BASE_URLS.driverBff);

  let driverUserId = '';
  let driverSocket: DriverSocket | undefined;
  let tripId = '';

  beforeAll(async () => {
    // 0. Compila @veo/* a dist + arranca servicios/BFFs + espera health de todos.
    await orchestrator.buildDeps();
    await orchestrator.start();
    // Limpia conductores fantasma de corridas previas del hot index de dispatch (anti-flaky).
    await clearDispatchHotIndex();
    // El default del sistema evolucionó a PUJA (marketplace "proponé tu precio"): sin schedule, una
    // creación de viaje SIN bid se rechaza con "falta tu oferta {mode: PUJA}". El golden path valida el
    // flujo FIXED (oferta directa → accept), así que congelamos FIXED-ahora vía el PUT admin firmado.
    await putModeSchedule({ defaultMode: 'PUJA', rules: [ruleCoveringNow('FIXED')] });
    await collector.start();
  }, 600_000);

  afterAll(async () => {
    driverSocket?.disconnect();
    await collector.stop().catch(() => undefined);
    await orchestrator.stop().catch(() => undefined);
  }, 60_000);

  it('1. pasajero solicita OTP y hace login (identity vía public-bff)', async () => {
    await passenger.post('/auth/otp/request', { phone: PASSENGER_PHONE, type: 'PASSENGER' });
    // El OTP se entrega por SMS sandbox (solo log). Lo "leemos" inyectándolo en Redis (fixture).
    await injectOtp(PASSENGER_PHONE, OTP_CODE);
    const tokens = await passenger.post<AuthTokens>('/auth/otp/verify', {
      phone: PASSENGER_PHONE,
      code: OTP_CODE,
      type: 'PASSENGER',
    });
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.user.type.toUpperCase()).toContain('PASSENGER');
    passenger.setToken(tokens.accessToken);

    // KYC del pasajero (decisión de producto: liveness OK → VERIFIED). En sandbox el biométrico pasa
    // (igual que el gate del conductor). Sin esto, `POST /trips` rechaza el PRIMER viaje con
    // 403 KYC_REQUIRED y cae todo el flujo: el pasajero real lo hace por cámara en el onboarding.
    const kycChallenge = await passenger.post<{ challengeId: string }>('/kyc/challenge', {});
    expect(kycChallenge.challengeId).toBeTruthy();
    const kyc = await passenger.post<{ status: string }>('/kyc/verifications', {
      challengeId: kycChallenge.challengeId,
      frames: [
        { base64Jpeg: 'f1', capturedAt: Date.now() },
        { base64Jpeg: 'f2', capturedAt: Date.now() },
        { base64Jpeg: 'f3', capturedAt: Date.now() },
      ],
    });
    expect(kyc.status).toBe('VERIFIED');
  });

  it('2. conductor hace login, onboarding, gate biométrico y queda AVAILABLE', async () => {
    // Login del conductor.
    await driverPublic.post('/auth/otp/request', { phone: DRIVER_PHONE, type: 'DRIVER' });
    await injectOtp(DRIVER_PHONE, OTP_CODE);
    const tokens = await driverPublic.post<AuthTokens>('/auth/otp/verify', {
      phone: DRIVER_PHONE,
      code: OTP_CODE,
      type: 'DRIVER',
    });
    expect(tokens.accessToken).toBeTruthy();
    driverUserId = tokens.user.id;
    driverPublic.setToken(tokens.accessToken);

    // Onboarding (licencia) → conductor PENDING de aprobación.
    await driverPublic.post('/drivers/onboard', {
      licenseNumber: `A1-${run}`,
      licenseExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    });

    // Aprobación (seed de back-office: en prod la hace un operador con rol admin + TOTP).
    const approved = await approveDriverByUserId(driverUserId);
    expect(approved, 'no se pudo aprobar al conductor en la DB de identity').toBe(true);

    // Enrolamiento facial (sandbox: embedding determinista del hash de la "foto").
    await driverPublic.post('/drivers/biometric/enroll', { photo: `ref-${run}` });

    // Gate biométrico de turno: challenge → verify (sandbox pasa, score 96 ≥ 90) → sessionRef.
    const challenge = await driverPublic.post<BiometricChallenge>(
      '/drivers/shift/biometric/challenge',
    );
    expect(challenge.challengeId).toBeTruthy();
    const verify = await driverPublic.post<BiometricVerifyResult>(
      '/drivers/shift/biometric/verify',
      {
        challengeId: challenge.challengeId,
        frames: ['f1', 'f2', 'f3'],
      },
    );
    expect(verify.sessionRef).toBeTruthy();

    // Registra el vehículo del conductor (CAR). fleet lo toma como su vehículo ACTIVO, y el driver-bff
    // sella ESE tipo en el ping (server-authoritative) — base del test de override del paso 3.
    const vehicle = await driverPublic.post<{ id: string; vehicleType: string }>(
      '/drivers/vehicles',
      {
        vehicleType: 'CAR',
        plate: `${run.slice(0, 3)}-${run.slice(3, 6)}`,
        make: 'Toyota',
        model: 'Yaris',
        year: 2021,
      },
    );
    expect(vehicle.vehicleType).toBe('CAR');

    // Inicio de turno → AVAILABLE.
    const shift = await driverPublic.post<{ status: string }>('/drivers/shift/start', {
      sessionRef: verify.sessionRef,
      geoLat: ORIGIN.lat,
      geoLon: ORIGIN.lon,
    });
    expect(shift.status).toBe('AVAILABLE');

    const state = await driverPublic.get<{ status: string }>('/drivers/shift/state');
    expect(state.status).toBe('AVAILABLE');
  });

  it('3. conductor se conecta al socket /driver y publica ubicación (→ dispatch hot index)', async () => {
    const tokenHeader = (driverPublic as unknown as { token?: string }).token;
    expect(tokenHeader, 'el conductor debe estar autenticado').toBeTruthy();
    driverSocket = new DriverSocket(tokenHeader as string);
    await driverSocket.connect();

    // El handshake del gateway resuelve el driverId (gRPC) de forma asíncrona DESPUÉS del evento
    // `connect`; el primer `location` puede llegar antes de que termine ('unauthenticated'). Hacemos
    // poll del primer ack OK, luego varios reportes para calentar el hot index de dispatch.
    const firstAck = await pollUntil(
      () => driverSocket!.publishLocation({ ...ORIGIN, vehicleType: 'CAR' }),
      (ack) => ack.ok,
      { timeoutMs: 10_000, intervalMs: 500, label: 'ack location OK (socket autenticado)' },
    );
    expect(firstAck.ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      const ack = await driverSocket.publishLocation({ ...ORIGIN, vehicleType: 'CAR' });
      expect(ack.ok, `ack de location: ${ack.error ?? ''}`).toBe(true);
    }

    // El BFF publica driver.location_updated a Kafka; dispatch lo consume al hot index.
    await collector.waitForEvent((e) => e.eventType === 'driver.location_updated', {
      timeoutMs: 15_000,
      label: 'driver.location_updated',
    });

    // SEGURIDAD (server-authoritative del tipo): el cliente DECLARA MOTO en el ping, pero el conductor
    // tiene un CAR registrado. El BFF debe SELLAR CAR (ignorando el spoofeo). Correlacionamos por `at`.
    const spoofTs = `2026-06-10T09:09:09.${String(Number(run) % 1000).padStart(3, '0')}Z`;
    await driverSocket.publishLocation({ ...ORIGIN, vehicleType: 'MOTO', ts: spoofTs });
    const sealed = await collector.waitForEvent(
      (e) => e.eventType === 'driver.location_updated' && e.payload.at === spoofTs,
      { timeoutMs: 10_000, label: 'override de tipo (MOTO declarado → CAR sellado)' },
    );
    expect(sealed.payload.vehicleType).toBe('CAR');
  });

  it('4. pasajero crea viaje → dispatch ofrece → conductor acepta → ASSIGNED', async () => {
    // Refresca la ubicación justo antes del request y da tiempo a que el consumer de dispatch
    // ingiera el `driver.location_updated` al hot index (entre publicar el evento y que dispatch lo
    // consuma hay lag async; sin esto el matching puede no encontrar candidatos → flaky).
    await driverSocket!.publishLocation({ ...ORIGIN, vehicleType: 'CAR' });
    await new Promise((r) => setTimeout(r, 2000));

    const trip = await passenger.post<TripResource>(
      '/trips',
      {
        origin: ORIGIN,
        destination: DESTINATION,
        paymentMethod: 'CASH',
        category: 'veo_economico',
      },
      { 'idempotency-key': randomUUID() },
    );
    tripId = trip.id;
    expect(tripId).toBeTruthy();
    expect(trip.status).toBe('REQUESTED');

    // trip.requested debe llegar a Kafka (lo consume dispatch para lanzar el matching).
    await collector.waitForEvent(
      (e) => e.eventType === 'trip.requested' && e.payload.tripId === tripId,
      { timeoutMs: 15_000, label: 'trip.requested' },
    );

    // El conductor recibe la oferta por el socket (dispatch.offered → BFF → dispatch:offer).
    // Margen amplio (DISPATCH_OFFER_TIMEOUT_MS=30s en el orquestador).
    const offer = await driverSocket!.waitForOffer(28_000);
    expect(offer.tripId).toBe(tripId);
    expect(offer.matchId).toBeTruthy();

    // El conductor ACEPTA la oferta → dispatch.accept → dispatch.match_found.
    await driverPublic.post(`/dispatch/offers/${offer.matchId}/accept`);

    await collector.waitForEvent(
      (e) => e.eventType === 'dispatch.match_found' && e.payload.tripId === tripId,
      { timeoutMs: 15_000, label: 'dispatch.match_found' },
    );

    // trip-service materializa la asignación (consume match_found) → ASSIGNED.
    const assigned = await pollUntil(
      () => driverPublic.get<TripStateView>(`/trips/${tripId}/state`),
      (s) => s.status === 'ASSIGNED',
      { timeoutMs: 20_000, label: 'trip → ASSIGNED' },
    );
    expect(assigned.status).toBe('ASSIGNED');
  });

  it('5. ciclo de viaje: ACCEPTED → ARRIVING → ARRIVED → IN_PROGRESS → COMPLETED', async () => {
    await driverPublic.post(`/trips/${tripId}/accept`, { etaSeconds: 120 });
    await expectState('ACCEPTED');

    await driverPublic.post(`/trips/${tripId}/arriving`, { etaSeconds: 60 });
    await expectState('ARRIVING');

    await driverPublic.post(`/trips/${tripId}/arrived`);
    await expectState('ARRIVED');

    await driverPublic.post(`/trips/${tripId}/start`, {});
    await expectState('IN_PROGRESS');

    // REHIDRATACIÓN (regla #4): con un viaje VIVO, GET /trips/active devuelve ESTE viaje sin conocer su
    // id — así la app del conductor recupera el viaje en curso tras un reinicio (app matada mid-viaje).
    const liveActive = await driverPublic.get<{ id: string; status: string }>(`/trips/active`);
    expect(liveActive?.id).toBe(tripId);
    expect(liveActive?.status).toBe('IN_PROGRESS');

    // Viaje CASH: el conductor confirma que COBRÓ el efectivo en mano (`cashCollected`). Sin este flag,
    // payment-service entra al flujo "bilateral normal" y NO emite ni payment.captured ni cash_pending
    // (espera confirmaciones por otra vía), dejando el cobro sin evento determinista para el e2e.
    await driverPublic.post(`/trips/${tripId}/complete`, { cashCollected: true });
    await expectState('COMPLETED');

    // COMPLETED es terminal (fuera de LIVE_STATES) → GET /trips/active responde 204 → undefined: el
    // conductor ya NO tiene viaje activo, así la rehidratación no lo devuelve a un viaje muerto.
    const noActive = await driverPublic.get<unknown>(`/trips/active`);
    expect(noActive).toBeUndefined();

    // trip.completed debe propagarse (lo consumen payment + dispatch).
    await collector.waitForEvent(
      (e) => e.eventType === 'trip.completed' && e.payload.tripId === tripId,
      { timeoutMs: 15_000, label: 'trip.completed' },
    );
  });

  it('6. cobro automático (payment-service consume trip.completed) + propina', async () => {
    // payment-service cobra al consumir trip.completed (BR-P01). Viaje CASH con cashCollected=true →
    // crea el Payment PENDING (driverConfirmed) y emite payment.cash_pending (push al pasajero a confirmar).
    const cashPending = await collector.waitForEvent(
      (e) => e.eventType === 'payment.cash_pending' && e.payload.tripId === tripId,
      { timeoutMs: 25_000, label: 'payment.cash_pending' },
    );
    expect(cashPending.payload.tripId).toBe(tripId);

    // Propina (BR-P04): 100% al conductor. El viaje ya está cobrado.
    // El conductor sigue conectado al socket /driver: la propina debe llegarle EN VIVO como
    // `payment:tip` (payment-service emite `payment.tip_added` por OUTBOX → Kafka → driver-bff lo
    // enruta al socket). Registramos el waiter ANTES del POST para no perder el evento.
    const tipPromise = driverSocket!.waitForTip(20_000);
    const tipped = await passenger.post<{ tripId: string; tipCents: number }>(
      `/trips/${tripId}/tip`,
      { tipCents: 300 },
    );
    expect(tipped.tipCents).toBeGreaterThanOrEqual(300);

    const liveTip = await tipPromise;
    expect(liveTip.tripId).toBe(tripId);
    expect(liveTip.tipCents).toBe(300);
  });

  it('7. pánico: el pasajero dispara pánico firmado → ack < 3s + panic.triggered', async () => {
    // El cliente obtiene el secreto HMAC compartido y firma el cuerpo (BR-S04).
    const key = await passenger.get<PanicKey>('/auth/panic-key');
    expect(key.secret).toBeTruthy();
    expect(key.version).toBe('panic.trigger:v1');

    // panic-service exige dedupKey UUIDv7 (idempotencia, BR-S05).
    const dedupKey = uuidv7();
    const geo = { lat: ORIGIN.lat, lon: ORIGIN.lon };
    const signature = signPanic(key.secret, { tripId, dedupKey, lat: geo.lat, lon: geo.lon });

    const startedAt = Date.now();
    const result = await passenger.post<PanicTriggerResult>('/panic', {
      tripId,
      dedupKey,
      geo,
      signature,
    });
    const ackMs = Date.now() - startedAt;

    expect(result.panicId).toBeTruthy();
    // SLO de pánico: ack < 3s (FOUNDATION / CLAUDE.md p99 < 3s).
    expect(ackMs, `ack de pánico tardó ${ackMs}ms`).toBeLessThan(3000);

    // Fan-out: panic.triggered debe llegar a Kafka (lo consumen dispatch/notification/audit).
    await collector.waitForEvent(
      (e) => e.eventType === 'panic.triggered' && e.payload.tripId === tripId,
      { timeoutMs: 15_000, label: 'panic.triggered' },
    );
  });

  it('8. estado final del viaje vía API del pasajero es COMPLETED', async () => {
    const state = await passenger.get<TripStateView>(`/trips/${tripId}/state`);
    expect(state.status).toBe('COMPLETED');
  });

  /** Espera (poll) hasta que el estado del viaje (vía driver-bff gRPC) sea `expected`. */
  async function expectState(expected: string): Promise<void> {
    const state = await pollUntil(
      () => driverPublic.get<TripStateView>(`/trips/${tripId}/state`),
      (s) => s.status === expected,
      { timeoutMs: 15_000, label: `trip → ${expected}` },
    );
    expect(state.status).toBe(expected);
  }
});

// Si la suite se omite por gate, dejamos rastro del motivo (visible en el reporter de vitest).
if (!gate.ready) {
  // eslint-disable-next-line no-console
  console.warn(`[golden-path] OMITIDO: ${gate.reason}`);
}
