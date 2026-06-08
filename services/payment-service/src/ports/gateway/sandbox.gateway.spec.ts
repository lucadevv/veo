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
    const r = await gw().charge({ paymentId: 'p1', tripId: 't1', amountCents: 1000, method: 'YAPE' });
    expect(r.status).toBe('CONFIRMED');
    expect(r.externalRef).toContain('p1');
  });

  it('declina determinista si payerRef termina en el sufijo', async () => {
    const r = await gw().charge({ paymentId: 'p2', tripId: 't1', amountCents: 1000, method: 'YAPE', payerRef: '9990000' });
    expect(r.status).toBe('DECLINED');
  });

  it('modo pendingExternal → PENDING_EXTERNAL con checkout (QR) sin walletUid', async () => {
    const r = await gw({ pendingExternal: true }).charge({ paymentId: 'p3', tripId: 't1', amountCents: 1500, method: 'YAPE' });
    expect(r.status).toBe('PENDING_EXTERNAL');
    expect(r.externalRef).toBeTruthy();
    expect(r.checkout?.qrCodeBase64).toContain('data:image/png;base64,');
  });

  it('modo pendingExternal + walletUid → on-file sin checkout', async () => {
    const r = await gw({ pendingExternal: true }).charge({ paymentId: 'p4', tripId: 't1', amountCents: 1500, method: 'YAPE', walletUid: 'W1' });
    expect(r.status).toBe('PENDING_EXTERNAL');
    expect(r.checkout).toBeUndefined();
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
    const body = JSON.stringify({ uid: 'tx-1', order: 'pay-1', status: 'success', sign: 'firma-mala' });
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
