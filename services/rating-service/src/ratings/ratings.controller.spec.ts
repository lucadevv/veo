/**
 * Spec del controlador REST de ratings — foco en el SCOPING DE MODERACIÓN POR RIEL del endpoint
 * GET /ratings/aggregate/:subjectId (anti-IDOR · fuga de moderación H8). Es el GEMELO REST del gRPC
 * GetAggregate: el fix previo cerró el gRPC pero el REST devolvía `flagged`/`flagReason` crudos a
 * public-rail. Ahora ambos pasan por el MISMO helper (scopeAggregateForRail). La regla:
 *   1) PUBLIC_RAIL (pasajero pidiendo el agregado de cualquier conductor) → flags ZEROEADOS (IDOR cerrado).
 *   2) DRIVER_RAIL (el conductor sobre su propio record) → flags VISIBLES (transparencia).
 *   3) ADMIN_RAIL (revisión del operador) → flags VISIBLES.
 *   4) SERVICE_RAIL → flags ZEROEADOS.
 *   5) avg/count se devuelven SIEMPRE (reputación pública, todos los rieles).
 *   6) sin agregado → NotFound.
 */
import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { InternalAudience } from '@veo/auth';
import { RatingsController } from './ratings.controller';
import type { RatingsService, AggregateEntity } from './ratings.service';

const FLAGGED_AGG: AggregateEntity = {
  subjectId: 'd1',
  role: 'DRIVER',
  rollingAvg30d: 3.2,
  count30d: 40,
  flagged: true,
  flagReason: 'suspension',
  lastComputedAt: new Date('2026-06-01T00:00:00.000Z'),
};

function makeController(agg: AggregateEntity | null = FLAGGED_AGG): RatingsController {
  const ratings = {
    getAggregate: vi.fn(async () => agg),
  } as unknown as RatingsService;
  return new RatingsController(ratings);
}

describe('RatingsController · GET /ratings/aggregate · scoping de moderación por riel (anti-IDOR REST)', () => {
  it('PUBLIC_RAIL · pasajero pidiendo el agregado de un conductor → flags ZEROEADOS (IDOR REST cerrado)', async () => {
    const ctrl = makeController();
    const res = await ctrl.getAggregate('d1', InternalAudience.PUBLIC_RAIL);
    expect(res.flagged).toBe(false);
    expect(res.flagReason).toBeNull();
    // Reputación pública SIGUE viajando.
    expect(res.rollingAvg30d).toBe(3.2);
    expect(res.count30d).toBe(40);
  });

  it('DRIVER_RAIL · el conductor sobre su propio record → flags VISIBLES (transparencia)', async () => {
    const ctrl = makeController();
    const res = await ctrl.getAggregate('d1', InternalAudience.DRIVER_RAIL);
    expect(res.flagged).toBe(true);
    expect(res.flagReason).toBe('suspension');
    expect(res.rollingAvg30d).toBe(3.2);
  });

  it('ADMIN_RAIL · revisión del operador → flags VISIBLES', async () => {
    const ctrl = makeController();
    const res = await ctrl.getAggregate('d1', InternalAudience.ADMIN_RAIL);
    expect(res.flagged).toBe(true);
    expect(res.flagReason).toBe('suspension');
  });

  it('SERVICE_RAIL → flags ZEROEADOS', async () => {
    const ctrl = makeController();
    const res = await ctrl.getAggregate('d1', InternalAudience.SERVICE_RAIL);
    expect(res.flagged).toBe(false);
    expect(res.flagReason).toBeNull();
    expect(res.rollingAvg30d).toBe(3.2);
  });

  it('riel ausente → flags ZEROEADOS (fail-closed)', async () => {
    const ctrl = makeController();
    const res = await ctrl.getAggregate('d1', undefined);
    expect(res.flagged).toBe(false);
    expect(res.flagReason).toBeNull();
  });

  it('sin agregado → NotFound', async () => {
    const ctrl = makeController(null);
    await expect(ctrl.getAggregate('dX', InternalAudience.PUBLIC_RAIL)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
