/**
 * Spec del controlador gRPC de rating — foco en el SCOPING DE MODERACIÓN POR RIEL (anti-IDOR / fuga de
 * moderación H8). `flagged`/`flagReason` son el estado de MODERACIÓN del conductor (revisión/suspensión),
 * NO reputación pública. La regla:
 *   1) PUBLIC_RAIL (pasajero pidiendo el agregado de cualquier conductor) → flags ZEROEADOS (IDOR cerrado).
 *   2) DRIVER_RAIL (el conductor sobre su propio record) → flags VISIBLES (transparencia).
 *   3) ADMIN_RAIL (revisión del operador) → flags VISIBLES.
 *   4) SERVICE_RAIL (dispatch, solo scorea avg/count) → flags ZEROEADOS.
 *   5) avg/count se devuelven SIEMPRE (reputación pública, todos los rieles).
 *   6) firma ausente/inválida → UNAUTHENTICATED.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { status as GrpcStatus, Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import {
  grpcIdentityMetadata,
  InternalAudience,
  type AuthenticatedUser,
  type InternalAudience as InternalAudienceType,
} from '@veo/auth';
import { RatingGrpcController } from './rating.grpc.controller';
import type { RatingsService, AggregateEntity } from '../ratings/ratings.service';
import type { Env } from '../config/env.schema';

const INTERNAL_IDENTITY_SECRET = 's'.repeat(32);

const CALLER: AuthenticatedUser = {
  userId: 'u-1',
  type: 'passenger',
  roles: [],
  sessionId: 'sess-1',
};

/** Metadata gRPC entrante FIRMADA con el riel `aud` indicado. */
function signedMetaAs(aud: InternalAudienceType): Metadata {
  const meta = new Metadata();
  const headers = grpcIdentityMetadata(CALLER, INTERNAL_IDENTITY_SECRET, aud);
  for (const [k, v] of Object.entries(headers)) meta.set(k, v);
  return meta;
}

const FLAGGED_AGG: AggregateEntity = {
  subjectId: 'd1',
  role: 'DRIVER',
  rollingAvg30d: 3.2,
  count30d: 40,
  flagged: true,
  flagReason: 'suspension',
  lastComputedAt: new Date('2026-06-01T00:00:00.000Z'),
};

function makeController(agg: AggregateEntity | null = FLAGGED_AGG): RatingGrpcController {
  const ratings = {
    getAggregate: vi.fn(async () => agg),
  } as unknown as RatingsService;
  const config = new ConfigService<Env, true>({
    INTERNAL_IDENTITY_SECRET,
  } as unknown as Env);
  return new RatingGrpcController(ratings, config);
}

/** Extrae el `code` del error gRPC envuelto en RpcException. */
function grpcCodeOf(err: unknown): number | undefined {
  if (err instanceof RpcException) {
    const e = err.getError();
    if (typeof e === 'object' && e !== null && 'code' in e) {
      return (e as { code: number }).code;
    }
  }
  return undefined;
}

describe('RatingGrpcController · scoping de moderación por riel (anti-IDOR)', () => {
  it('PUBLIC_RAIL · pasajero pidiendo el agregado de un conductor → flags ZEROEADOS (IDOR cerrado)', async () => {
    const ctrl = makeController();
    const reply = await ctrl.getAggregate({ subjectId: 'd1' }, signedMetaAs(InternalAudience.PUBLIC_RAIL));
    expect(reply.flagged).toBe(false);
    expect(reply.flagReason).toBe('');
    // Reputación pública SIGUE viajando.
    expect(reply.rollingAvg30d).toBe(3.2);
    expect(reply.count30d).toBe(40);
    expect(reply.found).toBe(true);
  });

  it('DRIVER_RAIL · el conductor sobre su propio record → flags VISIBLES (transparencia)', async () => {
    const ctrl = makeController();
    const reply = await ctrl.getAggregate({ subjectId: 'd1' }, signedMetaAs(InternalAudience.DRIVER_RAIL));
    expect(reply.flagged).toBe(true);
    expect(reply.flagReason).toBe('suspension');
    expect(reply.rollingAvg30d).toBe(3.2);
  });

  it('ADMIN_RAIL · revisión del operador → flags VISIBLES', async () => {
    const ctrl = makeController();
    const reply = await ctrl.getAggregate({ subjectId: 'd1' }, signedMetaAs(InternalAudience.ADMIN_RAIL));
    expect(reply.flagged).toBe(true);
    expect(reply.flagReason).toBe('suspension');
  });

  it('SERVICE_RAIL · dispatch (solo scorea avg/count) → flags ZEROEADOS', async () => {
    const ctrl = makeController();
    const reply = await ctrl.getAggregate({ subjectId: 'd1' }, signedMetaAs(InternalAudience.SERVICE_RAIL));
    expect(reply.flagged).toBe(false);
    expect(reply.flagReason).toBe('');
    expect(reply.rollingAvg30d).toBe(3.2);
    expect(reply.count30d).toBe(40);
  });

  it('firma ausente → UNAUTHENTICATED', async () => {
    const ctrl = makeController();
    let caught: unknown;
    try {
      await ctrl.getAggregate({ subjectId: 'd1' }, new Metadata());
    } catch (err) {
      caught = err;
    }
    expect(grpcCodeOf(caught)).toBe(GrpcStatus.UNAUTHENTICATED);
  });

  it('sin agregado → EMPTY (found=false, sin flags) cualquiera sea el riel', async () => {
    const ctrl = makeController(null);
    const reply = await ctrl.getAggregate({ subjectId: 'dX' }, signedMetaAs(InternalAudience.DRIVER_RAIL));
    expect(reply.found).toBe(false);
    expect(reply.flagged).toBe(false);
    expect(reply.flagReason).toBe('');
  });
});
