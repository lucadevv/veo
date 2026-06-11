/**
 * E2E CROSS-SERVICIO · PARADA NEGOCIADA mid-trip (Lotes C1-C4).
 *
 * Lleva un viaje hasta IN_PROGRESS (mismo camino que el golden path: login pasajero+KYC, onboarding+
 * gate biométrico del conductor, turno+ubicación, oferta FIXED→accept, ciclo FSM) y entonces valida el
 * flujo de la PARADA NEGOCIADA con TRIPLE evidencia determinista:
 *   1. PASAJERO propone una parada (POST /trips/:id/waypoints) → recibe la propuesta (delta + tarifa nueva).
 *   2. trip-service emite `trip.waypoint_proposed` (Kafka, EventCollector) Y el CONDUCTOR la recibe en vivo
 *      por el socket /driver (`waypoint:proposed`, Lote C4).
 *   3. CONDUCTOR acepta (POST /trips/:id/waypoints/:proposalId/respond) → trip-service emite
 *      `trip.waypoint_accepted` Y el PASAJERO recibe el desenlace por el socket /passenger (`waypoint:outcome`).
 *   4. DOMINIO (server-authoritative, ACID): la parada quedó agregada al viaje y la tarifa se actualizó a la
 *      nueva (GET /trips/:id).
 *
 * A diferencia del golden-path, NO arranca el orquestador: corre contra el stack YA LEVANTADO (dev-stack +
 * servicios + BFFs). Gate: si la infra no está, se OMITE limpio (igual que el golden path).
 *
 * NOTA: este spec asume FIXED-ahora (oferta directa, no PUJA) vía el PUT admin firmado, igual que el golden
 * path; y reutiliza sus fixtures (inyección de OTP en Redis, aprobación seed del conductor).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { checkStack } from '../lib/gate.js';
import { EventCollector } from '../lib/events.js';
import { DriverSocket } from '../lib/driver-socket.js';
import { PassengerSocket } from '../lib/passenger-socket.js';
import { BffClient } from '../lib/http.js';
import { BASE_URLS } from '../lib/config.js';
import { approveDriverByUserId, clearDispatchHotIndex, injectOtp } from '../lib/fixtures.js';
import { putModeSchedule, ruleCoveringNow } from '../lib/pricing-admin.js';
import { pollUntil } from '../lib/wait.js';

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone: string; type: string; kycStatus: string };
}
interface TripResource { id: string; status: string; fareCents: number; driverId: string | null }
interface TripStateView { id: string; status: string }
interface GeoPoint { lat: number; lon: number }
interface TripDetail { id: string; status: string; fareCents: number; waypoints: GeoPoint[] }
interface BiometricChallenge { challengeId: string }
interface BiometricVerifyResult { sessionRef: string }
interface ProposeResult {
  proposalId: string;
  deltaFareCents: number;
  newFareCents: number;
  newEtaSeconds: number;
  expiresAt: string;
}
interface RespondResult { proposalId: string; status: string; fareCents: number }

const ORIGIN = { lat: -12.0464, lon: -77.0428 };
const DESTINATION = { lat: -12.0553, lon: -77.0333 };
// Parada FUERA de la línea recta origen→destino → desvío real → delta de tarifa positivo.
const STOP = { lat: -12.0410, lon: -77.0520 };

const run = Date.now().toString().slice(-6);
const PASSENGER_PHONE = `9${run}11`.slice(0, 9).padEnd(9, '0');
const DRIVER_PHONE = `9${run}22`.slice(0, 9).padEnd(9, '0');
const OTP_CODE = '424242';

// Este spec corre SOLO contra un stack SOSTENIDO (`pnpm run e2e:serve` en otra terminal, o el
// flag en CI con stack propio): en el run encadenado de `e2e:golden`, el stack del golden-path
// se está bajando cuando este archivo colecta → checkStack() puede dar ready en pleno drain y
// el beforeAll muere con ECONNREFUSED (race, no bug del dominio). El gate por env lo hace
// determinista: sin VEO_E2E_HELD_STACK=1 se SKIPEA honesto. Uso: `pnpm run e2e:waypoint`.
const heldStack = process.env.VEO_E2E_HELD_STACK === '1';
const gate = heldStack
  ? await checkStack()
  : { ready: false as const, reason: 'VEO_E2E_HELD_STACK!=1 — corré `pnpm run e2e:waypoint` contra un stack sostenido (e2e:serve)' };
const collector = new EventCollector(['trip', 'dispatch', 'payment', 'driver', 'user']);

(heldStack && gate.ready ? describe : describe.skip)('VEO · parada negociada mid-trip E2E (C1-C4)', () => {
  const passenger = new BffClient(BASE_URLS.publicBff);
  const driverPublic = new BffClient(BASE_URLS.driverBff);

  let passengerToken = '';
  let driverToken = '';
  let driverUserId = '';
  let driverSocket: DriverSocket | undefined;
  let passengerSocket: PassengerSocket | undefined;
  let tripId = '';
  // Contexto de la parada negociada compartido entre los pasos 6 y 7.
  let wpProposalId = '';
  let wpFareBefore = 0;
  let wpWaypointsBefore = 0;
  let wpNewFareCents = 0;

  beforeAll(async () => {
    // Sin orquestador: el stack ya está levantado. Solo preparamos dispatch (limpia fantasmas + FIXED-ahora)
    // y arrancamos el colector de eventos Kafka.
    await clearDispatchHotIndex();
    await putModeSchedule({ defaultMode: 'PUJA', rules: [ruleCoveringNow('FIXED')] });
    await collector.start();
  }, 120_000);

  afterAll(async () => {
    driverSocket?.disconnect();
    passengerSocket?.disconnect();
    await collector.stop().catch(() => undefined);
  }, 30_000);

  it('1. pasajero login + KYC', async () => {
    await passenger.post('/auth/otp/request', { phone: PASSENGER_PHONE, type: 'PASSENGER' });
    await injectOtp(PASSENGER_PHONE, OTP_CODE);
    const tokens = await passenger.post<AuthTokens>('/auth/otp/verify', {
      phone: PASSENGER_PHONE,
      code: OTP_CODE,
      type: 'PASSENGER',
    });
    expect(tokens.accessToken).toBeTruthy();
    passengerToken = tokens.accessToken;
    passenger.setToken(passengerToken);

    const kycChallenge = await passenger.post<{ challengeId: string }>('/kyc/challenge', {});
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

  it('2. conductor login + onboarding + gate biométrico → AVAILABLE', async () => {
    await driverPublic.post('/auth/otp/request', { phone: DRIVER_PHONE, type: 'DRIVER' });
    await injectOtp(DRIVER_PHONE, OTP_CODE);
    const tokens = await driverPublic.post<AuthTokens>('/auth/otp/verify', {
      phone: DRIVER_PHONE,
      code: OTP_CODE,
      type: 'DRIVER',
    });
    expect(tokens.accessToken).toBeTruthy();
    driverToken = tokens.accessToken;
    driverUserId = tokens.user.id;
    driverPublic.setToken(driverToken);

    await driverPublic.post('/drivers/onboard', {
      licenseNumber: `A1-${run}`,
      licenseExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    });
    const approved = await approveDriverByUserId(driverUserId);
    expect(approved).toBe(true);

    await driverPublic.post('/drivers/biometric/enroll', { photo: `ref-${run}` });
    const challenge = await driverPublic.post<BiometricChallenge>('/drivers/shift/biometric/challenge');
    const verify = await driverPublic.post<BiometricVerifyResult>('/drivers/shift/biometric/verify', {
      challengeId: challenge.challengeId,
      frames: ['f1', 'f2', 'f3'],
    });
    expect(verify.sessionRef).toBeTruthy();

    await driverPublic.post('/drivers/vehicles', {
      vehicleType: 'CAR',
      plate: `${run.slice(0, 3)}-${run.slice(3, 6)}`,
      make: 'Toyota',
      model: 'Yaris',
      year: 2021,
    });
    const shift = await driverPublic.post<{ status: string }>('/drivers/shift/start', {
      sessionRef: verify.sessionRef,
      geoLat: ORIGIN.lat,
      geoLon: ORIGIN.lon,
    });
    expect(shift.status).toBe('AVAILABLE');
  });

  it('3. conductor conecta socket /driver + publica ubicación', async () => {
    driverSocket = new DriverSocket(driverToken);
    await driverSocket.connect();
    const firstAck = await pollUntil(
      () => driverSocket!.publishLocation({ ...ORIGIN, vehicleType: 'CAR' }),
      (ack) => ack.ok,
      { timeoutMs: 10_000, intervalMs: 500, label: 'ack location OK' },
    );
    expect(firstAck.ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      await driverSocket.publishLocation({ ...ORIGIN, vehicleType: 'CAR' });
    }
    await collector.waitForEvent((e) => e.eventType === 'driver.location_updated', {
      timeoutMs: 15_000,
      label: 'driver.location_updated',
    });
  });

  it('4. viaje creado → oferta → accept → ASSIGNED', async () => {
    await driverSocket!.publishLocation({ ...ORIGIN, vehicleType: 'CAR' });
    await new Promise((r) => setTimeout(r, 2000));
    const trip = await passenger.post<TripResource>(
      '/trips',
      { origin: ORIGIN, destination: DESTINATION, paymentMethod: 'CASH', category: 'veo_economico' },
      { 'idempotency-key': randomUUID() },
    );
    tripId = trip.id;
    expect(trip.status).toBe('REQUESTED');
    const offer = await driverSocket!.waitForOffer(28_000);
    expect(offer.tripId).toBe(tripId);
    await driverPublic.post(`/dispatch/offers/${offer.matchId}/accept`);
    const assigned = await pollUntil(
      () => driverPublic.get<TripStateView>(`/trips/${tripId}/state`),
      (s) => s.status === 'ASSIGNED',
      { timeoutMs: 20_000, label: 'trip → ASSIGNED' },
    );
    expect(assigned.status).toBe('ASSIGNED');
  });

  it('5. ciclo FSM hasta IN_PROGRESS', async () => {
    await driverPublic.post(`/trips/${tripId}/accept`, { etaSeconds: 120 });
    await driverPublic.post(`/trips/${tripId}/arriving`, { etaSeconds: 60 });
    await driverPublic.post(`/trips/${tripId}/arrived`);
    await driverPublic.post(`/trips/${tripId}/start`, {});
    const live = await pollUntil(
      () => driverPublic.get<TripStateView>(`/trips/${tripId}/state`),
      (s) => s.status === 'IN_PROGRESS',
      { timeoutMs: 15_000, label: 'trip → IN_PROGRESS' },
    );
    expect(live.status).toBe('IN_PROGRESS');
  });

  it('6. PARADA NEGOCIADA: propone → conductor la recibe (Kafka + socket /driver)', async () => {
    // Estado base ANTES de proponer.
    const before = await passenger.get<TripDetail>(`/trips/${tripId}`);
    const fareBefore = before.fareCents;
    const waypointsBefore = before.waypoints?.length ?? 0;

    // Socket del PASAJERO conectado para observar el desenlace (paso 7).
    passengerSocket = new PassengerSocket(passengerToken, tripId);
    await passengerSocket.connect();

    // Waiters registrados ANTES del POST (no perder el evento/push).
    const proposedEventP = collector.waitForEvent(
      (e) => e.eventType === 'trip.waypoint_proposed' && e.payload.tripId === tripId,
      { timeoutMs: 15_000, label: 'trip.waypoint_proposed' },
    );
    const driverPushP = driverSocket!.waitForWaypointProposed(15_000);

    // PASAJERO PROPONE.
    const proposal = await passenger.post<ProposeResult>(`/trips/${tripId}/waypoints`, { point: STOP });
    expect(proposal.proposalId, 'la propuesta debe tener id').toBeTruthy();
    expect(proposal.newFareCents, 'tarifa nueva válida').toBeGreaterThan(0);
    // El desvío sube la tarifa (delta >= 0; server-authoritative).
    expect(proposal.newFareCents).toBeGreaterThanOrEqual(fareBefore);

    // EVIDENCIA Kafka: trip-service emitió el evento.
    const proposedEvent = await proposedEventP;
    expect(proposedEvent.payload.proposalId).toBe(proposal.proposalId);

    // EVIDENCIA socket: el CONDUCTOR recibió la parada en vivo (Lote C4).
    const driverGot = await driverPushP;
    expect(driverGot.proposalId).toBe(proposal.proposalId);
    expect(driverGot.tripId).toBe(tripId);
    expect(driverGot.newFareCents).toBe(proposal.newFareCents);

    // Guardamos para el paso 7.
    wpProposalId = proposal.proposalId;
    wpFareBefore = fareBefore;
    wpWaypointsBefore = waypointsBefore;
    wpNewFareCents = proposal.newFareCents;
  });

  it('7. conductor ACEPTA → pasajero recibe outcome (Kafka + socket /passenger) → dominio actualizado', async () => {
    // Waiters ANTES del respond.
    const acceptedEventP = collector.waitForEvent(
      (e) => e.eventType === 'trip.waypoint_accepted' && e.payload.tripId === tripId,
      { timeoutMs: 15_000, label: 'trip.waypoint_accepted' },
    );
    const outcomeP = passengerSocket!.waitForOutcome(15_000);

    // CONDUCTOR ACEPTA.
    const result = await driverPublic.post<RespondResult>(
      `/trips/${tripId}/waypoints/${wpProposalId}/respond`,
      { accept: true },
    );
    expect(result.status).toBe('ACCEPTED');
    expect(result.proposalId).toBe(wpProposalId);

    // EVIDENCIA Kafka: trip-service emitió waypoint_accepted.
    const acceptedEvent = await acceptedEventP;
    expect(acceptedEvent.payload.proposalId).toBe(wpProposalId);

    // EVIDENCIA socket: el PASAJERO recibió el desenlace ACCEPTED (Lote C4).
    const outcome = await outcomeP;
    expect(outcome.proposalId).toBe(wpProposalId);
    expect(outcome.status).toBe('ACCEPTED');

    // EVIDENCIA dominio (ACID, server-authoritative): parada agregada + tarifa = la nueva.
    const after = await pollUntil(
      () => passenger.get<TripDetail>(`/trips/${tripId}`),
      (t) => (t.waypoints?.length ?? 0) > wpWaypointsBefore,
      { timeoutMs: 10_000, label: 'parada agregada al viaje' },
    );
    expect(after.waypoints.length).toBe(wpWaypointsBefore + 1);
    expect(after.fareCents).toBe(wpNewFareCents);
  });
});

if (!gate.ready) {
  // eslint-disable-next-line no-console
  console.warn(`[waypoint-negotiated-stop] OMITIDO: ${gate.reason}`);
}
