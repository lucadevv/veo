/**
 * E2E CROSS-SERVICIO ORQUESTADO · "PUJA ↔ FIXED por schedule" de VEO (ADR 010 + ADR 011).
 *
 * Reusa el MISMO harness del golden path (orchestrator, fixtures, http, events, driver-socket, auth):
 * levanta identity/trip/dispatch/payment/panic + public-bff/driver-bff contra el dev-stack y valida,
 * extremo a extremo y por HTTP/WS/Kafka REALES, el marketplace de pricing y el switch admin del modo.
 *
 * Cubre:
 *  A) FIXED por schedule — admin PUT /internal/pricing/mode-schedule (identidad admin firmada) con una
 *     regla que hace AHORA→FIXED. quote → mode==='FIXED' (sin bidFloorCents). createTrip SIN bid →
 *     trip REQUESTED, dispatchMode CONGELADO en FIXED, matching secuencial → oferta por socket → accept
 *     → dispatch.match_found → trip ASSIGNED, dispatchMode==='FIXED'. (driverA.)
 *  C) Persist-once — tras crear el viaje FIXED, se FLIPEA el schedule a PUJA; el viaje en vuelo
 *     CONSERVA su dispatchMode==='FIXED' (resolve-once-persist-forever, ADR 011 §1.2).
 *  B) PUJA por schedule — schedule AHORA→PUJA (default). quote → mode==='PUJA' + bidFloorCents.
 *     createTrip CON bid → trip.bid_posted → un conductor elegible (online + gate biométrico) hace
 *     ACCEPT_PRICE → el pasajero lista ofertas → acepta → dispatch.offer_accepted + dispatch.match_found
 *     → trip ASSIGNED con fareCents == precio acordado, dispatchMode==='PUJA'. (driverB.)
 *
 * DOS conductores (driverA para FIXED, driverB para PUJA): tras asignarse a un viaje, un conductor
 * queda ON_TRIP/ASSIGNED → el EligibilityGate de la puja exige currentStatus==='AVAILABLE', así que
 * reusar el mismo conductor para ambos modos lo dejaría no-elegible. Cada conductor se asigna UNA vez.
 * Además, driverA está online durante FIXED ANTES de que driverB exista → el matching FIXED no tiene
 * ambigüedad de candidato; cuando entra driverB (PUJA), driverA ya está asignado (excluido).
 *
 * dispatchMode NO se expone por REST (es interno): lo leemos AUTORITATIVAMENTE de la columna
 * trip.trips.dispatch_mode (fixture getTripPricingRow).
 *
 * Gate: si la infra del dev-stack no está arriba, la suite se OMITE limpio (igual que el golden path).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { checkStack } from '../lib/gate.js';
import { Orchestrator } from '../lib/orchestrator.js';
import { EventCollector } from '../lib/events.js';
import { DriverSocket } from '../lib/driver-socket.js';
import { BffClient } from '../lib/http.js';
import { BASE_URLS } from '../lib/config.js';
import {
  approveDriverByUserId,
  clearDispatchHotIndex,
  injectOtp,
  getTripPricingRow,
} from '../lib/fixtures.js';
import {
  getModeSchedule,
  putModeSchedule,
  resolveMode,
  ruleCoveringNow,
  type ModeSchedule,
} from '../lib/pricing-admin.js';
import { pollUntil } from '../lib/wait.js';

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone: string; type: string; kycStatus: string };
}
interface QuoteResult {
  mode: 'PUJA' | 'FIXED';
  options: { id: string; priceCents: number; vehicleType: string }[];
  bidFloorCents?: number;
  suggestedCents?: number;
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
interface OfferView {
  tripId: string;
  driverId: string;
  priceCents: number;
  status: string;
}
interface BiometricChallenge {
  challengeId: string;
}
interface BiometricVerifyResult {
  sessionRef: string;
}
interface SubmittedOfferView {
  tripId: string;
  driverId: string;
  priceCents: number;
  status: string;
}

const ORIGIN = { lat: -12.0464, lon: -77.0428 };
const DESTINATION = { lat: -12.0553, lon: -77.0333 };

const run = Date.now().toString().slice(-6);
const PASSENGER_PHONE = `9${run}33`.slice(0, 9).padEnd(9, '0');
const DRIVER_A_PHONE = `9${run}44`.slice(0, 9).padEnd(9, '0');
const DRIVER_B_PHONE = `9${run}55`.slice(0, 9).padEnd(9, '0');
const OTP_CODE = '424242';

// Schedules: AHORA→FIXED (regla del día/hora actual) y AHORA→PUJA (default PUJA sin reglas).
const FIXED_NOW: ModeSchedule = { defaultMode: 'PUJA', rules: [ruleCoveringNow('FIXED')] };
const PUJA_NOW: ModeSchedule = { defaultMode: 'PUJA', rules: [] };

const gate = await checkStack();
const orchestrator = new Orchestrator();
// 'driver-location' = topic propio del firehose driver.location_updated (TOPIC_OVERRIDES en @veo/events).
const collector = new EventCollector([
  'trip',
  'dispatch',
  'payment',
  'panic',
  'driver',
  'driver-location',
  'user',
]);

/** Un conductor listo para despachar: login + onboard + aprobación + gate biométrico + turno + socket. */
interface ReadyDriver {
  client: BffClient;
  socket: DriverSocket;
  userId: string;
}

(gate.ready ? describe : describe.skip)(
  'VEO · PUJA↔FIXED por schedule E2E (cross-servicio orquestado)',
  () => {
    const passenger = new BffClient(BASE_URLS.publicBff);

    let driverA: ReadyDriver | undefined; // FIXED
    let driverB: ReadyDriver | undefined; // PUJA
    let fixedTripId = '';
    let pujaTripId = '';

    /** Sube a un conductor hasta AVAILABLE + socket conectado + ubicación en el hot index. */
    async function setupDriver(phone: string): Promise<ReadyDriver> {
      const client = new BffClient(BASE_URLS.driverBff);
      await client.post('/auth/otp/request', { phone, type: 'DRIVER' });
      await injectOtp(phone, OTP_CODE);
      const tok = await client.post<AuthTokens>('/auth/otp/verify', {
        phone,
        code: OTP_CODE,
        type: 'DRIVER',
      });
      const userId = tok.user.id;
      client.setToken(tok.accessToken);

      await client.post('/drivers/onboard', {
        licenseNumber: `A2-${phone.slice(-4)}`,
        licenseExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      });
      const approved = await approveDriverByUserId(userId);
      expect(approved, `no se pudo aprobar al conductor ${phone}`).toBe(true);
      await client.post('/drivers/biometric/enroll', { photo: `ref-${phone}` });
      const challenge = await client.post<BiometricChallenge>('/drivers/shift/biometric/challenge');
      const verify = await client.post<BiometricVerifyResult>('/drivers/shift/biometric/verify', {
        challengeId: challenge.challengeId,
        frames: ['f1', 'f2', 'f3'],
      });
      const shift = await client.post<{ status: string }>('/drivers/shift/start', {
        sessionRef: verify.sessionRef,
        geoLat: ORIGIN.lat,
        geoLon: ORIGIN.lon,
      });
      expect(shift.status).toBe('AVAILABLE');

      const tokenHeader = (client as unknown as { token?: string }).token as string;
      const socket = new DriverSocket(tokenHeader);
      await socket.connect();
      const firstAck = await pollUntil(
        () => socket.publishLocation({ ...ORIGIN, vehicleType: 'CAR' }),
        (ack) => ack.ok,
        { timeoutMs: 10_000, intervalMs: 500, label: `ack location OK ${phone}` },
      );
      expect(firstAck.ok).toBe(true);
      for (let i = 0; i < 3; i++) await socket.publishLocation({ ...ORIGIN, vehicleType: 'CAR' });
      return { client, socket, userId };
    }

    beforeAll(async () => {
      await orchestrator.buildDeps();
      await orchestrator.start();
      await clearDispatchHotIndex();
      await collector.start();

      // Pasajero.
      await passenger.post('/auth/otp/request', { phone: PASSENGER_PHONE, type: 'PASSENGER' });
      await injectOtp(PASSENGER_PHONE, OTP_CODE);
      const ptok = await passenger.post<AuthTokens>('/auth/otp/verify', {
        phone: PASSENGER_PHONE,
        code: OTP_CODE,
        type: 'PASSENGER',
      });
      passenger.setToken(ptok.accessToken);

      // KYC del pasajero (sandbox determinista): el public-bff exige VERIFIED para el PRIMER viaje
      // (403 KYC_REQUIRED) — mismo paso que el golden-path; sin esto A3/B2 caen antes de crear el trip.
      const kycChallenge = await passenger.post<{ challengeId: string }>('/kyc/challenge', {});
      const kyc = await passenger.post<{ status: string }>('/kyc/verifications', {
        challengeId: kycChallenge.challengeId,
        frames: [
          { base64Jpeg: 'f1', capturedAt: Date.now() },
          { base64Jpeg: 'f2', capturedAt: Date.now() },
          { base64Jpeg: 'f3', capturedAt: Date.now() },
        ],
      });
      if (kyc.status !== 'VERIFIED') {
        throw new Error(`KYC sandbox no verificó al pasajero (status=${kyc.status})`);
      }

      // Solo driverA online para la fase FIXED (sin ambigüedad de candidato en el matching secuencial).
      driverA = await setupDriver(DRIVER_A_PHONE);
      await collector.waitForEvent((e) => e.eventType === 'driver.location_updated', {
        timeoutMs: 15_000,
        label: 'driver.location_updated (A)',
      });
    }, 600_000);

    afterAll(async () => {
      driverA?.socket.disconnect();
      driverB?.socket.disconnect();
      await collector.stop().catch(() => undefined);
      await orchestrator.stop().catch(() => undefined);
    }, 60_000);

    // ── A) FIXED por schedule ──────────────────────────────────────────────────────────────────────

    it('A1. admin fija el schedule AHORA→FIXED (PUT interno firmado) y resolve devuelve FIXED', async () => {
      const put = await putModeSchedule(FIXED_NOW);
      expect(put.status).toBe(200);
      const got = await getModeSchedule();
      expect(got.status).toBe(200);
      // Prueba AUTORITATIVA del switch: el resolver (lógica real) devuelve FIXED para AHORA.
      const resolved = await resolveMode(ORIGIN.lat, ORIGIN.lon);
      expect(resolved.status).toBe(200);
      expect(resolved.mode).toBe('FIXED');
    });

    it('A2. quote del pasajero devuelve mode FIXED (sin bidFloorCents)', async () => {
      const quote = await passenger.post<QuoteResult>('/maps/quote', {
        origin: { lat: ORIGIN.lat, lng: ORIGIN.lon },
        destination: { lat: DESTINATION.lat, lng: DESTINATION.lon },
      });
      expect(quote.mode).toBe('FIXED');
      expect(quote.bidFloorCents).toBeUndefined();
      expect(quote.options.length).toBeGreaterThan(0);
    });

    it('A3. createTrip SIN bid → REQUESTED, dispatchMode CONGELADO en FIXED, matching → ASSIGNED', async () => {
      await driverA!.socket.publishLocation({ ...ORIGIN, vehicleType: 'CAR' });
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
      fixedTripId = trip.id;
      expect(trip.status).toBe('REQUESTED');

      const row = await getTripPricingRow(fixedTripId);
      expect(row?.dispatchMode).toBe('FIXED');

      // FIXED emite trip.requested (NO trip.bid_posted).
      await collector.waitForEvent(
        (e) => e.eventType === 'trip.requested' && e.payload.tripId === fixedTripId,
        { timeoutMs: 15_000, label: 'trip.requested (FIXED)' },
      );

      const offer = await driverA!.socket.waitForOffer(28_000);
      expect(offer.tripId).toBe(fixedTripId);
      await driverA!.client.post(`/dispatch/offers/${offer.matchId}/accept`);
      await collector.waitForEvent(
        (e) => e.eventType === 'dispatch.match_found' && e.payload.tripId === fixedTripId,
        { timeoutMs: 15_000, label: 'dispatch.match_found (FIXED)' },
      );
      const assigned = await pollUntil(
        () => driverA!.client.get<TripStateView>(`/trips/${fixedTripId}/state`),
        (s) => s.status === 'ASSIGNED',
        { timeoutMs: 20_000, label: 'trip FIXED → ASSIGNED' },
      );
      expect(assigned.status).toBe('ASSIGNED');
      const finalRow = await getTripPricingRow(fixedTripId);
      expect(finalRow?.dispatchMode).toBe('FIXED');
      expect(finalRow?.status).toBe('ASSIGNED');
    });

    // ── C) Persist-once (sobre el viaje FIXED en vuelo) ──────────────────────────────────────────────

    it('C1. flip schedule → PUJA NO cambia el dispatchMode del viaje FIXED en vuelo (persist-once)', async () => {
      const put = await putModeSchedule(PUJA_NOW);
      expect(put.status).toBe(200);
      // El resolver YA devuelve PUJA para nuevos viajes…
      const resolved = await resolveMode(ORIGIN.lat, ORIGIN.lon);
      expect(resolved.mode).toBe('PUJA');
      // …pero el viaje FIXED creado antes conserva su modo congelado (ADR 011 §1.2).
      const row = await getTripPricingRow(fixedTripId);
      expect(row?.dispatchMode).toBe('FIXED');
    });

    // ── B) PUJA por schedule ─────────────────────────────────────────────────────────────────────────

    it('B1. con schedule PUJA (default), quote devuelve mode PUJA + bidFloorCents', async () => {
      const resolved = await resolveMode(ORIGIN.lat, ORIGIN.lon);
      expect(resolved.mode).toBe('PUJA');

      const quote = await passenger.post<QuoteResult>('/maps/quote', {
        origin: { lat: ORIGIN.lat, lng: ORIGIN.lon },
        destination: { lat: DESTINATION.lat, lng: DESTINATION.lon },
      });
      expect(quote.mode).toBe('PUJA');
      expect(quote.bidFloorCents).toBeGreaterThan(0);
      expect(quote.suggestedCents).toBeGreaterThan(0);
    });

    it('B2. driverB online; createTrip CON bid → trip.bid_posted, dispatchMode CONGELADO en PUJA', async () => {
      // El producto ahora exige UN solo viaje activo por pasajero (ACTIVE_TRIP_EXISTS, 409):
      // cerramos el viaje FIXED de la fase A antes de abrir el de PUJA. El persist-once de C1
      // ya quedó verificado sobre ese viaje; cancelarlo no toca ningún monto esperado.
      await passenger.post(`/trips/${fixedTripId}/cancel`, { reason: 'e2e: fin de fase FIXED' });

      // driverB entra AHORA (driverA ya está ASSIGNED → excluido del matching). driverB queda AVAILABLE.
      driverB = await setupDriver(DRIVER_B_PHONE);
      await driverB.socket.publishLocation({ ...ORIGIN, vehicleType: 'CAR' });
      await new Promise((r) => setTimeout(r, 2000));

      const trip = await passenger.post<TripResource>(
        '/trips',
        {
          origin: ORIGIN,
          destination: DESTINATION,
          paymentMethod: 'CASH',
          category: 'veo_economico',
          bidCents: 1500,
        },
        { 'idempotency-key': randomUUID() },
      );
      pujaTripId = trip.id;
      expect(trip.status).toBe('REQUESTED');
      expect(trip.fareCents).toBe(1500);

      const row = await getTripPricingRow(pujaTripId);
      expect(row?.dispatchMode).toBe('PUJA');

      const bid = await collector.waitForEvent(
        (e) => e.eventType === 'trip.bid_posted' && e.payload.tripId === pujaTripId,
        { timeoutMs: 15_000, label: 'trip.bid_posted (PUJA)' },
      );
      expect(bid.payload.bidCents).toBe(1500);
    });

    it('B3. driverB hace ACCEPT_PRICE; pasajero lista, acepta → match + ASSIGNED a precio acordado', async () => {
      const submitted = await pollUntil(
        () =>
          driverB!.client.post<SubmittedOfferView>(`/bids/${pujaTripId}/offer`, {
            kind: 'ACCEPT_PRICE',
            priceCents: 1500,
          }),
        (o) => !!o.tripId,
        { timeoutMs: 20_000, intervalMs: 1500, label: 'driverB submit ACCEPT_PRICE' },
      );
      expect(submitted.tripId).toBe(pujaTripId);
      expect(submitted.priceCents).toBe(1500);

      // El endpoint devuelve el TABLERO de la puja: { board: { status, expiresAt }, offers: [...] }
      // (antes era el array pelado — el sobre llegó con el board de expiración).
      const boardView = await pollUntil(
        () =>
          passenger.get<{ board: { status: string }; offers: OfferView[] }>(
            `/trips/${pujaTripId}/offers`,
          ),
        (view) => view.offers.length > 0,
        { timeoutMs: 15_000, intervalMs: 1000, label: 'pasajero lista ofertas (≥1)' },
      );
      const chosen = boardView.offers[0]!;
      expect(chosen.priceCents).toBe(1500);

      await passenger.post(`/trips/${pujaTripId}/offers/${chosen.driverId}/accept`);
      await collector.waitForEvent(
        (e) => e.eventType === 'dispatch.offer_accepted' && e.payload.tripId === pujaTripId,
        { timeoutMs: 15_000, label: 'dispatch.offer_accepted (PUJA)' },
      );
      await collector.waitForEvent(
        (e) => e.eventType === 'dispatch.match_found' && e.payload.tripId === pujaTripId,
        { timeoutMs: 15_000, label: 'dispatch.match_found (PUJA)' },
      );

      const assigned = await pollUntil(
        () => driverB!.client.get<TripStateView>(`/trips/${pujaTripId}/state`),
        (s) => s.status === 'ASSIGNED',
        { timeoutMs: 20_000, label: 'trip PUJA → ASSIGNED' },
      );
      expect(assigned.status).toBe('ASSIGNED');
      const row = await getTripPricingRow(pujaTripId);
      expect(row?.dispatchMode).toBe('PUJA');
      expect(row?.fareCents).toBe(1500);
      expect(row?.status).toBe('ASSIGNED');
    });
  },
);

if (!gate.ready) {
  // eslint-disable-next-line no-console
  console.warn(`[pricing-switch] OMITIDO: ${gate.reason}`);
}
