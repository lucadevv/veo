import { describe, it, expect, beforeEach } from 'vitest';
import { AffiliationsService } from './affiliations.service';
import type { PrismaService } from '../infra/prisma.service';
import type { PaymentGateway, YapeSubscriber } from '../ports/gateway/payment-gateway.port';

/** Fake Prisma en memoria para WalletAffiliation + outbox (no DB real; tests hermeticos). */
function makeFakePrisma() {
  const rows = new Map<string, Record<string, unknown>>(); // key = id
  const keyOf = (r: Record<string, unknown>) => `${String(r.userId)}|${String(r.provider)}|${String(r.wallet)}`;
  const byUnique = (where: { userId: string; provider: string; wallet: string }) =>
    [...rows.values()].find((r) => keyOf(r) === `${where.userId}|${where.provider}|${where.wallet}`) ?? null;

  const client = {
    walletAffiliation: {
      findUnique: async ({ where }: { where: { id?: string; userId_provider_wallet?: { userId: string; provider: string; wallet: string } } }) => {
        if (where.id) return rows.get(where.id) ?? null;
        return where.userId_provider_wallet ? byUnique(where.userId_provider_wallet) : null;
      },
      findFirst: async ({ where }: { where: { walletUid?: string } }) =>
        [...rows.values()].find((r) => r.walletUid === where.walletUid) ?? null,
      upsert: async ({ where, update, create }: { where: { userId_provider_wallet: { userId: string; provider: string; wallet: string } }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const found = byUnique(where.userId_provider_wallet);
        if (found) {
          Object.assign(found, update);
          return found;
        }
        const row = { ...create, updatedAt: new Date() };
        rows.set(create.id as string, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    outboxEvent: { create: async ({ data }: { data: unknown }) => data },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return { read: client, write: client, _rows: rows } as unknown as PrismaService & { _rows: Map<string, Record<string, unknown>> };
}

class FakeGateway implements YapeSubscriber {
  public lastCreateInput: Record<string, unknown> | null = null;
  public cancelCalls: string[] = [];
  public showCalls: string[] = [];
  /** Detalle que /show devuelve (configurable por test). */
  public showResult: { status?: string; phoneNumber?: string | null } = { status: 'PROCESS' };
  public cancelShouldFail = false;

  async createYapeSubscription(input: Record<string, unknown>) {
    this.lastCreateInput = input;
    // En MOBILE el proveedor devuelve phoneNumber null hasta la aceptación.
    return { uid: 'WUID-SECRET-123', status: 'PROCESS', deepLink: 'yape://approve/abc', phoneNumber: null };
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

const MOBILE_INPUT = { document: '12345678', documentType: 'DN' as const, clientName: 'Juan Perez' };

describe('AffiliationsService · Yape On File', () => {
  let prisma: ReturnType<typeof makeFakePrisma>;
  let gateway: FakeGateway;
  let service: AffiliationsService;

  beforeEach(() => {
    prisma = makeFakePrisma();
    gateway = new FakeGateway();
    service = new AffiliationsService(prisma, gateway as unknown as PaymentGateway);
  });

  it('createAffiliation MOBILE: NO manda phone al proveedor y devuelve deepLink (sin walletUid)', async () => {
    const res = await service.createAffiliation('user-1', { ...MOBILE_INPUT });
    expect(res.deepLink).toBe('yape://approve/abc');
    expect(res.status).toBe('PROCESS');
    // Patrón fricción mínima: origin MOBILE por default y SIN phoneNumber.
    expect(gateway.lastCreateInput?.origin).toBe('MOBILE');
    expect(gateway.lastCreateInput?.phoneNumber).toBeUndefined();
    // El objeto de respuesta NO debe contener walletUid bajo ninguna clave.
    expect(JSON.stringify(res)).not.toContain('WUID-SECRET-123');
  });

  it('MOBILE guarda phoneMasked=null (aún no se conoce el phone) + document enmascarado', async () => {
    await service.createAffiliation('user-1', { ...MOBILE_INPUT });
    const stored = [...prisma._rows.values()][0]!;
    expect(stored.phoneMasked).toBeNull();
    expect(stored.documentMasked).toBe('******78');
    // El walletUid SÍ se guarda server-side.
    expect(stored.walletUid).toBe('WUID-SECRET-123');
  });

  it('origin=WEB SIN phone → InvalidStateError', async () => {
    await expect(
      service.createAffiliation('user-1', { ...MOBILE_INPUT, origin: 'WEB' }),
    ).rejects.toThrow(/origin=WEB requiere phone/);
  });

  it('origin=WEB con phone → manda phoneNumber y guarda phoneMasked', async () => {
    await service.createAffiliation('user-1', { ...MOBILE_INPUT, origin: 'WEB', phone: '999881234' });
    expect(gateway.lastCreateInput?.phoneNumber).toBe('999881234');
    expect([...prisma._rows.values()][0]!.phoneMasked).toBe('*****1234');
  });

  it('getAffiliationStatus NO expone walletUid ni documentMasked', async () => {
    await service.createAffiliation('user-1', { ...MOBILE_INPUT });
    gateway.showResult = { status: 'PROCESS' }; // no resuelve aún
    const view = await service.getAffiliationStatus('user-1');
    expect(view).toBeTruthy();
    expect(JSON.stringify(view)).not.toContain('WUID-SECRET-123');
    expect(view).not.toHaveProperty('walletUid');
    expect(view).not.toHaveProperty('documentMasked');
  });

  it('webhook CONFIRMED → ACTIVE; resolveActiveWalletUid lo devuelve solo internamente', async () => {
    await service.createAffiliation('user-1', { ...MOBILE_INPUT });
    await service.markFromWebhook({ affiliationId: undefined, walletUid: 'WUID-SECRET-123', status: 'CONFIRMED' });
    const view = await service.getAffiliationStatus('user-1');
    expect(view?.status).toBe('ACTIVE');
    const uid = await service.resolveActiveWalletUid('user-1');
    expect(uid).toBe('WUID-SECRET-123');
  });

  it('revoke → cancela en el PROVEEDOR + REVOKED + deja de resolver el walletUid', async () => {
    await service.createAffiliation('user-1', { ...MOBILE_INPUT });
    await service.markFromWebhook({ walletUid: 'WUID-SECRET-123', status: 'CONFIRMED' });
    const view = await service.revokeAffiliation('user-1');
    expect(view.status).toBe('REVOKED');
    expect(gateway.cancelCalls).toEqual(['WUID-SECRET-123']); // cancel REAL en el proveedor
    expect(await service.resolveActiveWalletUid('user-1')).toBeNull();
  });

  it('revoke: si el proveedor falla, igual revoca local (best-effort)', async () => {
    await service.createAffiliation('user-1', { ...MOBILE_INPUT });
    await service.markFromWebhook({ walletUid: 'WUID-SECRET-123', status: 'CONFIRMED' });
    gateway.cancelShouldFail = true;
    const view = await service.revokeAffiliation('user-1');
    expect(view.status).toBe('REVOKED'); // no bloquea la baja por el fallo del riel
    expect(gateway.cancelCalls).toEqual(['WUID-SECRET-123']);
  });

  it('webhook idempotente: re-aplicar CONFIRMED no rompe el estado ACTIVE', async () => {
    await service.createAffiliation('user-1', { ...MOBILE_INPUT });
    await service.markFromWebhook({ walletUid: 'WUID-SECRET-123', status: 'CONFIRMED' });
    await service.markFromWebhook({ walletUid: 'WUID-SECRET-123', status: 'CONFIRMED' });
    expect((await service.getAffiliationStatus('user-1'))?.status).toBe('ACTIVE');
  });

  describe('refresh defensivo (/show) sobre PROCESS', () => {
    it('status PROCESS → /show ACCEPTED resuelve ACTIVE + guarda phoneMasked + emite activación', async () => {
      await service.createAffiliation('user-1', { ...MOBILE_INPUT });
      gateway.showResult = { status: 'ACCEPTED', phoneNumber: '999881234' };
      const view = await service.getAffiliationStatus('user-1');
      expect(view?.status).toBe('ACTIVE');
      expect(view?.phoneMasked).toBe('*****1234'); // el /show trae el phone al aceptar
      expect(gateway.showCalls).toEqual(['WUID-SECRET-123']);
      // resolvió ACTIVE → ya cobrable on-file
      expect(await service.resolveActiveWalletUid('user-1')).toBe('WUID-SECRET-123');
    });

    it('THROTTLE: dos GET seguidos consultan al proveedor UNA sola vez', async () => {
      await service.createAffiliation('user-1', { ...MOBILE_INPUT });
      gateway.showResult = { status: 'PROCESS' }; // sigue pendiente
      await service.getAffiliationStatus('user-1');
      await service.getAffiliationStatus('user-1');
      expect(gateway.showCalls.length).toBe(1); // el throttle evita martillar al proveedor
    });

    it('no re-emite si ya está ACTIVE (idempotente entre webhook y refresh)', async () => {
      await service.createAffiliation('user-1', { ...MOBILE_INPUT });
      await service.markFromWebhook({ walletUid: 'WUID-SECRET-123', status: 'CONFIRMED' });
      gateway.showResult = { status: 'ACCEPTED', phoneNumber: '999881234' };
      // ya ACTIVE: el GET no debe consultar /show (no está en PROCESS)
      await service.getAffiliationStatus('user-1');
      expect(gateway.showCalls.length).toBe(0);
    });
  });
});
