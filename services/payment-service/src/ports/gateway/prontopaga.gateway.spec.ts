/**
 * Tests del adapter ProntoPaga centrados en el CONTRATO HTTP que cambió con la doc oficial:
 *  - charge on-file usa `wallet_uid` (snake_case) en /payment/new — distinto del walletUID de /subscription.
 *  - createYapeSubscription en origin=MOBILE OMITE phoneNumber; en WEB lo manda.
 *  - showYapeSubscription / cancelYapeSubscription pegan a las rutas correctas.
 * El cliente HTTP del adapter (undici dedicado, ProntoPagaHttpClient) se inyecta mockeado (sin red):
 * inspeccionamos el body firmado que viaja al proveedor a nivel de dispatcher.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ExternalServiceError, GatewayCapabilityUnavailableError } from '@veo/utils';
import { ProntoPagaGateway } from './prontopaga.gateway';
import type {
  ProntoPagaHttpClient,
  ProntoPagaHttpRequest,
} from './prontopaga.http-client';

const OPTS = {
  baseUrl: 'https://sandbox.prontopaga.com',
  secretKey: 'sk_test',
  apiToken: 'tok_static',
  webhookBaseUrl: 'http://localhost:3005',
};

interface Call { url: string; method?: string; body: Record<string, unknown>; headers: Record<string, string> }

/**
 * Mock del ProntoPagaHttpClient: captura requests y devuelve un JSON fijo con status configurable.
 * Reemplaza al viejo stub de `fetch` global — ahora testeamos a nivel del dispatcher inyectado.
 */
function mockHttp(response: Record<string, unknown> = { uid: 'x' }, status = 200) {
  const calls: Call[] = [];
  const client: ProntoPagaHttpClient = {
    send: vi.fn(async (req: ProntoPagaHttpRequest) => {
      calls.push({
        url: req.url,
        method: req.method,
        body: req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {},
        headers: req.headers,
      });
      const text = JSON.stringify(response);
      return { status, text: async () => text };
    }),
  };
  return { client, calls };
}

describe('ProntoPagaGateway · contrato HTTP', () => {
  let gateway: ProntoPagaGateway;
  let setClient: (response?: Record<string, unknown>, status?: number) => Call[];

  beforeEach(() => {
    // Cada test arma su gateway con el cliente mock que necesite (el último seteado gana).
    setClient = (response, status) => {
      const { client, calls } = mockHttp(response ?? { uid: 'x' }, status ?? 200);
      gateway = new ProntoPagaGateway(OPTS, client);
      return calls;
    };
    gateway = new ProntoPagaGateway(OPTS, mockHttp().client);
  });
  afterEach(() => vi.restoreAllMocks());

  it('charge on-file manda `wallet_uid` (snake_case), NO `walletUID`', async () => {
    const calls = setClient({ uid: 'tx-1' });
    await gateway.charge({
      paymentId: 'pay-1',
      tripId: 'trip-1',
      amountCents: 1500,
      method: 'YAPE',
      walletUid: 'WUID-XYZ',
    });
    const body = calls.find((c) => c.url.endsWith('/api/payment/new'))!.body;
    expect(body.wallet_uid).toBe('WUID-XYZ');
    expect(body).not.toHaveProperty('walletUID');
    expect(body).not.toHaveProperty('walletUid');
  });

  it('createYapeSubscription MOBILE OMITE phoneNumber del body', async () => {
    const calls = setClient({ uid: 'WUID-1', status: 'PROCESS', deepLink: 'yape://x' });
    await gateway.createYapeSubscription({
      origin: 'MOBILE',
      document: '12345678',
      clientDocumentType: 'DN',
      phoneNumber: '999881234',
      clientName: 'Juan',
      type: 'RECURRENT',
    });
    const body = calls.find((c) => c.url.endsWith('/api/payment/yape/subscription'))!.body;
    expect(body).not.toHaveProperty('phoneNumber');
    expect(body.origin).toBe('MOBILE');
  });

  it('createYapeSubscription WEB SÍ manda phoneNumber', async () => {
    const calls = setClient({ uid: 'WUID-1' });
    await gateway.createYapeSubscription({
      origin: 'WEB',
      document: '12345678',
      clientDocumentType: 'DN',
      phoneNumber: '999881234',
      clientName: 'Juan',
      type: 'RECURRENT',
    });
    const body = calls.find((c) => c.url.endsWith('/api/payment/yape/subscription'))!.body;
    expect(body.phoneNumber).toBe('999881234');
  });

  it('showYapeSubscription pega a /subscription/{walletUID}/show', async () => {
    const calls = setClient({ uid: 'WUID-1', status: 'ACCEPTED', phoneNumber: '999881234' });
    const detail = await gateway.showYapeSubscription('WUID-1');
    expect(detail.status).toBe('ACCEPTED');
    expect(calls.some((c) => c.url.endsWith('/api/payment/yape/subscription/WUID-1/show'))).toBe(true);
  });

  it('cancelYapeSubscription pega a /subscription/cancel/{walletUID}', async () => {
    const calls = setClient({ message: 'ok' });
    await gateway.cancelYapeSubscription('WUID-1');
    expect(calls.some((c) => c.url.endsWith('/api/payment/yape/subscription/cancel/WUID-1'))).toBe(true);
  });

  // ── Shape REAL del sandbox (confirmado por smoke 2026-06-07) ──

  it('charge YAPE sin walletUid → paymentMethod yape_oneshot_payment + origin MOBILE', async () => {
    const calls = setClient({ uid: 'tx-y', yape: { deepLink: 'yape://x' } });
    await gateway.charge({ paymentId: 'p', tripId: 't', amountCents: 3600, method: 'YAPE' });
    const body = calls.find((c) => c.url.endsWith('/api/payment/new'))!.body;
    expect(body.paymentMethod).toBe('yape_oneshot_payment');
    expect(body.origin).toBe('mobile');
  });

  it('charge CARD NO manda origin (solo yape_oneshot lo exige)', async () => {
    const calls = setClient({ uid: 'tx-c', urlPay: 'https://pp/x' });
    await gateway.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'CARD' });
    const body = calls.find((c) => c.url.endsWith('/api/payment/new'))!.body;
    expect(body.paymentMethod).toBe('pe_card_payment');
    expect(body).not.toHaveProperty('origin');
  });

  it('charge lee el deepLink ANIDADO en `yape.deepLink` (yape_oneshot del sandbox real)', async () => {
    setClient({
      uid: '01KTH60XTWA40Q23ED1WE7V40Z',
      reference: '17808406915474',
      status: 'created',
      yape: { id: '1bf9fc6c', deepLink: 'yapeapp:oneshot/v1/opt1.js?consentId=abc&partnerCode=SANDBOX' },
    });
    const res = await gateway.charge({ paymentId: 'pay-y', tripId: 't', amountCents: 1000, method: 'YAPE' });
    expect(res.status).toBe('PENDING_EXTERNAL');
    expect(res.externalRef).toBe('01KTH60XTWA40Q23ED1WE7V40Z');
    expect(res.checkout?.deepLink).toBe('yapeapp:oneshot/v1/opt1.js?consentId=abc&partnerCode=SANDBOX');
  });

  it('charge sigue leyendo deepLink top-level si el método lo trae así (compat)', async () => {
    setClient({ uid: 'tx-top', deepLink: 'yape://top-level', urlPay: 'https://pp/x' });
    const res = await gateway.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'YAPE' });
    expect(res.checkout?.deepLink).toBe('yape://top-level');
    expect(res.checkout?.urlPay).toBe('https://pp/x');
  });

  it('charge mapea `cip` (pe_service_payment / PagoEfectivo del sandbox real)', async () => {
    setClient({ uid: '01KTH5ZK12BGNVFF2N6KFJZGN7', reference: '17808406472800', cip: '57529129', urlPay: 'https://pp/cip' });
    const res = await gateway.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'PAGOEFECTIVO' });
    expect(res.checkout?.cip).toBe('57529129');
  });

  it('getPaymentStatus: GET /api/payment/data/{uid} sin firma de body, mapea status real', async () => {
    const calls = setClient({ uid: 'U1', status: 'success', order: 'pay-1' });
    const detail = await gateway.getPaymentStatus('U1');
    const call = calls.find((c) => c.url.endsWith('/api/payment/data/U1'))!;
    expect(call.method).toBe('GET');
    expect(call.body).not.toHaveProperty('sign'); // GET: cuerpo no firmado
    expect(detail).toEqual({ found: true, status: 'CONFIRMED', rawStatus: 'success' });
  });

  it('getPaymentStatus mapea estados crudos del sandbox: new/created/pending → PENDING', async () => {
    for (const raw of ['new', 'created', 'pending']) {
      setClient({ uid: 'U', status: raw });
      const d = await gateway.getPaymentStatus('U');
      expect(d).toEqual({ found: true, status: 'PENDING', rawStatus: raw });
    }
  });

  it('getPaymentStatus mapea rejected→DECLINED y expired→EXPIRED', async () => {
    setClient({ uid: 'U', status: 'rejected' });
    expect((await gateway.getPaymentStatus('U')).status).toBe('DECLINED');
    setClient({ uid: 'U', status: 'expired' });
    expect((await gateway.getPaymentStatus('U')).status).toBe('EXPIRED');
  });

  it('getPaymentStatus: uid inexistente devuelve HTTP 200 {error} → found=false (no 404)', async () => {
    setClient({ error: 'payment not found.' });
    const detail = await gateway.getPaymentStatus('NOPE');
    expect(detail).toEqual({ found: false, status: 'PENDING' });
  });

  // ── Clasificación de transporte (cliente undici dedicado) ──

  /** Cliente que devuelve un body de texto crudo con el status dado (challenge HTML, etc.). */
  function rawClient(status: number, text: string): ProntoPagaHttpClient {
    return { send: vi.fn(async () => ({ status, text: async () => text })) };
  }

  it('charge: 403 con HTML de Cloudflare → error REINTENTABLE (failureReason explícito)', async () => {
    const g = new ProntoPagaGateway(
      OPTS,
      rawClient(403, '<!DOCTYPE html><title>Just a moment...</title>Attention Required! | Cloudflare'),
    );
    await expect(
      g.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'YAPE' }),
    ).rejects.toThrow(/Cloudflare.*reintentable/);
  });

  it('charge: 403 SIN HTML de Cloudflare → error de auth (no se confunde con CF)', async () => {
    const g = new ProntoPagaGateway(OPTS, rawClient(403, '{"error":"invalid token"}'));
    await expect(
      g.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'YAPE' }),
    ).rejects.toThrow(/rechazó la autenticación/);
  });

  it('charge: 5xx del proveedor → ExternalServiceError con el status', async () => {
    const g = new ProntoPagaGateway(OPTS, rawClient(502, 'bad gateway'));
    await expect(
      g.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'YAPE' }),
    ).rejects.toThrow(/respondió 502/);
  });

  it('charge: fallo de transporte (cliente lanza) → "No se pudo contactar ProntoPaga"', async () => {
    const client: ProntoPagaHttpClient = {
      send: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    };
    const g = new ProntoPagaGateway(OPTS, client);
    await expect(
      g.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'YAPE' }),
    ).rejects.toThrow(/No se pudo contactar ProntoPaga/);
  });

  // ── Clasificación de CAPACIDAD no habilitada (NO reintentable) vs CF-403 (reintentable) ──

  it('afiliación: 400 "not enabled for commerce" → GatewayCapabilityUnavailableError (capability YAPE_ON_FILE)', async () => {
    const g = new ProntoPagaGateway(
      OPTS,
      rawClient(400, '{"message":"The payment gateway is not enabled for commerce."}'),
    );
    await expect(
      g.createYapeSubscription({
        origin: 'MOBILE',
        document: '12345678',
        clientDocumentType: 'DN',
        clientName: 'Juan',
        type: 'RECURRENT',
      }),
    ).rejects.toBeInstanceOf(GatewayCapabilityUnavailableError);

    // El error tipado lleva la capability en details (la app la usa para el mensaje honesto).
    try {
      await g.createYapeSubscription({
        origin: 'MOBILE',
        document: '12345678',
        clientDocumentType: 'DN',
        clientName: 'Juan',
        type: 'RECURRENT',
      });
      expect.unreachable('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayCapabilityUnavailableError);
      const e = err as GatewayCapabilityUnavailableError;
      expect(e.code).toBe('GATEWAY_CAPABILITY_UNAVAILABLE');
      expect(e.httpStatus).toBe(422);
      expect(e.details?.capability).toBe('YAPE_ON_FILE');
    }
  });

  it('afiliación: 400 "gateway is not enabled" (variante) → también capability error', async () => {
    const g = new ProntoPagaGateway(
      OPTS,
      rawClient(400, '{"message":"The payment gateway is not enabled."}'),
    );
    await expect(
      g.createYapeSubscription({
        origin: 'MOBILE',
        document: '12345678',
        clientDocumentType: 'DN',
        clientName: 'Juan',
        type: 'RECURRENT',
      }),
    ).rejects.toBeInstanceOf(GatewayCapabilityUnavailableError);
  });

  it('CF-403 NO se confunde con capability: sigue siendo error REINTENTABLE de Cloudflare', async () => {
    const g = new ProntoPagaGateway(
      OPTS,
      rawClient(403, '<!DOCTYPE html><title>Just a moment...</title>Attention Required! | Cloudflare'),
    );
    // CF-403 → ExternalServiceError reintentable, NUNCA GatewayCapabilityUnavailableError.
    await expect(
      g.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'YAPE' }),
    ).rejects.toThrow(/Cloudflare.*reintentable/);
    await expect(
      g.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'YAPE' }),
    ).rejects.not.toBeInstanceOf(GatewayCapabilityUnavailableError);
  });

  it('400 genérico (otro mensaje) NO es capability: sigue ExternalServiceError', async () => {
    const g = new ProntoPagaGateway(OPTS, rawClient(400, '{"message":"invalid amount"}'));
    await expect(
      g.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'YAPE' }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  // ── COBRO: clasificación HONESTA del fallo en charge (failureKind) ──
  // En el path de COBRO el 400 "not enabled" NO se propaga como excepción: charge devuelve un DECLINE
  // TIPADO (failureKind=capability_unavailable) para que el dominio escriba un failureReason por-método.

  it('charge: 400 "not enabled for commerce" → DECLINED failureKind=capability_unavailable (NO lanza)', async () => {
    const g = new ProntoPagaGateway(
      OPTS,
      rawClient(400, '{"message":"The payment gateway is not enabled for commerce."}'),
    );
    const res = await g.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'PAGOEFECTIVO' });
    expect(res.status).toBe('DECLINED');
    expect(res.failureKind).toBe('capability_unavailable');
  });

  it('charge: 400 "gateway is not enabled" (variante) → también capability_unavailable', async () => {
    const g = new ProntoPagaGateway(OPTS, rawClient(400, '{"message":"The payment gateway is not enabled."}'));
    const res = await g.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'PLIN' });
    expect(res.status).toBe('DECLINED');
    expect(res.failureKind).toBe('capability_unavailable');
  });

  it('charge: 400 "paymentMethod, not available for this commerce" (sandbox REAL PLIN) → capability_unavailable', async () => {
    // Wording CONFIRMADO contra el sandbox público (2026-06-07) para pe_qr_3_payment (PLIN): distinto del
    // de afiliación; antes de este fix caía como ExternalServiceError genérico → failureReason crudo.
    const g = new ProntoPagaGateway(
      OPTS,
      rawClient(400, '{"error":{"paymentMethod":"paymentMethod, not available for this commerce."}}'),
    );
    const res = await g.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'PLIN' });
    expect(res.status).toBe('DECLINED');
    expect(res.failureKind).toBe('capability_unavailable');
  });

  it('charge: PENDING_EXTERNAL normal NO trae failureKind (no hubo fallo)', async () => {
    setClient({ uid: 'u1', urlPay: 'https://pay' });
    const res = await gateway.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'CARD' });
    expect(res.status).toBe('PENDING_EXTERNAL');
    expect(res.failureKind).toBeUndefined();
  });

  it('charge: sin uid → DECLINED normal (declined), SIN failureKind capability', async () => {
    setClient({ message: 'rechazado' });
    const res = await gateway.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'YAPE' });
    expect(res.status).toBe('DECLINED');
    expect(res.failureKind).toBeUndefined();
  });

  it('charge: 5xx (transient) SIGUE relanzando ExternalServiceError (lo reintenta el dominio)', async () => {
    const g = new ProntoPagaGateway(OPTS, rawClient(503, 'unavailable'));
    await expect(
      g.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'YAPE' }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('charge: fallo de red SIGUE relanzando (transient, no capability)', async () => {
    const client: ProntoPagaHttpClient = {
      send: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    };
    const g = new ProntoPagaGateway(OPTS, client);
    await expect(
      g.charge({ paymentId: 'p', tripId: 't', amountCents: 1000, method: 'YAPE' }),
    ).rejects.toThrow(/No se pudo contactar ProntoPaga/);
  });
});

describe('ProntoPagaGateway · refund (S5 · reverso REAL contra el proveedor)', () => {
  it('refund: POST firmado a /api/reverse/new con amount decimal, reference y callback DEDICADO /refund', async () => {
    const { client, calls } = mockHttp({ uid: 'rev-1', status: 'pending' });
    const g = new ProntoPagaGateway(OPTS, client);

    const res = await g.refund('tx-abc', 12_50, { idempotencyKey: 'refund-r1' });

    const call = calls.find((c) => c.url.endsWith('/api/reverse/new'))!;
    expect(call.body.amount).toBe('12.50');
    expect(call.body.reference).toBe('tx-abc');
    // La RUTA clasifica el callback como reverso (el payload no trae marcador de tipo confiable).
    expect(call.body.urlCallbackRefund).toBe('http://localhost:3005/api/v1/webhooks/prontopaga/refund');
    // ProntoPaga no documenta campo de idempotencia: la key NO viaja al proveedor.
    expect(call.body).not.toHaveProperty('idempotencyKey');
    // El reverso es ASÍNCRONO: aceptado a la espera del callback, con el uid para correlacionar.
    expect(res).toEqual({ status: 'PENDING', externalRefundId: 'rev-1' });
  });

  it('refund: rechazo REAL del proveedor (status rejected) → REJECTED con motivo', async () => {
    const { client } = mockHttp({ uid: 'rev-2', status: 'rejected', message: 'monto excede el cobro' });
    const g = new ProntoPagaGateway(OPTS, client);

    const res = await g.refund('tx-abc', 1000);

    expect(res.status).toBe('REJECTED');
    expect(res.reason).toBe('monto excede el cobro');
  });

  it('refund: fallo de RED relanza (timeout ≠ falla §4) — NUNCA degrada a REJECTED', async () => {
    const client: ProntoPagaHttpClient = {
      send: vi.fn(async () => {
        throw new Error('ETIMEDOUT');
      }),
    };
    const g = new ProntoPagaGateway(OPTS, client);

    await expect(g.refund('tx-abc', 1000)).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('refund: 5xx del proveedor relanza (transitorio: el Refund del dominio queda PENDING)', async () => {
    const client: ProntoPagaHttpClient = {
      send: vi.fn(async () => ({ status: 503, text: async () => 'unavailable' })),
    };
    const g = new ProntoPagaGateway(OPTS, client);

    await expect(g.refund('tx-abc', 1000)).rejects.toBeInstanceOf(ExternalServiceError);
  });
});
