/**
 * Test del MURO real (dispatch-service): el ownership-check anti-IDOR #9 vive ACÁ, no se confía en el BFF.
 *  - Conductor A intenta accept/reject/getMatch sobre el match de B → 404 (NO 403: no filtra existencia).
 *  - El dueño legítimo → éxito.
 *  - CAS concurrente del DUEÑO sobre un match ya respondido → 409 (NO se confunde con el 404-no-dueño).
 *
 * El 403 por identidad sin driverId vive en el controller (requireDriverId, fail-closed) — testeado aparte
 * en require-driver-id (helper compartido). Acá probamos el comportamiento del service dado un driverId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DispatchOutcome } from '@veo/shared-types';
import { DispatchService } from './dispatch.service';

const MATCH = '00000000-0000-0000-0000-000000000001';
const OWNER = 'driver-owner';
const OTHER = 'driver-other';

function matchRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: MATCH,
    tripId: 'trip-1',
    driverId: OWNER,
    score: { toString: () => '1' },
    attempt: 1,
    surgeMultiplier: { toString: () => '1.0' },
    outcome: DispatchOutcome.OFFERED,
    offeredAt: new Date('2026-01-01T00:00:00.000Z'),
    respondedAt: null,
    ...overrides,
  };
}

function makeService(
  opts: {
    row?: ReturnType<typeof matchRow> | null;
    claimCount?: number;
  } = {},
) {
  const row = opts.row === undefined ? matchRow() : opts.row;
  const findUnique = vi.fn(async () => row);
  const updateMany = vi.fn(async () => ({ count: opts.claimCount ?? 1 }));
  const create = vi.fn(async () => undefined);
  // Flujo STANDARD: sin ofertas hermanas (broadcast EMERGENCY) ⇒ retractSiblingOffers es no-op acá.
  const findMany = vi.fn(async () => [] as { id: string; driverId: string }[]);

  // write.$transaction ejecuta el callback con un tx que comparte los mismos mocks de tabla.
  const tx = {
    dispatchMatch: { findUnique, updateMany },
    outboxEvent: { create },
  };
  const prisma = {
    read: { dispatchMatch: { findUnique, findMany } },
    write: { $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) },
  };

  const hotIndex = {
    markBusy: vi.fn(async () => undefined),
    markAvailable: vi.fn(async () => undefined),
  };
  const exclusion = { exclude: vi.fn(async () => undefined) };
  // Fail-soft: si fleet/identity fallan, resolveVehicleId devuelve null y NO bloquea.
  const fleet = { getActiveVehicleId: vi.fn(async () => null) };
  const identity = { getDriver: vi.fn(async () => ({ found: false, userId: '' })) };
  const matching = {
    markMatched: vi.fn(async () => undefined),
    offerNext: vi.fn(async () => undefined),
  };

  const service = new DispatchService(
    prisma as never,
    hotIndex as never,
    exclusion as never,
    fleet as never,
    identity as never,
    matching as never,
  );
  return { service, findUnique, updateMany };
}

describe('DispatchService (dispatch-service) — ownership-check anti-IDOR #9', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('accept', () => {
    it('el conductor de OTRO match → 404 (no 403), NO toca el CAS', async () => {
      const { service, updateMany } = makeService();
      await expect(service.accept(MATCH, OTHER)).rejects.toMatchObject({ httpStatus: 404 });
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('match inexistente → 404', async () => {
      const { service } = makeService({ row: null });
      await expect(service.accept(MATCH, OWNER)).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('el DUEÑO → éxito (ACCEPTED) y el CAS filtra por driverId', async () => {
      const { service, updateMany } = makeService();
      const view = await service.accept(MATCH, OWNER);
      expect(view.outcome).toBe(DispatchOutcome.ACCEPTED);
      // driverId va en el WHERE del CAS (defensa en profundidad).
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: MATCH, driverId: OWNER, outcome: DispatchOutcome.OFFERED },
        }),
      );
    });

    it('CAS concurrente del DUEÑO sobre match ya respondido → 409 (NO 404, NO se confunde con no-dueño)', async () => {
      // El dueño PASA el ownership-check (404 no aplica) pero el CAS no matchea OFFERED → count 0 → 409.
      const { service } = makeService({ claimCount: 0 });
      await expect(service.accept(MATCH, OWNER)).rejects.toMatchObject({ httpStatus: 409 });
    });
  });

  describe('reject', () => {
    it('el conductor de OTRO match → 404, NO toca el CAS', async () => {
      const { service, updateMany } = makeService();
      await expect(service.reject(MATCH, OTHER)).rejects.toMatchObject({ httpStatus: 404 });
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('el DUEÑO → éxito (REJECTED) con driverId en el CAS', async () => {
      const { service, updateMany } = makeService();
      const view = await service.reject(MATCH, OWNER);
      expect(view.outcome).toBe(DispatchOutcome.REJECTED);
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: MATCH, driverId: OWNER, outcome: DispatchOutcome.OFFERED },
        }),
      );
    });

    it('CAS concurrente del DUEÑO sobre match ya respondido → 409', async () => {
      const { service } = makeService({ claimCount: 0 });
      await expect(service.reject(MATCH, OWNER)).rejects.toMatchObject({ httpStatus: 409 });
    });
  });

  describe('getMatch', () => {
    it('el conductor de OTRO match → 404 (no filtra existencia)', async () => {
      const { service } = makeService();
      await expect(service.getMatch(MATCH, OTHER)).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('match inexistente → 404', async () => {
      const { service } = makeService({ row: null });
      await expect(service.getMatch(MATCH, OWNER)).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('el DUEÑO → lee su match', async () => {
      const { service } = makeService();
      const view = await service.getMatch(MATCH, OWNER);
      expect(view.id).toBe(MATCH);
      expect(view.driverId).toBe(OWNER);
    });
  });
});
