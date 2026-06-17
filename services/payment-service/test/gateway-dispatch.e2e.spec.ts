/**
 * Despacho por CAPACIDADES DECLARADAS del adapter · E2E con Postgres REAL (testcontainers) — NO se
 * mockea la DB en un crítico de dinero (CLAUDE).
 *
 * DOCUMENTA LA EXTENSIBILIDAD del puerto (ARQUITECTURA §4 / INTEGRACIONES §0): agregar un proveedor
 * = un adapter nuevo que DECLARA su flujo (`chargeFlow`) y su catálogo (`supports`) + cableado en la
 * factory. El PaymentsService despacha preguntándole al puerto — acá se inyectan DOS FakeGateway con
 * capacidades distintas y el MISMO service (cero ifs tocados, jamás mira VEO_PAYMENT_MODE) cobra por
 * el camino que cada adapter declara:
 *   - flow 'direct'     → riel síncrono: CONFIRMED captura en línea.
 *   - flow 'aggregator' → un intento asíncrono: PENDING_EXTERNAL persiste checkout y espera webhook.
 *   - método fuera del catálogo → el guard compartido (charge y settleCancellationPenalty) corta
 *     ANTES de tocar el riel o crear el Payment.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { InvalidStateError, uuidv7 } from '@veo/utils';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../src/generated/prisma';
import { PaymentsService } from '../src/payments/payments.service';
import type {
  PaymentGateway,
  GatewayChargeFlow,
  GatewayChargeRequest,
  GatewayChargeResult,
  GatewayPaymentMethod,
} from '../src/ports/gateway/payment-gateway.port';
import type { PrismaService } from '../src/infra/prisma.service';
import type { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PromotionsService } from '../src/promotions/promotions.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const PAX = '0192f8a0-0000-7000-8000-0000000000bb';

let db: TestDatabase;
let prisma: PrismaClient;

const noPromos = {
  redeemPromo: async () => ({ discountCents: 0 }),
} as unknown as PromotionsService;
const noAffiliation = {
  resolveActiveWalletUid: async () => null,
} as unknown as AffiliationsService;

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    COMMISSION_RATE: 0.2,
    PAYMENT_MAX_RETRIES: 3,
    PAYMENT_RETRY_BASE_MS: 1,
    DEFAULT_PAYMENT_METHOD: 'YAPE',
    REFUND_WINDOW_DAYS: 7,
    REFUND_L2_THRESHOLD_CENTS: 3000,
    CANCELLATION_DRIVER_SHARE: 0.5,
  };
  return {
    getOrThrow: (k: string) => values[k],
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

/**
 * FakeGateway con capacidades DECLARADAS inyectables: lo ÚNICO que cambia entre casos es lo que el
 * adapter declara (flujo + catálogo + result), nunca el service. Registra los charges recibidos para
 * poder afirmar "el riel NO se tocó" cuando el guard de catálogo corta antes.
 */
function fakeGateway(decl: {
  chargeFlow: GatewayChargeFlow;
  methods: readonly GatewayPaymentMethod[];
  result: GatewayChargeResult;
}): { gateway: PaymentGateway; calls: GatewayChargeRequest[] } {
  const calls: GatewayChargeRequest[] = [];
  const methods = new Set<GatewayPaymentMethod>(decl.methods);
  const gateway: PaymentGateway = {
    chargeFlow: decl.chargeFlow,
    supports: (method) => methods.has(method),
    charge: async (req) => {
      calls.push(req);
      return decl.result;
    },
    getStatement: async () => [],
  };
  return { gateway, calls };
}

function makeService(gateway: PaymentGateway): PaymentsService {
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  return new PaymentsService(
    prismaService,
    gateway,
    noAffiliation,
    noPromos,
    makeConfig() as never,
  );
}

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany({});
  await prisma.payment.deleteMany({});
});

describe('despacho polimórfico · el adapter DECLARA, el service pregunta (cero ifs por proveedor)', () => {
  it("adapter 'direct' (riel síncrono Yape/Plin): CONFIRMED captura en línea", async () => {
    const { gateway, calls } = fakeGateway({
      chargeFlow: 'direct',
      methods: ['YAPE', 'PLIN'],
      result: { status: 'CONFIRMED', externalRef: 'fake_direct_tx_1' },
    });
    const tripId = uuidv7();
    const out = await makeService(gateway).charge({
      tripId,
      grossCents: 2000,
      method: 'YAPE',
      dedupKey: `trip-completed:${tripId}`,
      userId: PAX,
    });
    expect(out.status).toBe('CAPTURED'); // flujo síncrono: el desenlace se conoce en línea
    expect(out.externalRef).toBe('fake_direct_tx_1');
    expect(calls).toHaveLength(1); // primer intento confirmó: sin reintentos
  });

  it("adapter 'aggregator' (asíncrono): PENDING_EXTERNAL persiste checkout y queda PENDING (espera webhook)", async () => {
    const { gateway, calls } = fakeGateway({
      chargeFlow: 'aggregator',
      methods: ['YAPE', 'PLIN', 'CARD', 'PAGOEFECTIVO'],
      result: {
        status: 'PENDING_EXTERNAL',
        externalRef: 'fake_aggr_uid_1',
        checkout: { urlPay: 'https://fake.local/pay/1' },
      },
    });
    const tripId = uuidv7();
    // CARD: un método que el riel directo NO habla — lo habilita el catálogo del agregador, sin
    // tocar una línea del service (extensibilidad por declaración, no por edición).
    const out = await makeService(gateway).charge({
      tripId,
      grossCents: 2000,
      method: 'CARD',
      dedupKey: `trip-completed:${tripId}`,
      userId: PAX,
    });
    expect(out.status).toBe('PENDING'); // un solo intento; el webhook/poll cierra el Payment
    expect(out.externalUid).toBe('fake_aggr_uid_1');
    expect(out.checkoutUrl).toBe('https://fake.local/pay/1');
    expect(calls).toHaveLength(1); // aggregator = UN intento, sin bucle de reintentos
  });

  it('método fuera del catálogo declarado → InvalidStateError SIN tocar el riel ni crear el Payment', async () => {
    const { gateway, calls } = fakeGateway({
      chargeFlow: 'direct',
      methods: ['YAPE', 'PLIN'], // el riel directo no habla CARD
      result: { status: 'CONFIRMED', externalRef: 'never' },
    });
    const tripId = uuidv7();
    await expect(
      makeService(gateway).charge({
        tripId,
        grossCents: 2000,
        method: 'CARD',
        dedupKey: `trip-completed:${tripId}`,
        userId: PAX,
      }),
    ).rejects.toBeInstanceOf(InvalidStateError);
    expect(calls).toHaveLength(0); // el guard corta ANTES del riel
    expect(await prisma.payment.count()).toBe(0); // y ANTES de persistir nada
  });

  it('settleCancellationPenalty comparte el MISMO guard de catálogo que charge (antes duplicado verbatim)', async () => {
    const { gateway, calls } = fakeGateway({
      chargeFlow: 'direct',
      methods: ['YAPE', 'PLIN'],
      result: { status: 'CONFIRMED', externalRef: 'never' },
    });
    // El guard de capacidad corre ANTES de buscar la penalidad: no hace falta seedearla para
    // documentar que el catálogo lo declara el adapter también en este camino.
    await expect(
      makeService(gateway).settleCancellationPenalty({
        penaltyId: uuidv7(),
        passengerId: PAX,
        method: 'PAGOEFECTIVO',
      }),
    ).rejects.toBeInstanceOf(InvalidStateError);
    expect(calls).toHaveLength(0);
  });
});
