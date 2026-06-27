/**
 * Test del cobro del pasajero (PaymentsService.charge): tarifa SERVER-AUTHORITATIVE + anti-IDOR +
 * idempotencia por viaje.
 *
 * Vulnerabilidades cerradas (camino de DINERO):
 *  1. AMOUNT TAMPERING: el monto a cobrar NO viene del cliente. Antes el BFF reenviaba `dto.grossCents`
 *     a payment-service → un pasajero posteaba `grossCents: 1` y pagaba S/0.01. Ahora se deriva de la
 *     tarifa autoritativa del viaje (`trip.fareCents` vía GetTrip).
 *  2. IDOR / falta de ownership: antes se cobraba sobre el `tripId` del cliente sin verificar pertenencia.
 *     Ahora GetTrip con el passengerId del JWT → viaje ajeno/inexistente → 404 (anti-enumeración).
 */
import { describe, it, expect, vi } from 'vitest';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import type Redis from 'ioredis';
import { PaymentMethod } from '@veo/shared-types';
import { PaymentsService } from './payments.service';
import type { ChargeDto } from './dto/payments.dto';

const SECRET = 'dev-internal-secret-change-me';
const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

type PostOpts = { identity: unknown; idempotencyKey: string; body: Record<string, unknown> };

function makeService(
  trip: { found: boolean; passengerId?: string; fareCents?: number },
  opts?: { tripThrows?: boolean },
) {
  const tripGrpc = {
    call: vi.fn(async () => {
      if (opts?.tripThrows) throw new Error('trip-service down');
      return { status: 'COMPLETED', fareCents: 0, ...trip };
    }),
  } as unknown as GrpcServiceClient;
  const paymentGrpc = { call: vi.fn() } as unknown as GrpcServiceClient;
  const post = vi.fn(async (_path: string, _opts: PostOpts) => ({ id: 'pay-1' }));
  const restStub = { post } as unknown as InternalRestClient;
  const redisStub = { get: vi.fn(), set: vi.fn(), del: vi.fn() } as unknown as Redis;
  const svc = new PaymentsService(
    paymentGrpc,
    tripGrpc,
    restStub,
    SECRET,
    InternalAudience.PUBLIC_RAIL,
    redisStub,
  );
  return { svc, post };
}

/** Lee las opciones del POST a /payments/charge (path, opts). */
function chargeBody(post: ReturnType<typeof makeService>['post']): PostOpts {
  expect(post).toHaveBeenCalledWith('/payments/charge', expect.anything());
  const call = post.mock.calls[0];
  if (!call) throw new Error('charge no llamó a paymentRest.post');
  return call[1];
}

const dto = (over: Partial<ChargeDto> = {}): ChargeDto => ({
  tripId: 'trip-1',
  method: PaymentMethod.CASH,
  ...over,
});

describe('PaymentsService.charge · tarifa server-authoritative', () => {
  it('cobra la TARIFA del viaje, NO el grossCents del cliente (anti-tampering: dto=1 → cobra 2000)', async () => {
    const { svc, post } = makeService({ found: true, passengerId: 'usr-1', fareCents: 2000 });
    await svc.charge(user, dto({ grossCents: 1 }));
    const body = chargeBody(post).body;
    expect(body.grossCents).toBe(2000); // la tarifa del viaje, jamás el 1 del cliente
  });

  it('respeta la PROPINA del cliente (voluntaria) pero nunca la tarifa', async () => {
    const { svc, post } = makeService({ found: true, passengerId: 'usr-1', fareCents: 2000 });
    await svc.charge(user, dto({ grossCents: 1, tipCents: 500 }));
    const body = chargeBody(post).body;
    expect(body.tipCents).toBe(500);
    expect(body.grossCents).toBe(2000);
  });

  it('idempotencia por viaje intacta: idempotencyKey y body.dedupKey = trip-completed:<tripId>', async () => {
    const { svc, post } = makeService({ found: true, passengerId: 'usr-1', fareCents: 2000 });
    await svc.charge(user, dto());
    const opts = chargeBody(post);
    expect(opts.idempotencyKey).toBe('trip-completed:trip-1');
    expect(opts.body.dedupKey).toBe('trip-completed:trip-1');
  });

  it('404 si el viaje es de OTRO pasajero (anti-IDOR: no cobra)', async () => {
    const { svc, post } = makeService({ found: true, passengerId: 'otro', fareCents: 2000 });
    await expect(svc.charge(user, dto({ grossCents: 1 }))).rejects.toMatchObject({ httpStatus: 404 });
    expect(post).not.toHaveBeenCalled();
  });

  it('404 si el viaje no existe (no cobra)', async () => {
    const { svc, post } = makeService({ found: false });
    await expect(svc.charge(user, dto())).rejects.toMatchObject({ httpStatus: 404 });
    expect(post).not.toHaveBeenCalled();
  });

  it('si trip-service no responde, NO cobra (degradación honesta: jamás un monto inventado)', async () => {
    const { svc, post } = makeService(
      { found: true, passengerId: 'usr-1', fareCents: 2000 },
      { tripThrows: true },
    );
    await expect(svc.charge(user, dto())).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});
