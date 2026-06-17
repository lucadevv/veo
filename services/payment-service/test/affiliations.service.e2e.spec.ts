/**
 * AffiliationsService · Yape On File · E2E con Postgres REAL (testcontainers) — NO se mockea la DB en
 * un crítico de pagos (CLAUDE). Reemplaza al antiguo affiliations.service.spec.ts (fake Prisma).
 *
 * El proveedor (Yape/ProntoPaga) se faquea (FakeGateway/YapeSubscriber) — nunca se pega al riel real;
 * la persistencia de la WalletAffiliation (upsert idempotente, PII enmascarada, transiciones) es real.
 * El throttle del refresh es IN-MEMORY (Map por instancia), así que un service fresco por test basta.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { PrismaClient } from '../src/generated/prisma';
import { AffiliationsService } from '../src/affiliations/affiliations.service';
import type { PrismaService } from '../src/infra/prisma.service';
import type { PaymentGateway, YapeSubscriber } from '../src/ports/gateway/payment-gateway.port';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const USER = '0192f8a0-0000-7000-8000-0000000000a1';
const MOBILE_INPUT = {
  document: '12345678',
  documentType: 'DN' as const,
  clientName: 'Juan Perez',
};

let db: TestDatabase;
let prisma: PrismaClient;
let gateway: FakeGateway;
let service: AffiliationsService;

class FakeGateway implements YapeSubscriber {
  public lastCreateInput: Record<string, unknown> | null = null;
  public cancelCalls: string[] = [];
  public showCalls: string[] = [];
  public showResult: { status?: string; phoneNumber?: string | null } = { status: 'PROCESS' };
  public cancelShouldFail = false;

  async createYapeSubscription(input: Record<string, unknown>) {
    this.lastCreateInput = input;
    return {
      uid: 'WUID-SECRET-123',
      status: 'PROCESS',
      deepLink: 'yape://approve/abc',
      phoneNumber: null,
    };
  }
  async showYapeSubscription(walletUid: string) {
    this.showCalls.push(walletUid);
    return this.showResult;
  }
  async cancelYapeSubscription(walletUid: string) {
    this.cancelCalls.push(walletUid);
    if (this.cancelShouldFail) throw new Error('provider cancel boom');
  }
}

async function storedAffiliation() {
  return prisma.walletAffiliation.findFirstOrThrow({ where: { userId: USER } });
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
  await prisma.walletAffiliation.deleteMany({});
  gateway = new FakeGateway();
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  service = new AffiliationsService(prismaService, gateway as unknown as PaymentGateway);
});

describe('AffiliationsService · Yape On File', () => {
  it('createAffiliation MOBILE: NO manda phone al proveedor y devuelve deepLink (sin walletUid)', async () => {
    const res = await service.createAffiliation(USER, { ...MOBILE_INPUT });
    expect(res.deepLink).toBe('yape://approve/abc');
    expect(res.status).toBe('PROCESS');
    expect(gateway.lastCreateInput?.origin).toBe('MOBILE');
    expect(gateway.lastCreateInput?.phoneNumber).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('WUID-SECRET-123'); // nunca expone el walletUid
  });

  it('MOBILE guarda phoneMasked=null (aún no se conoce el phone) + document enmascarado', async () => {
    await service.createAffiliation(USER, { ...MOBILE_INPUT });
    const stored = await storedAffiliation();
    expect(stored.phoneMasked).toBeNull();
    expect(stored.documentMasked).toBe('******78');
    expect(stored.walletUid).toBe('WUID-SECRET-123'); // SÍ se guarda server-side
  });

  it('origin=WEB SIN phone → InvalidStateError', async () => {
    await expect(
      service.createAffiliation(USER, { ...MOBILE_INPUT, origin: 'WEB' }),
    ).rejects.toThrow(/origin=WEB requiere phone/);
  });

  it('origin=WEB con phone → manda phoneNumber y guarda phoneMasked', async () => {
    await service.createAffiliation(USER, { ...MOBILE_INPUT, origin: 'WEB', phone: '999881234' });
    expect(gateway.lastCreateInput?.phoneNumber).toBe('999881234');
    expect((await storedAffiliation()).phoneMasked).toBe('*****1234');
  });

  it('getAffiliationStatus NO expone walletUid ni documentMasked', async () => {
    await service.createAffiliation(USER, { ...MOBILE_INPUT });
    gateway.showResult = { status: 'PROCESS' }; // no resuelve aún
    const view = await service.getAffiliationStatus(USER);
    expect(view).toBeTruthy();
    expect(JSON.stringify(view)).not.toContain('WUID-SECRET-123');
    expect(view).not.toHaveProperty('walletUid');
    expect(view).not.toHaveProperty('documentMasked');
  });

  it('webhook CONFIRMED → ACTIVE; resolveActiveWalletUid lo devuelve solo internamente', async () => {
    await service.createAffiliation(USER, { ...MOBILE_INPUT });
    await service.markFromWebhook({
      affiliationId: undefined,
      walletUid: 'WUID-SECRET-123',
      status: 'CONFIRMED',
    });
    const view = await service.getAffiliationStatus(USER);
    expect(view?.status).toBe('ACTIVE');
    expect(await service.resolveActiveWalletUid(USER)).toBe('WUID-SECRET-123');
  });

  it('revoke → cancela en el PROVEEDOR + REVOKED + deja de resolver el walletUid', async () => {
    await service.createAffiliation(USER, { ...MOBILE_INPUT });
    await service.markFromWebhook({ walletUid: 'WUID-SECRET-123', status: 'CONFIRMED' });
    const view = await service.revokeAffiliation(USER);
    expect(view.status).toBe('REVOKED');
    expect(gateway.cancelCalls).toEqual(['WUID-SECRET-123']); // cancel REAL en el proveedor
    expect(await service.resolveActiveWalletUid(USER)).toBeNull();
  });

  it('revoke: si el proveedor falla, igual revoca local (best-effort)', async () => {
    await service.createAffiliation(USER, { ...MOBILE_INPUT });
    await service.markFromWebhook({ walletUid: 'WUID-SECRET-123', status: 'CONFIRMED' });
    gateway.cancelShouldFail = true;
    const view = await service.revokeAffiliation(USER);
    expect(view.status).toBe('REVOKED'); // no bloquea la baja por el fallo del riel
    expect(gateway.cancelCalls).toEqual(['WUID-SECRET-123']);
  });

  it('webhook idempotente: re-aplicar CONFIRMED no rompe el estado ACTIVE', async () => {
    await service.createAffiliation(USER, { ...MOBILE_INPUT });
    await service.markFromWebhook({ walletUid: 'WUID-SECRET-123', status: 'CONFIRMED' });
    await service.markFromWebhook({ walletUid: 'WUID-SECRET-123', status: 'CONFIRMED' });
    expect((await service.getAffiliationStatus(USER))?.status).toBe('ACTIVE');
  });

  describe('refresh defensivo (/show) sobre PROCESS', () => {
    it('status PROCESS → /show ACCEPTED resuelve ACTIVE + guarda phoneMasked + emite activación', async () => {
      await service.createAffiliation(USER, { ...MOBILE_INPUT });
      gateway.showResult = { status: 'ACCEPTED', phoneNumber: '999881234' };
      const view = await service.getAffiliationStatus(USER);
      expect(view?.status).toBe('ACTIVE');
      expect(view?.phoneMasked).toBe('*****1234'); // el /show trae el phone al aceptar
      expect(gateway.showCalls).toEqual(['WUID-SECRET-123']);
      expect(await service.resolveActiveWalletUid(USER)).toBe('WUID-SECRET-123'); // ya cobrable on-file
    });

    it('THROTTLE: dos GET seguidos consultan al proveedor UNA sola vez', async () => {
      await service.createAffiliation(USER, { ...MOBILE_INPUT });
      gateway.showResult = { status: 'PROCESS' }; // sigue pendiente
      await service.getAffiliationStatus(USER);
      await service.getAffiliationStatus(USER);
      expect(gateway.showCalls.length).toBe(1); // el throttle evita martillar al proveedor
    });

    it('no re-emite si ya está ACTIVE (idempotente entre webhook y refresh)', async () => {
      await service.createAffiliation(USER, { ...MOBILE_INPUT });
      await service.markFromWebhook({ walletUid: 'WUID-SECRET-123', status: 'CONFIRMED' });
      gateway.showResult = { status: 'ACCEPTED', phoneNumber: '999881234' };
      await service.getAffiliationStatus(USER); // ya ACTIVE: no debe consultar /show
      expect(gateway.showCalls.length).toBe(0);
    });
  });
});
