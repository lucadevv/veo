/**
 * Gate de ownership (anti-IDOR) de confirmCash: el caller (identidad firmada) DEBE ser el party que dice
 * ser. Solo se ejercitan los caminos de RECHAZO (tiran antes de tocar gateway/outbox), que es la regla
 * nueva. 404 anti-enumeración (mismo criterio que el resto de payments).
 */
import { describe, it, expect, vi } from 'vitest';
import { NotFoundError } from '@veo/utils';
import { PaymentsService } from './payments.service';

const PAYMENT = {
  id: 'pay-1',
  tripId: 'trip-1',
  method: 'CASH',
  driverId: 'drv-1',
  passengerId: 'pax-1',
};

function buildService(payment: unknown) {
  const prisma = {
    read: { payment: { findUnique: vi.fn(async () => payment) } },
    write: { cashConfirmation: { upsert: vi.fn() } },
  };
  // El constructor solo lee números/strings de config; el gate de rechazo no usa gateway/affiliations.
  const config = { getOrThrow: () => 0 };
  return new PaymentsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    config as never,
  );
}

describe('PaymentsService.confirmCash · ownership (anti-IDOR)', () => {
  it('rechaza (404) si el caller no es ni el conductor ni el pasajero del pago', async () => {
    const svc = buildService(PAYMENT);
    await expect(svc.confirmCash('pay-1', 'OTRO-user', 'passenger', true)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rechaza si dice ser driver pero el caller es el passenger del pago', async () => {
    const svc = buildService(PAYMENT);
    await expect(svc.confirmCash('pay-1', 'pax-1', 'driver', true)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('404 si el pago no existe (sin filtrar existencia)', async () => {
    const svc = buildService(null);
    await expect(svc.confirmCash('nope', 'pax-1', 'passenger', true)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
