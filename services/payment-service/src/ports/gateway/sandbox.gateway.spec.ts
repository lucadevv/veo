import { describe, it, expect } from 'vitest';
import { UnauthorizedError } from '@veo/utils';
import { SandboxPaymentGateway } from './sandbox.gateway';

const SECRET = 'dev-sandbox-webhook-secret';

function gw(opts?: Partial<ConstructorParameters<typeof SandboxPaymentGateway>[0]>) {
  return new SandboxPaymentGateway({
    confirmDelayMs: 0,
    declineSuffix: '0000',
    webhookSecret: SECRET,
    ...opts,
  });
}

describe('SandboxPaymentGateway · charge', () => {
  it('confirma síncrono por default', async () => {
    const r = await gw().charge({
      paymentId: 'p1',
      tripId: 't1',
      amountCents: 1000,
      method: 'YAPE',
    });
    expect(r.status).toBe('CONFIRMED');
    expect(r.externalRef).toContain('p1');
  });

  it('declina determinista si payerRef termina en el sufijo', async () => {
    const r = await gw().charge({
      paymentId: 'p2',
      tripId: 't1',
      amountCents: 1000,
      method: 'YAPE',
      payerRef: '9990000',
    });
    expect(r.status).toBe('DECLINED');
  });

  it('modo pendingExternal → PENDING_EXTERNAL con checkout (QR) sin walletUid', async () => {
    const r = await gw({ pendingExternal: true }).charge({
      paymentId: 'p3',
      tripId: 't1',
      amountCents: 1500,
      method: 'YAPE',
    });
    expect(r.status).toBe('PENDING_EXTERNAL');
    expect(r.externalRef).toBeTruthy();
    expect(r.checkout?.qrCodeBase64).toContain('data:image/png;base64,');
  });

  it('modo pendingExternal + walletUid → on-file CONFIRMED síncrono (sin checkout)', async () => {
    // On-file (Yape afiliado) es server-initiated: NO requiere aprobación del usuario, así que se captura
    // al instante aun en modo pendingExternal (que solo aplica al one-shot con QR). Hace testeable el pago
    // AUTOMÁTICO end-to-end sin webhook.
    const r = await gw({ pendingExternal: true }).charge({
      paymentId: 'p4',
      tripId: 't1',
      amountCents: 1500,
      method: 'YAPE',
      walletUid: 'W1',
    });
    expect(r.status).toBe('CONFIRMED');
    expect(r.externalRef).toBeTruthy();
    expect(r.checkout).toBeUndefined();
  });

  it('YapeSubscriber: createYapeSubscription → uid + deepLink (PROCESS); showYapeSubscription → ACCEPTED', async () => {
    const { supportsYapeSubscription } = await import('./payment-gateway.port');
    const g = gw({ pendingExternal: true });
    expect(supportsYapeSubscription(g)).toBe(true);
    const sub = await g.createYapeSubscription({
      origin: 'MOBILE',
      document: '12345678',
      clientDocumentType: 'DN',
      clientName: 'Test',
      type: 'RECURRENT',
    });
    expect(sub.uid).toBeTruthy();
    // SIN deepLink a propósito: el sandbox no tiene app Yape que aprobar (el /show auto-acepta).
    expect(sub.deepLink).toBeUndefined();
    expect(sub.status).toBe('PROCESS');
    // El /show resuelve ACCEPTED → el dominio pasa la afiliación a ACTIVE sin webhook real.
    const detail = await g.showYapeSubscription(sub.uid!);
    expect(detail.status).toBe('ACCEPTED');
    expect(detail.phoneNumber).toBeTruthy();
  });
});

describe('SandboxPaymentGateway · verifyWebhook (firma timing-safe)', () => {
  it('acepta un webhook firmado con el secret del adapter', () => {
    const g = gw();
    const { body } = g.buildSignedWebhook({ uid: 'tx-1', order: 'pay-1', status: 'success' });
    const r = g.verifyWebhook(body);
    expect(r.kind).toBe('payment');
    expect(r.status).toBe('CONFIRMED');
    expect(r.order).toBe('pay-1');
  });

  it('rechaza un webhook con firma inválida (401)', () => {
    const g = gw();
    const body = JSON.stringify({
      uid: 'tx-1',
      order: 'pay-1',
      status: 'success',
      sign: 'firma-mala',
    });
    expect(() => g.verifyWebhook(body)).toThrow(UnauthorizedError);
  });

  it('rechaza un webhook con el cuerpo manipulado tras firmar', () => {
    const g = gw();
    const { body } = g.buildSignedWebhook({ uid: 'tx-1', order: 'pay-1', status: 'success' });
    const parsed = JSON.parse(body) as Record<string, unknown>;
    parsed.status = 'success-TAMPERED';
    expect(() => g.verifyWebhook(JSON.stringify(parsed))).toThrow(UnauthorizedError);
  });

  it('rechaza un body que no es JSON', () => {
    expect(() => gw().verifyWebhook('no-json')).toThrow(UnauthorizedError);
  });
});

describe('SandboxPaymentGateway · refund (S5 · capacidad Refundable)', () => {
  it('supportsRefund detecta la capacidad en el adapter sandbox', async () => {
    const { supportsRefund } = await import('./payment-gateway.port');
    expect(supportsRefund(gw())).toBe(true);
  });

  it('acepta SÍNCRONO y determinista, con id derivado de la idempotency key', async () => {
    const r = await gw().refund('sbx_yape_p1', 1000, { idempotencyKey: 'refund-r1' });
    expect(r.status).toBe('ACCEPTED');
    expect(r.externalRefundId).toBe('sbx_refund_refund-r1');
  });

  it('es idempotente: re-llamar con la MISMA key devuelve el MISMO reverso', async () => {
    const g = gw();
    const first = await g.refund('sbx_yape_p1', 1000, { idempotencyKey: 'refund-r1' });
    const second = await g.refund('sbx_yape_p1', 1000, { idempotencyKey: 'refund-r1' });
    expect(second.externalRefundId).toBe(first.externalRefundId);
  });
});
