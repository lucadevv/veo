/**
 * Spec del adapter REST FIRMADO del puerto PaymentGateway (charge + getDebt · ADR-014 §5.5). Mockea
 * `globalThis.fetch` (el InternalRestClient lo usa por default) y verifica el CONTRATO HTTP real: path, body
 * (dinero en Int céntimos), dedupKey DETERMINISTA (booking-charge:{bookingId}) como Idempotency-Key, la
 * identidad FIRMADA con audiencia service-rail, el mapeo del DebtSummary, y la degradación a
 * ExternalServiceError ante non-2xx y timeout. Espeja el estilo de share-service notification-sms-sender.spec.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalServiceError } from '@veo/utils';
import {
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  verifyInternalIdentity,
} from '@veo/auth';
import { PaymentMethod, PaymentStatus } from '@veo/shared-types';
import { RestPaymentGateway } from './rest-payment-gateway';
import { ChargePermanentlyRejectedError } from '../../domain/payment-charge';

const SECRET = 'test-internal-secret';
const BASE_URL = 'http://payment.local/api/v1';
const BOOKING_ID = '00000000-0000-0000-0000-0000000000a1';
const PASSENGER_ID = '00000000-0000-0000-0000-0000000000c1';

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const impl = vi.fn(async () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
  return impl;
}

describe('RestPaymentGateway (booking-service)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('charge: POSTea /payments/charge con tripId=bookingId, grossCents Int y dedupKey determinista', async () => {
    const fetchSpy = stubFetch(200, { id: 'pay_1', status: PaymentStatus.PENDING });
    const gw = new RestPaymentGateway(BASE_URL, SECRET);

    const res = await gw.charge({
      bookingId: BOOKING_ID,
      grossCents: 5000,
      method: PaymentMethod.YAPE,
      passengerId: PASSENGER_ID,
    });

    expect(res).toEqual({ paymentId: 'pay_1', status: PaymentStatus.PENDING });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://payment.local/api/v1/payments/charge');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // tripId = bookingId (UUID opaco); userId = passengerId; dinero en Int céntimos.
    expect(body).toMatchObject({
      tripId: BOOKING_ID,
      userId: PASSENGER_ID,
      grossCents: 5000,
      method: PaymentMethod.YAPE,
      dedupKey: `booking-charge:${BOOKING_ID}`,
    });
    // Idempotency-Key = la MISMA dedupKey determinista (un reintento no duplica el cobro).
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe(`booking-charge:${BOOKING_ID}`);
  });

  it('charge: firma la identidad interna con audiencia service-rail (lo que payment verifica)', async () => {
    const fetchSpy = stubFetch(200, { id: 'pay_1', status: PaymentStatus.PENDING });
    const gw = new RestPaymentGateway(BASE_URL, SECRET);

    await gw.charge({
      bookingId: BOOKING_ID,
      grossCents: 5000,
      method: PaymentMethod.YAPE,
      passengerId: PASSENGER_ID,
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const identity = verifyInternalIdentity(
      headers[INTERNAL_IDENTITY_HEADER]!,
      headers[INTERNAL_IDENTITY_SIG_HEADER]!,
      SECRET,
    );
    expect(identity).not.toBeNull();
    // Lo que GATEA la llamada es la audiencia de riel de SISTEMA (per-endpoint en payment).
    expect(identity?.aud).toBe('service-rail');
  });

  it('getDebt: GETea /payments/debt y mapea el DebtSummary (debts → items)', async () => {
    const fetchSpy = stubFetch(200, {
      hasDebt: true,
      totalCents: 1500,
      debts: [
        {
          paymentId: 'pay_dbt',
          tripId: 't9',
          amountCents: 1500,
          reason: 'declined',
          createdAt: '2026-06-22T00:00:00.000Z',
          kind: 'DEBT',
        },
      ],
    });
    const gw = new RestPaymentGateway(BASE_URL, SECRET);

    const summary = await gw.getDebt(PASSENGER_ID);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // EL passengerId DEBE viajar al wire como query param (on-behalf-of). Sin esto payment resolvía la
    // deuda de 'anonymous' (la identidad de sistema es anónima) → hasDebt:false SIEMPRE → gate NULO.
    // Verificamos el query EXPLÍCITAMENTE (no solo el path): es lo que el bug original NO probaba.
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v1/payments/debt');
    expect(parsed.searchParams.get('passengerId')).toBe(PASSENGER_ID);
    expect(init.method).toBe('GET');
    expect(summary.hasDebt).toBe(true);
    expect(summary.totalCents).toBe(1500);
    expect(summary.items).toEqual([
      {
        paymentId: 'pay_dbt',
        tripId: 't9',
        amountCents: 1500,
        reason: 'declined',
        createdAt: '2026-06-22T00:00:00.000Z',
      },
    ]);
  });

  it('getDebt: el passengerId LLEGA al wire (query param) — el deudor real es consultable, no anonymous', async () => {
    // Regresión del CRÍTICO F3a: el adapter recibía el passengerId pero NUNCA lo mandaba → payment
    // consultaba 'anonymous' → hasDebt:false SIEMPRE → gate de deuda estructuralmente NULO. Este test
    // CRISTALIZA que el passengerId viaja: si alguien lo vuelve a omitir, falla acá antes de prod.
    const fetchSpy = stubFetch(200, { hasDebt: false, totalCents: 0, debts: [] });
    const gw = new RestPaymentGateway(BASE_URL, SECRET);

    await gw.getDebt(PASSENGER_ID);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.get('passengerId')).toBe(PASSENGER_ID);
    // Y sigue firmado service-rail (lo que payment GATEA per-endpoint): el query es ON-BEHALF-OF, no auth.
    const headers = init.headers as Record<string, string>;
    const identity = verifyInternalIdentity(
      headers[INTERNAL_IDENTITY_HEADER]!,
      headers[INTERNAL_IDENTITY_SIG_HEADER]!,
      SECRET,
    );
    expect(identity?.aud).toBe('service-rail');
  });

  it('charge: 5xx de payment → ExternalServiceError (502 TRANSITORIO, re-ejecutable)', async () => {
    stubFetch(502, { code: 'EXTERNAL', message: 'upstream down' });
    const gw = new RestPaymentGateway(BASE_URL, SECRET);

    await expect(
      gw.charge({
        bookingId: BOOKING_ID,
        grossCents: 5000,
        method: PaymentMethod.YAPE,
        passengerId: PASSENGER_ID,
      }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('charge: 4xx PERMANENTE (422 método inválido) → ChargePermanentlyRejectedError (NO ExternalServiceError → NO loop)', async () => {
    // CAUSA RAÍZ del FIX 3: antes el adapter COLAPSABA este 4xx en un ExternalServiceError "reintentable" → el
    // booking quedaba APROBADO → re-approve → misma dedupKey → mismo rechazo → LOOP. Ahora se clasifica PERMANENTE.
    stubFetch(422, { error: { code: 'PAYMENT_METHOD_INVALID', message: 'método inválido' } });
    const gw = new RestPaymentGateway(BASE_URL, SECRET);

    const err = await gw
      .charge({
        bookingId: BOOKING_ID,
        grossCents: 5000,
        method: PaymentMethod.YAPE,
        passengerId: PASSENGER_ID,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChargePermanentlyRejectedError);
    // NO debe ser un ExternalServiceError (eso reintentaría → loop).
    expect(err).not.toBeInstanceOf(ExternalServiceError);
  });

  it('charge: 429/408 son TRANSITORIOS (no permanentes) → ExternalServiceError (reintentar puede prender)', async () => {
    for (const status of [429, 408]) {
      stubFetch(status, { error: { code: 'RATE_LIMIT', message: 'slow down' } });
      const gw = new RestPaymentGateway(BASE_URL, SECRET);
      const err = await gw
        .charge({
          bookingId: BOOKING_ID,
          grossCents: 5000,
          method: PaymentMethod.YAPE,
          passengerId: PASSENGER_ID,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExternalServiceError);
      expect(err).not.toBeInstanceOf(ChargePermanentlyRejectedError);
      vi.restoreAllMocks();
    }
  });

  it('getDebt: timeout/red caída → ExternalServiceError (502 reintentable)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const gw = new RestPaymentGateway(BASE_URL, SECRET, 5);

    await expect(gw.getDebt(PASSENGER_ID)).rejects.toBeInstanceOf(ExternalServiceError);
  });
});
