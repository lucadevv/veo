/**
 * Test del recibo por viaje (PaymentsService.getPaymentByTrip): anti-IDOR + resolución del cobro.
 * El BFF verifica PRIMERO que el viaje sea del pasajero (GetTrip gRPC) y SOLO entonces resuelve su
 * cobro canónico (GetPaymentByTrip). Ajeno/inexistente → 404; sin cobro → 404.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedUser } from '@veo/auth';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import type Redis from 'ioredis';
import { PaymentsService } from './payments.service';

const SECRET = 'dev-internal-secret-change-me';
const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

const PAYMENT = {
  id: 'pay-1',
  tripId: 'trip-1',
  method: 'CASH',
  status: 'CAPTURED',
  amountCents: 1500,
  grossCents: 1500,
  tipCents: 0,
  commissionCents: 300,
  feeCents: 0,
  externalRef: 'cash:trip-1',
  found: true,
  // proto3: campos checkout llegan como "" cuando no aplican (cobro sin checkout async).
  externalUid: '',
  checkoutUrl: '',
  qrCode: '',
  deepLink: '',
  cip: '',
  checkoutExpiresAt: '',
};

function makeService(opts: {
  trip: { found: boolean; passengerId?: string };
  payment?: typeof PAYMENT | { found: false };
}) {
  const tripGrpc = {
    call: vi.fn().mockResolvedValue({ status: 'COMPLETED', ...opts.trip }),
  } as unknown as GrpcServiceClient;
  const paymentGrpc = {
    call: vi.fn().mockResolvedValue(opts.payment ?? PAYMENT),
  } as unknown as GrpcServiceClient;
  const restStub = {} as unknown as InternalRestClient;
  const redisStub = { get: vi.fn(), set: vi.fn(), del: vi.fn() } as unknown as Redis;
  const svc = new PaymentsService(paymentGrpc, tripGrpc, restStub, SECRET, redisStub);
  return { svc, tripGrpc, paymentGrpc };
}

describe('PaymentsService.getPaymentByTrip', () => {
  it('devuelve el cobro cuando el viaje es del pasajero', async () => {
    const { svc, tripGrpc, paymentGrpc } = makeService({
      trip: { found: true, passengerId: 'usr-1' },
    });
    const view = await svc.getPaymentByTrip(user, 'trip-1');
    expect(view.id).toBe('pay-1');
    expect(view.status).toBe('CAPTURED');
    expect(view.externalRef).toBe('cash:trip-1');
    expect(tripGrpc.call).toHaveBeenCalledWith('GetTrip', { id: 'trip-1' }, expect.anything());
    expect(paymentGrpc.call).toHaveBeenCalledWith(
      'GetPaymentByTrip',
      { tripId: 'trip-1' },
      expect.anything(),
    );
  });

  it('404 si el viaje es de OTRO pasajero (anti-IDOR; no se resuelve el cobro)', async () => {
    const { svc, paymentGrpc } = makeService({ trip: { found: true, passengerId: 'otro' } });
    await expect(svc.getPaymentByTrip(user, 'trip-1')).rejects.toMatchObject({ httpStatus: 404 });
    expect(paymentGrpc.call).not.toHaveBeenCalled();
  });

  it('404 si el viaje no existe', async () => {
    const { svc, paymentGrpc } = makeService({ trip: { found: false } });
    await expect(svc.getPaymentByTrip(user, 'trip-1')).rejects.toMatchObject({ httpStatus: 404 });
    expect(paymentGrpc.call).not.toHaveBeenCalled();
  });

  it('404 si el viaje es del pasajero pero aún no tiene cobro', async () => {
    const { svc } = makeService({
      trip: { found: true, passengerId: 'usr-1' },
      payment: { found: false },
    });
    await expect(svc.getPaymentByTrip(user, 'trip-1')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('campos de checkout = null cuando el cobro no tiene checkout async (sandbox/efectivo)', async () => {
    const { svc } = makeService({ trip: { found: true, passengerId: 'usr-1' } });
    const view = await svc.getPaymentByTrip(user, 'trip-1');
    // proto3 entrega "" → el BFF re-mapea a null en el recibo público (sin romper la shape).
    expect(view.checkoutUrl).toBeNull();
    expect(view.qrCode).toBeNull();
    expect(view.deepLink).toBeNull();
    expect(view.cip).toBeNull();
    expect(view.checkoutExpiresAt).toBeNull();
    expect(view.externalUid).toBeNull();
  });

  it('confirmCash devuelve un PaymentView COMPLETO (no el shape de 4 campos del comando interno)', async () => {
    // REGRESIÓN: el comando interno `POST /payments/:id/cash/confirm` responde
    // `{ tripId, driverConfirmed, passengerConfirmed, status }` — NO un PaymentView. Si el BFF devolviera
    // ESO, la app lo parsea con el schema `paymentView` (zod) y revienta (faltan id/method/amountCents/
    // externalRef…): el confirm respondía 200 pero la app mostraba "error". El BFF RE-LEE el cobro
    // canónico (GetPayment) y devuelve el PaymentView completo por el mapeo público (blankToNull).
    const restCalls: string[] = [];
    const paymentGrpc = {
      call: vi.fn().mockResolvedValue({ ...PAYMENT, status: 'PENDING' }),
    } as unknown as GrpcServiceClient;
    const tripGrpc = { call: vi.fn() } as unknown as GrpcServiceClient;
    const restStub = {
      post: vi.fn(async (path: string) => {
        restCalls.push(path);
        // El comando interno responde SOLO el estado de la confirmación (no un PaymentView).
        return {
          tripId: 'trip-1',
          driverConfirmed: false,
          passengerConfirmed: true,
          status: 'PENDING',
        };
      }),
    } as unknown as InternalRestClient;
    const redisStub = { get: vi.fn(), set: vi.fn(), del: vi.fn() } as unknown as Redis;
    const svc = new PaymentsService(paymentGrpc, tripGrpc, restStub, SECRET, redisStub);

    const view = await svc.confirmCash(user, 'pay-1', { confirmed: true });

    // El comando interno se disparó con el id del pago…
    expect(restCalls).toContain('/payments/pay-1/cash/confirm');
    // …y la respuesta pública es un PaymentView COMPLETO (re-leído por GetPayment).
    expect(paymentGrpc.call).toHaveBeenCalledWith('GetPayment', { id: 'pay-1' }, expect.anything());
    expect(view.id).toBe('pay-1');
    expect(view.method).toBe('CASH');
    expect(view.amountCents).toBe(1500);
    expect(view.status).toBe('PENDING');
    expect(view.externalRef).toBe('cash:trip-1');
    // Campos de checkout re-mapeados a null (mismo contrato público que getPayment).
    expect(view.checkoutUrl).toBeNull();
    expect(view.qrCode).toBeNull();
  });

  it('expone los campos de checkout cuando el cobro es PENDING_EXTERNAL (ProntoPaga)', async () => {
    const { svc } = makeService({
      trip: { found: true, passengerId: 'usr-1' },
      payment: {
        ...PAYMENT,
        method: 'PAGOEFECTIVO',
        status: 'PENDING',
        externalUid: 'pp-uid-9',
        checkoutUrl: 'https://pay.prontopaga.com/abc',
        qrCode: 'data:image/png;base64,iVBOR',
        deepLink: 'yape://pay/abc',
        cip: '01234567',
        checkoutExpiresAt: '2026-06-07T12:00:00.000Z',
      },
    });
    const view = await svc.getPaymentByTrip(user, 'trip-1');
    expect(view.status).toBe('PENDING');
    expect(view.checkoutUrl).toBe('https://pay.prontopaga.com/abc');
    expect(view.qrCode).toBe('data:image/png;base64,iVBOR');
    expect(view.cip).toBe('01234567');
    expect(view.checkoutExpiresAt).toBe('2026-06-07T12:00:00.000Z');
    expect(view).not.toHaveProperty('walletUid');
  });
});

/**
 * Anti-IDOR de getPayment por id (cierre del read-IDOR de auditoría): el gRPC GetPayment es getter crudo
 * por id; el BFF verifica ownership por REST interno (passengerId) ANTES de resolver la vista por gRPC.
 */
describe('PaymentsService.getPayment · anti-IDOR por id', () => {
  function make(opts: { owner?: { passengerId?: string | null }; restThrows?: boolean }) {
    const paymentGrpc = {
      call: vi.fn().mockResolvedValue(PAYMENT),
    } as unknown as GrpcServiceClient;
    const tripGrpc = { call: vi.fn() } as unknown as GrpcServiceClient;
    const restStub = {
      get: vi.fn(async () => {
        if (opts.restThrows) throw new Error('404');
        return opts.owner ?? { passengerId: 'usr-1' };
      }),
    } as unknown as InternalRestClient;
    const redisStub = { get: vi.fn(), set: vi.fn(), del: vi.fn() } as unknown as Redis;
    const svc = new PaymentsService(paymentGrpc, tripGrpc, restStub, SECRET, redisStub);
    return { svc, paymentGrpc };
  }

  it('devuelve el cobro cuando es del pasajero autenticado', async () => {
    const { svc, paymentGrpc } = make({ owner: { passengerId: 'usr-1' } });
    const view = await svc.getPayment(user, 'pay-1');
    expect(view.id).toBe('pay-1');
    expect(paymentGrpc.call).toHaveBeenCalledWith('GetPayment', { id: 'pay-1' }, expect.anything());
  });

  it('404 si el pago es de OTRO pasajero (anti-IDOR; no resuelve la vista por gRPC)', async () => {
    const { svc, paymentGrpc } = make({ owner: { passengerId: 'otro' } });
    await expect(svc.getPayment(user, 'pay-1')).rejects.toMatchObject({ httpStatus: 404 });
    expect(paymentGrpc.call).not.toHaveBeenCalled();
  });

  it('404 si el pago no existe (REST 404 → anti-enumeración)', async () => {
    const { svc, paymentGrpc } = make({ restThrows: true });
    await expect(svc.getPayment(user, 'pay-1')).rejects.toMatchObject({ httpStatus: 404 });
    expect(paymentGrpc.call).not.toHaveBeenCalled();
  });
});
