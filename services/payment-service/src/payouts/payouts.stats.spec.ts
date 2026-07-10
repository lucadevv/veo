/**
 * PayoutsService.getStats · Seam 1 — KPIs de la pantalla de Liquidaciones (panel FINANCE): volumen total
 * liquidado + conteos por estado. Lo crítico a fijar:
 *  - UN solo `groupBy` por `status` (agrega en la DB, no materializa filas).
 *  - `totalCents` = suma de `_sum.amountCents` de TODOS los estados (el NETO ya persistido en cada fila).
 *  - El mapeo status→campo usa el enum `PayoutStatus` (PAYOUT_STATUS_COUNT_FIELD), sin strings mágicos.
 *  - Estados sin payouts (ausentes del groupBy) quedan en 0 (degradación honesta del agregado).
 * READ puro (no mutación de dinero) → unit con fake REPO (el service ya no toca Prisma; el repo es el único
 * dueño del groupBy — mismo criterio que ratings.service.spec.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { PayoutsService } from './payouts.service';
import { PayoutStatus } from '../generated/prisma';

interface GroupRow {
  status: PayoutStatus;
  _count: { _all: number };
  _sum: { amountCents: number | null };
}

function makeService(rows: GroupRow[]) {
  // El repo cristaliza el UN-SOLO-groupBy (by/_count/_sum): el fake devuelve las filas ya agrupadas.
  const groupPayoutsByStatus = vi.fn(async () => rows);
  const repo = { groupPayoutsByStatus };
  const config = { getOrThrow: (k: string) => (k === 'PAYOUT_MIN_CENTS' ? 0 : 500_000) };
  const svc = new PayoutsService(repo as never, {} as never, {} as never, config as never);
  return { svc, groupPayoutsByStatus };
}

function row(status: PayoutStatus, count: number, amountCents: number | null): GroupRow {
  return { status, _count: { _all: count }, _sum: { amountCents } };
}

describe('PayoutsService.getStats · Seam 1 (KPIs de payouts)', () => {
  it('agrega con UNA sola lectura agrupada por status (el repo posee el groupBy)', async () => {
    const { svc, groupPayoutsByStatus } = makeService([]);
    await svc.getStats();
    expect(groupPayoutsByStatus).toHaveBeenCalledTimes(1);
  });

  it('mapea cada status a su contador tipado y suma totalCents de TODOS los estados', async () => {
    const { svc } = makeService([
      row(PayoutStatus.PENDING, 3, 30_000),
      row(PayoutStatus.PROCESSING, 1, 10_000),
      row(PayoutStatus.PROCESSED, 12, 120_000),
      row(PayoutStatus.HELD, 2, 20_000),
      row(PayoutStatus.FAILED, 1, 5_000),
    ]);
    const stats = await svc.getStats();
    expect(stats).toEqual({
      totalCents: 185_000, // 30k + 10k + 120k + 20k + 5k
      pendingCount: 3,
      processingCount: 1,
      processedCount: 12,
      heldCount: 2,
      failedCount: 1,
    });
  });

  it('estados AUSENTES del groupBy quedan en 0 (sin payouts de ese estado)', async () => {
    const { svc } = makeService([row(PayoutStatus.PENDING, 4, 40_000)]);
    const stats = await svc.getStats();
    expect(stats.pendingCount).toBe(4);
    expect(stats.totalCents).toBe(40_000);
    expect(stats.processingCount).toBe(0);
    expect(stats.processedCount).toBe(0);
    expect(stats.heldCount).toBe(0);
    expect(stats.failedCount).toBe(0);
  });

  it('_sum.amountCents null (grupo sin montos) cuenta como 0 en totalCents', async () => {
    const { svc } = makeService([row(PayoutStatus.PENDING, 2, null)]);
    const stats = await svc.getStats();
    expect(stats.pendingCount).toBe(2);
    expect(stats.totalCents).toBe(0);
  });

  it('sin payouts (groupBy vacío) → todo en 0', async () => {
    const { svc } = makeService([]);
    const stats = await svc.getStats();
    expect(stats).toEqual({
      totalCents: 0,
      pendingCount: 0,
      processingCount: 0,
      processedCount: 0,
      heldCount: 0,
      failedCount: 0,
    });
  });
});
