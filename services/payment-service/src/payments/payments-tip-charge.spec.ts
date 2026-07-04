/**
 * A1 (ADR-022 · Model B) · addTip — TODA propina iniciada en el app se COBRA DIGITAL; el conductor la cobra SOLO
 * cuando el cobro CAPTURA (entra al payout por su tipCents). Crea un tip-Payment DEDICADO (kind=TIP, gross 0,
 * comisión 0, 100% al conductor). Antes no se cobraba nada al pasajero y el conductor la recibía igual (la
 * plataforma la subsidiaba). El MÉTODO de la propina = el de la tarifa si fue digital; si el viaje se pagó en
 * EFECTIVO cae a YAPE por defecto (el gateway no cobra CASH). Idempotente por Payment.dedupKey (`tip-charge:`).
 */
import { describe, it, expect, vi } from 'vitest';
import { PaymentsService } from './payments.service';
import { TIP_CHARGE_DEDUP_PREFIX } from './payment.policy';

type Row = Record<string, unknown>;

function buildService(
  fare: Row | null,
  opts: { existingTipCharge?: Row | null; walletUid?: string | null; chargeResult?: Row } = {},
) {
  const created: Row[] = [];
  const updated: Row[] = [];
  const findUnique = vi.fn(async ({ where }: { where: { dedupKey?: string; id?: string } }) => {
    if (where.dedupKey) return opts.existingTipCharge ?? null; // idempotencia del cobro de propina
    if (where.id) return updated[0] ?? created[0] ?? fare; // getPayment(id) / dup lookups
    return null;
  });
  const prisma = {
    read: { payment: { findUnique, findFirst: vi.fn(async () => fare) } },
    write: {
      payment: {
        create: vi.fn(async ({ data }: { data: Row }) => {
          created.push(data);
          return { ...data };
        }),
        update: vi.fn(async ({ data }: { data: Row }) => {
          const u = { ...(created[0] ?? fare), ...data };
          updated.push(u);
          return u;
        }),
        // RC19 · markDebt (rama TIP) ahora usa un CAS updateMany + re-read para no pisar una captura concurrente.
        updateMany: vi.fn(async ({ data }: { data: Row }) => {
          const u = { ...(updated[updated.length - 1] ?? created[0] ?? fare), ...data };
          updated.push(u);
          return { count: 1 };
        }),
        findUniqueOrThrow: vi.fn(async () => updated[updated.length - 1] ?? created[0] ?? fare),
      },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          payment: {
            update: vi.fn(async ({ data }: { data: Row }) => {
              const u = { ...(created[0] ?? fare), ...data };
              updated.push(u);
              return u;
            }),
          },
        }),
      ),
    },
  };
  const gateway = {
    chargeFlow: 'aggregator' as const,
    supports: () => true,
    charge: vi.fn(async () =>
      opts.chargeResult ?? {
        status: 'PENDING_EXTERNAL' as const,
        externalRef: 'uid-tip-1',
        checkout: { qrCodeBase64: 'data:image/png;base64,AAAA' },
      },
    ),
  };
  const affiliations = { resolveActiveWalletUid: vi.fn(async () => opts.walletUid ?? null) };
  const config = { getOrThrow: () => 0 };
  const service = new PaymentsService(
    prisma as never,
    gateway as never,
    affiliations as never,
    {} as never, // promotions (no se usa: la propina NO canjea promo/crédito)
    config as never,
  );
  return { service, created, updated, gateway };
}

const yapeFare: Row = {
  id: 'fare-1', tripId: 'trip-1', method: 'YAPE', driverId: 'drv-1', passengerId: 'pax-1',
  payerRef: '999888777', kind: 'FARE', status: 'CAPTURED', tipCents: 0,
};
const plinFare: Row = { ...yapeFare, id: 'fare-plin', method: 'PLIN' };
const cashFare: Row = { ...yapeFare, id: 'fare-cash', method: 'CASH', payerRef: null };

describe('A1 · addTip — la propina SIEMPRE se cobra digital (Model B)', () => {
  it('viaje DIGITAL → tip-Payment kind=TIP (gross 0, comisión 0, 100% propina) con el MISMO método, cobrado', async () => {
    const { service, created, gateway } = buildService(yapeFare);
    await service.addTip({ tripId: 'trip-1', tipCents: 500, dedupKey: 'nonce-1' });

    expect(created).toHaveLength(1);
    const tip = created[0]!;
    expect(tip.kind).toBe('TIP');
    expect(tip.grossCents).toBe(0);
    expect(tip.commissionCents).toBe(0);
    expect(tip.feeCents).toBe(0);
    expect(tip.tipCents).toBe(500);
    expect(tip.amountCents).toBe(500);
    expect(tip.method).toBe('YAPE'); // el MISMO método con que pagó la tarifa
    expect(tip.driverId).toBe('drv-1');
    expect(tip.status).toBe('PENDING'); // entra al payout recién al CAPTURAR (webhook), no ahora
    expect(String(tip.dedupKey)).toBe(`${TIP_CHARGE_DEDUP_PREFIX}nonce-1`);
    expect(gateway.charge).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 500, method: 'YAPE' }));
  });

  it('viaje en EFECTIVO → la propina se cobra DIGITAL con YAPE por defecto (no "en mano", el conductor la cobra)', async () => {
    const { service, created, gateway } = buildService(cashFare);
    await service.addTip({ tripId: 'trip-1', tipCents: 300, dedupKey: 'nonce-cash' });

    expect(created).toHaveLength(1);
    const tip = created[0]!;
    expect(tip.kind).toBe('TIP');
    expect(tip.method).toBe('YAPE'); // NO hereda CASH (el gateway no cobra efectivo) → default digital
    expect(tip.tipCents).toBe(300);
    expect(tip.amountCents).toBe(300);
    // se DESPACHÓ un cobro real de la propina por el riel digital (no se perdió por "en mano")
    expect(gateway.charge).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 300, method: 'YAPE' }));
  });

  it('viaje PLIN → la propina cobra con PLIN (hereda el método digital de la tarifa)', async () => {
    const { service, created } = buildService(plinFare);
    await service.addTip({ tripId: 'trip-1', tipCents: 500, dedupKey: 'nonce-plin' });
    expect(created[0]!.method).toBe('PLIN');
  });

  it('idempotente → si ya existe el tip-Payment de esa dedupKey, no re-cobra', async () => {
    const existing = { id: 'tip-existing', kind: 'TIP', status: 'PENDING', tipCents: 500 };
    const { service, created, gateway } = buildService(yapeFare, { existingTipCharge: existing });
    const out = await service.addTip({ tripId: 'trip-1', tipCents: 500, dedupKey: 'nonce-1' });

    expect(out).toEqual(existing);
    expect(created).toHaveLength(0);
    expect(gateway.charge).not.toHaveBeenCalled();
  });

  it('rechaza propina no-entera o <= 0', async () => {
    const { service } = buildService(yapeFare);
    await expect(service.addTip({ tripId: 'trip-1', tipCents: 0, dedupKey: 'x' })).rejects.toThrow();
    await expect(service.addTip({ tripId: 'trip-1', tipCents: 1.5, dedupKey: 'x' })).rejects.toThrow();
  });

  it('la propina que DECLINA → FAILED terminal (no DEBT), sin emitir payment.failed (no bloquea ni alerta)', async () => {
    const { service, updated } = buildService(yapeFare, {
      chargeResult: { status: 'DECLINED', reason: 'insufficient_funds', failureKind: 'declined' },
    });
    await service.addTip({ tripId: 'trip-1', tipCents: 500, dedupKey: 'nonce-decl' });
    // markDebt(kind=TIP) marca FAILED con un update PLANO (no la tx que emite payment.failed de la tarifa).
    expect(updated).toHaveLength(1);
    expect(updated[0]!.status).toBe('FAILED');
  });
});

/** Read-side: los lookups que asumían "un payment = una tarifa" NO deben contaminarse con el tip-Payment. */
describe('A1 · el tip-Payment NO contamina los lookups de la tarifa', () => {
  it('getDebtForPassenger filtra kind=FARE → una propina fallida NO entra al gate de deuda', async () => {
    const paymentFindMany = vi.fn(async (_args: { where: Row }): Promise<Row[]> => []);
    const prisma = {
      read: {
        payment: { findMany: paymentFindMany },
        cancellationPenalty: { findMany: vi.fn(async () => []) },
      },
    };
    const svc = new PaymentsService(
      prisma as never, {} as never, {} as never, {} as never, { getOrThrow: () => 0 } as never,
    );
    const out = await svc.getDebtForPassenger('pax-1');
    expect(out.hasDebt).toBe(false);
    // ambas queries (DEBT + PENDING) deben restringir a kind=FARE
    for (const [args] of paymentFindMany.mock.calls) {
      expect(args.where.kind).toBe('FARE');
    }
    expect(paymentFindMany).toHaveBeenCalledTimes(2);
  });

  it('propina que EXPIRA (webhook, checkout abandonado) → FAILED terminal SIN payment.failed (markDebt kind-aware)', async () => {
    const tip: Row = {
      id: 'tip-x', tripId: 'trip-1', kind: 'TIP', status: 'PENDING', method: 'YAPE',
      amountCents: 500, tipCents: 500, driverId: 'drv-1',
    };
    const updates: Row[] = [];
    const txSpy = vi.fn(); // la tx SOLO se usa en el camino de la TARIFA (que emite payment.failed)
    const prisma = {
      read: { payment: { findUnique: vi.fn(async () => tip) } },
      write: {
        payment: {
          // RC19 · la rama TIP de markDebt usa un CAS updateMany + re-read (no pisa una captura concurrente).
          updateMany: vi.fn(async ({ data }: { data: Row }) => {
            updates.push(data);
            return { count: 1 };
          }),
          findUniqueOrThrow: vi.fn(async () => ({ ...tip, ...(updates[updates.length - 1] ?? {}) })),
        },
        $transaction: txSpy,
      },
    };
    const svc = new PaymentsService(
      prisma as never, {} as never, {} as never, {} as never, { getOrThrow: () => 0 } as never,
    );
    const out = await svc.applyWebhookResult({
      paymentId: 'tip-x', externalUid: 'uid-x', status: 'EXPIRED',
    });
    expect(out.status).toBe('FAILED');
    expect(updates[0]!.status).toBe('FAILED');
    expect(txSpy).not.toHaveBeenCalled(); // el tip NO pasa por la tx que emite payment.failed → no alerta seguridad
  });

  it('earningsForDriver: la propina suma en tipCents pero NO cuenta como viaje (tripCount solo FARE)', async () => {
    const rows = [
      { grossCents: 2000, commissionCents: 400, tipCents: 0, kind: 'FARE' },
      { grossCents: 0, commissionCents: 0, tipCents: 300, kind: 'TIP' }, // propina digital capturada
    ];
    const prisma = { read: { payment: { findMany: vi.fn(async () => rows) } } };
    const svc = new PaymentsService(
      prisma as never, {} as never, {} as never, {} as never, { getOrThrow: () => 0 } as never,
    );
    const out = await svc.earningsForDriver('drv-1', new Date(0), new Date(1e13));
    expect(out.tipCents).toBe(300); // la propina SÍ cuenta como ganancia
    expect(out.netCents).toBe(2000 - 400 + 300);
    expect(out.tripCount).toBe(1); // pero NO como un viaje extra
  });
});
