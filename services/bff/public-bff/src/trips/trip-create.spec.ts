/**
 * Test de la creación de viaje (TripsService.createTrip):
 *  - GATE de verificación facial (KYC): si el pasajero no está VERIFIED → 403 KYC_REQUIRED y NO se
 *    crea el viaje (diferenciador de seguridad VEO, server-side).
 *  - PUJA (GAP #4): con `bidCents` lo reenvía a trip-service (→ puja); sin él, undefined (tarifa fija).
 */
import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import type { InternalRestClient } from '@veo/rpc';
import { PaymentMethod } from '@veo/shared-types';
import { KycRequiredError, TripsService } from './trips.service';
import { DebtPendingError } from '../payments/dto/payments.dto';
import type { DriverEnrichmentService } from './driver-enrichment.service';
import type { CreateTripDto } from './dto/trip.dto';
import type { LiveKitConfig } from '../share/livekit-token';
import type Redis from 'ioredis';

const SECRET = 'dev-internal-secret-change-me';
const livekit: LiveKitConfig = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'devsecret_change_in_production',
  ttlSec: 3600,
};
const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

const ORIGIN = { lat: -12.0464, lon: -77.0428 };
const DESTINATION = { lat: -12.05, lon: -77.05 };

function baseDto(overrides: Partial<CreateTripDto> = {}): CreateTripDto {
  return {
    origin: ORIGIN,
    destination: DESTINATION,
    paymentMethod: PaymentMethod.CASH,
    ...overrides,
  };
}

/**
 * `kycStatus` parametriza la respuesta de identity-service (GetUser).
 * `debt` parametriza la respuesta de payment-service (GET /payments/debt) que consulta el gate de deuda.
 * Por defecto SIN deuda, para que los tests de KYC/PUJA pasen el gate de deuda sin tocarlo.
 */
function makeService(
  kycStatus = 'VERIFIED',
  debt: {
    hasDebt: boolean;
    debts?: { tripId: string; amountCents: number; kind?: 'DEBT' | 'PENDING_ACTION' }[];
    totalCents?: number;
  } = {
    hasDebt: false,
    debts: [],
    totalCents: 0,
  },
) {
  const post = vi.fn().mockResolvedValue({ id: 'trip-1', passengerId: 'usr-1', status: 'REQUESTED' });
  const tripRest = { post } as unknown as InternalRestClient;
  // identityGrpc.call('GetUser', …) → estado de verificación del pasajero.
  const identityGrpc = { call: vi.fn().mockResolvedValue({ found: true, kycStatus }) } as never;
  const grpcStub = {} as never;
  const restStub = {} as unknown as InternalRestClient;
  // paymentRest.get('/payments/debt') → resumen de deuda que consulta assertNoDebt.
  const debtGet = vi.fn().mockResolvedValue({
    hasDebt: debt.hasDebt,
    debts: debt.debts ?? [],
    totalCents: debt.totalCents ?? 0,
  });
  const paymentRest = { get: debtGet } as unknown as InternalRestClient;
  // Redis: get=null (miss) → siempre cae a la fuente autoritativa (KYC y deuda) en el test.
  const redis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };
  const svc = new TripsService(
    grpcStub, // tripGrpc
    identityGrpc, // identityGrpc
    grpcStub, // ratingGrpc
    grpcStub, // fleetGrpc
    grpcStub, // paymentGrpc
    tripRest, // tripRest (REST_TRIP)
    restStub, // dispatchRest
    paymentRest, // paymentRest (REST_PAYMENT) — gate de deuda
    restStub, // ratingRest (REST_RATING) — MI rating del enrich, no usado en createTrip
    livekit,
    SECRET,
    redis as unknown as Redis, // REDIS (cache KYC + deuda)
    {} as unknown as DriverEnrichmentService,
  );
  return { svc, post, debtGet, redis };
}

describe('TripsService.createTrip — gate de verificación facial (KYC)', () => {
  it('kycStatus VERIFIED → crea el viaje', async () => {
    const { svc, post } = makeService('VERIFIED');
    await svc.createTrip(user, baseDto(), 'idem-kyc-ok');
    expect(post).toHaveBeenCalledOnce();
  });

  it('kycStatus PENDING → lanza KYC_REQUIRED (403) y NO crea el viaje', async () => {
    const { svc, post } = makeService('PENDING');
    await expect(svc.createTrip(user, baseDto(), 'idem-kyc-block')).rejects.toBeInstanceOf(
      KycRequiredError,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('kycStatus REJECTED → también bloquea', async () => {
    const { svc, post } = makeService('REJECTED');
    await expect(svc.createTrip(user, baseDto(), 'idem-kyc-rej')).rejects.toMatchObject({
      code: 'KYC_REQUIRED',
      httpStatus: 403,
    });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('TripsService.createTrip — gate de deuda (BR-P02)', () => {
  it('sin deuda → crea el viaje y cachea el resultado "sin deuda" (positivo)', async () => {
    const { svc, post, debtGet, redis } = makeService('VERIFIED', { hasDebt: false });
    await svc.createTrip(user, baseDto(), 'idem-no-debt');
    expect(debtGet).toHaveBeenCalledWith('/payments/debt', { identity: user });
    expect(post).toHaveBeenCalledOnce();
    // Cachea SOLO el positivo (sin deuda) con la clave por usuario.
    expect(redis.set).toHaveBeenCalledWith('debt:none:usr-1', '1', 'EX', expect.any(Number));
  });

  it('con deuda → 403 DEBT_PENDING con { debtTotalCents, oldestTripId } y NO crea el viaje', async () => {
    const { svc, post } = makeService('VERIFIED', {
      hasDebt: true,
      totalCents: 4200,
      // payment ordena por createdAt asc → debts[0] = la más antigua → oldestTripId.
      debts: [
        { tripId: 'trip-oldest', amountCents: 1700 },
        { tripId: 'trip-newer', amountCents: 2500 },
      ],
    });
    await expect(svc.createTrip(user, baseDto(), 'idem-debt')).rejects.toMatchObject({
      code: 'DEBT_PENDING',
      httpStatus: 403,
      details: { debtTotalCents: 4200, oldestTripId: 'trip-oldest' },
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('con deuda → NUNCA cachea (el bloqueo debe reflejar el estado real al instante)', async () => {
    const { svc, redis } = makeService('VERIFIED', {
      hasDebt: true,
      totalCents: 1000,
      debts: [{ tripId: 'trip-x', amountCents: 1000 }],
    });
    await expect(svc.createTrip(user, baseDto(), 'idem-debt-nocache')).rejects.toBeInstanceOf(
      DebtPendingError,
    );
    expect(redis.set).not.toHaveBeenCalledWith('debt:none:usr-1', '1', 'EX', expect.any(Number));
  });

  it('PENDING_ACTION (pago por completar) en la lista → NO bloquea: crea el viaje', async () => {
    // payment-service garantiza hasDebt=false cuando solo hay PENDING_ACTION (no es deuda real).
    const { svc, post } = makeService('VERIFIED', {
      hasDebt: false,
      totalCents: 0,
      debts: [{ tripId: 'trip-pa', amountCents: 3600, kind: 'PENDING_ACTION' }],
    });
    await svc.createTrip(user, baseDto(), 'idem-pending-action');
    expect(post).toHaveBeenCalledOnce(); // el gate NO se disparó
  });

  it('oldestTripId se deriva del primer DEBT, no de un PENDING_ACTION que lo precediera', async () => {
    // Defensa en profundidad: aunque un PENDING_ACTION encabezara la lista, el detalle del 403 apunta
    // al viaje de la DEUDA real, no al pago por completar.
    const { svc, post } = makeService('VERIFIED', {
      hasDebt: true,
      totalCents: 2300,
      debts: [
        { tripId: 'trip-pending-action', amountCents: 3600, kind: 'PENDING_ACTION' },
        { tripId: 'trip-real-debt', amountCents: 2300, kind: 'DEBT' },
      ],
    });
    await expect(svc.createTrip(user, baseDto(), 'idem-mixed')).rejects.toMatchObject({
      code: 'DEBT_PENDING',
      httpStatus: 403,
      details: { debtTotalCents: 2300, oldestTripId: 'trip-real-debt' },
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('cache HIT "sin deuda" → NO reconsulta payment (hot-path)', async () => {
    const { svc, post, debtGet, redis } = makeService('VERIFIED', { hasDebt: false });
    (redis.get).mockImplementation(async (key: string) =>
      key === 'debt:none:usr-1' ? '1' : null,
    );
    await svc.createTrip(user, baseDto(), 'idem-cache-hit');
    expect(debtGet).not.toHaveBeenCalled(); // no pegó a payment para la deuda
    expect(post).toHaveBeenCalledOnce();
  });
});

describe('TripsService.createTrip — entrada de la PUJA (GAP #4)', () => {
  it('CON bidCents → lo REENVÍA a trip-service en el body (ramifica a puja)', async () => {
    const { svc, post } = makeService();
    await svc.createTrip(user, baseDto({ bidCents: 900 }), 'idem-1');
    expect(post).toHaveBeenCalledWith(
      '/trips',
      expect.objectContaining({
        idempotencyKey: 'idem-1',
        body: expect.objectContaining({ passengerId: 'usr-1', bidCents: 900 }),
      }),
    );
  });

  it('SIN bidCents → lo reenvía undefined (camino de tarifa fija intacto)', async () => {
    const { svc, post } = makeService();
    await svc.createTrip(user, baseDto(), 'idem-2');
    const body = post.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body.bidCents).toBeUndefined();
    expect(body.passengerId).toBe('usr-1');
    expect(body.paymentMethod).toBe(PaymentMethod.CASH);
  });
});
