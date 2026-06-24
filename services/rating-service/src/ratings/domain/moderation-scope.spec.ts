/**
 * Spec del PUNTO DE DECISIÓN ÚNICO del scoping de moderación por riel (anti-IDOR · fuga de moderación H8).
 * Este helper lo comparten el controlador gRPC (GetAggregate) y el REST (GET /ratings/aggregate/:subjectId):
 * un solo lugar decide quién ve `flagged`/`flagReason`. La regla:
 *   - DRIVER_RAIL / ADMIN_RAIL → moderación VISIBLE (transparencia / revisión del operador).
 *   - PUBLIC_RAIL / SERVICE_RAIL / riel ausente → moderación ZEROEADA (flagged=false, flagReason=null).
 *   - La reputación pública (avg/count/role/lastComputedAt) viaja SIEMPRE intacta.
 */
import { describe, it, expect } from 'vitest';
import { InternalAudience } from '@veo/auth';
import { exposeModerationFor, scopeAggregateForRail } from './moderation-scope';
import type { AggregateEntity } from '../ratings.service';

const FLAGGED: AggregateEntity = {
  subjectId: 'd1',
  role: 'DRIVER',
  rollingAvg30d: 3.2,
  count30d: 40,
  flagged: true,
  flagReason: 'suspension',
  lastComputedAt: new Date('2026-06-01T00:00:00.000Z'),
};

describe('exposeModerationFor', () => {
  it('DRIVER_RAIL y ADMIN_RAIL → true', () => {
    expect(exposeModerationFor(InternalAudience.DRIVER_RAIL)).toBe(true);
    expect(exposeModerationFor(InternalAudience.ADMIN_RAIL)).toBe(true);
  });

  it('PUBLIC_RAIL, SERVICE_RAIL y riel ausente → false (fail-closed)', () => {
    expect(exposeModerationFor(InternalAudience.PUBLIC_RAIL)).toBe(false);
    expect(exposeModerationFor(InternalAudience.SERVICE_RAIL)).toBe(false);
    expect(exposeModerationFor(undefined)).toBe(false);
  });
});

describe('scopeAggregateForRail · scoping de moderación por riel', () => {
  it('DRIVER_RAIL → moderación VISIBLE (transparencia, el propio conductor)', () => {
    const out = scopeAggregateForRail(FLAGGED, InternalAudience.DRIVER_RAIL);
    expect(out.flagged).toBe(true);
    expect(out.flagReason).toBe('suspension');
  });

  it('ADMIN_RAIL → moderación VISIBLE (revisión del operador)', () => {
    const out = scopeAggregateForRail(FLAGGED, InternalAudience.ADMIN_RAIL);
    expect(out.flagged).toBe(true);
    expect(out.flagReason).toBe('suspension');
  });

  it('PUBLIC_RAIL → moderación ZEROEADA (IDOR cerrado), reputación pública intacta', () => {
    const out = scopeAggregateForRail(FLAGGED, InternalAudience.PUBLIC_RAIL);
    expect(out.flagged).toBe(false);
    expect(out.flagReason).toBeNull();
    // Reputación pública NO se toca.
    expect(out.rollingAvg30d).toBe(3.2);
    expect(out.count30d).toBe(40);
    expect(out.role).toBe('DRIVER');
    expect(out.lastComputedAt).toEqual(FLAGGED.lastComputedAt);
  });

  it('SERVICE_RAIL → moderación ZEROEADA (dispatch solo scorea avg/count)', () => {
    const out = scopeAggregateForRail(FLAGGED, InternalAudience.SERVICE_RAIL);
    expect(out.flagged).toBe(false);
    expect(out.flagReason).toBeNull();
    expect(out.rollingAvg30d).toBe(3.2);
  });

  it('riel ausente → moderación ZEROEADA (fail-closed)', () => {
    const out = scopeAggregateForRail(FLAGGED, undefined);
    expect(out.flagged).toBe(false);
    expect(out.flagReason).toBeNull();
  });

  it('NO muta el agregado de entrada (devuelve copia)', () => {
    scopeAggregateForRail(FLAGGED, InternalAudience.PUBLIC_RAIL);
    expect(FLAGGED.flagged).toBe(true);
    expect(FLAGGED.flagReason).toBe('suspension');
  });
});
