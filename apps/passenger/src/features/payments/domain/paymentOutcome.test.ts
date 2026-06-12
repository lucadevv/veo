import type { PaymentView } from '@veo/api-client';
import {
  assertNever,
  hasCheckout,
  interpretPaymentOutcome,
  isCashPayment,
  isPaymentSettled,
  type PaymentOutcome,
} from './paymentOutcome';

/**
 * Especificación del intérprete de DOMINIO del cobro: la matriz status × método × checkout completa.
 * Es el contrato que la presentación (SettlementBody / DebtSheet / PaymentScreen) consume vía
 * `PaymentOutcome`: si un `PaymentStatus` nuevo aparece, el switch tipado revienta en compile-time
 * (la lección de PARTIALLY_REFUNDED, que caía silencioso al recibo "Pagado").
 */

/** Cobro base del wire: digital (YAPE), sin checkout, sin fallo. Cada caso pisa lo suyo. */
function makePayment(overrides: Partial<PaymentView> = {}): PaymentView {
  return {
    id: 'pay-1',
    tripId: 'trip-1',
    method: 'YAPE',
    status: 'PENDING',
    amountCents: 1500,
    grossCents: 1500,
    tipCents: 0,
    commissionCents: 150,
    feeCents: 50,
    externalRef: 'ref-1',
    externalUid: null,
    checkoutUrl: null,
    qrCode: null,
    deepLink: null,
    cip: null,
    checkoutExpiresAt: null,
    failureReason: null,
    ...overrides,
  };
}

describe('interpretPaymentOutcome · matriz status × método × checkout', () => {
  it('CAPTURED → settled, sin importar el método', () => {
    for (const method of ['CASH', 'YAPE', 'CARD']) {
      expect(interpretPaymentOutcome(makePayment({ status: 'CAPTURED', method }))).toEqual({
        kind: 'settled',
      });
    }
  });

  it('PENDING + CASH → cashPending (la confirmación bilateral BR-P03, nunca checkout)', () => {
    expect(interpretPaymentOutcome(makePayment({ method: 'CASH' }))).toEqual({
      kind: 'cashPending',
    });
  });

  it('PENDING digital con checkout VIVO (externalUid + medio) → checkoutPending', () => {
    expect(
      interpretPaymentOutcome(
        makePayment({ externalUid: 'pp-uid-1', deepLink: 'yape://pay/abc' }),
      ),
    ).toEqual({ kind: 'checkoutPending' });
  });

  it('PENDING digital SIN checkout (sandbox / cobro en vuelo) → processing', () => {
    expect(interpretPaymentOutcome(makePayment())).toEqual({ kind: 'processing' });
  });

  it('PENDING digital con medios pero SIN externalUid → processing (espejo del server: no accionable)', () => {
    // payment-service exige `externalUid != null` ADEMÁS del medio para clasificar PENDING_ACTION:
    // un PENDING con medios huérfanos no es un checkout vivo y NO debe abrir "Completa tu pago".
    expect(
      interpretPaymentOutcome(makePayment({ externalUid: null, deepLink: 'yape://pay/abc' })),
    ).toEqual({ kind: 'processing' });
  });

  it('DEBT → debt con el failureReason ESTRUCTURADO del contrato', () => {
    expect(
      interpretPaymentOutcome(
        makePayment({ status: 'DEBT', failureReason: 'method_unavailable:PAGOEFECTIVO' }),
      ),
    ).toEqual({ kind: 'debt', failureReason: 'method_unavailable:PAGOEFECTIVO' });
  });

  it('DEBT sin razón informada → debt con failureReason null (honesto, sin inventar)', () => {
    expect(interpretPaymentOutcome(makePayment({ status: 'DEBT', failureReason: null }))).toEqual({
      kind: 'debt',
      failureReason: null,
    });
    // El contrato lo marca opcional (compat con backends viejos): ausente también es null.
    expect(
      interpretPaymentOutcome(makePayment({ status: 'DEBT', failureReason: undefined })),
    ).toEqual({ kind: 'debt', failureReason: null });
  });

  it('FAILED → failed (estado honesto terminal)', () => {
    expect(interpretPaymentOutcome(makePayment({ status: 'FAILED' }))).toEqual({ kind: 'failed' });
  });

  it('REFUNDED → refunded total; PARTIALLY_REFUNDED → refunded parcial (NUNCA "Pagado")', () => {
    expect(interpretPaymentOutcome(makePayment({ status: 'REFUNDED' }))).toEqual({
      kind: 'refunded',
      partial: false,
    });
    expect(interpretPaymentOutcome(makePayment({ status: 'PARTIALLY_REFUNDED' }))).toEqual({
      kind: 'refunded',
      partial: true,
    });
  });

  it('los 6 status del contrato están mapeados (ninguno cae a un kind ajeno)', () => {
    const expected: Record<PaymentView['status'], PaymentOutcome['kind']> = {
      PENDING: 'processing',
      CAPTURED: 'settled',
      FAILED: 'failed',
      REFUNDED: 'refunded',
      PARTIALLY_REFUNDED: 'refunded',
      DEBT: 'debt',
    };
    for (const status of Object.keys(expected) as PaymentView['status'][]) {
      expect(interpretPaymentOutcome(makePayment({ status })).kind).toBe(expected[status]);
    }
  });
});

describe('isCashPayment · normaliza el método UNA vez en el borde', () => {
  it('acepta el casing raro del wire (method es string laxo en el contrato)', () => {
    for (const method of ['CASH', 'cash', 'Cash']) {
      expect(isCashPayment(makePayment({ method }))).toBe(true);
    }
  });

  it('cualquier método digital → false', () => {
    for (const method of ['YAPE', 'PLIN', 'CARD', 'PAGOEFECTIVO']) {
      expect(isCashPayment(makePayment({ method }))).toBe(false);
    }
  });
});

describe('hasCheckout · cualquiera de los 4 medios habilita la rama', () => {
  it.each([
    ['deepLink', { deepLink: 'yape://pay/abc' }],
    ['checkoutUrl', { checkoutUrl: 'https://pago.example/abc' }],
    ['qrCode', { qrCode: 'data:image/png;base64,abc' }],
    ['cip', { cip: '12345678' }],
  ] as const)('con solo %s → true', (_medium, overrides) => {
    expect(hasCheckout(makePayment(overrides))).toBe(true);
  });

  it('sin NINGÚN medio (todos null) → false', () => {
    expect(hasCheckout(makePayment())).toBe(false);
  });
});

describe('isPaymentSettled · la pregunta de los polls', () => {
  it('solo CAPTURED corta el poll', () => {
    expect(isPaymentSettled(makePayment({ status: 'CAPTURED' }))).toBe(true);
    for (const status of [
      'PENDING',
      'FAILED',
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'DEBT',
    ] as const) {
      expect(isPaymentSettled(makePayment({ status }))).toBe(false);
    }
  });
});

describe('assertNever · el gate de exhaustividad en runtime', () => {
  it('lanza con el estado no contemplado en el mensaje', () => {
    // Solo un wire roto llega acá (el compilador sella los switch): se fuerza con un cast.
    expect(() => assertNever('PAID' as never)).toThrow('Estado de pago no contemplado: PAID');
  });

  it('un status fuera del contrato forzado en el wire revienta en runtime (no cae a un recibo falso)', () => {
    const broken = makePayment({ status: 'EXOTIC' as PaymentView['status'] });
    expect(() => interpretPaymentOutcome(broken)).toThrow('Estado de pago no contemplado: EXOTIC');
  });
});
