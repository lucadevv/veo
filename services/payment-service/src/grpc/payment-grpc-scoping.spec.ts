/**
 * Spec del SCOPING POR RIEL del controlador gRPC de payment (per-RPC · confused-deputy H7 · ADR-014 §5.5).
 * F3a movió este controller del `ALLOWED_AUDIENCES` GLOBAL a un mapa per-método (`GRPC_METHOD_AUDIENCES`,
 * espejo de identity-service). Por cada RPC probamos las direcciones que importan:
 *  - GetPayment ACEPTA service-rail (booking lee el cobro del carpooling tras aprobar) Y sigue aceptando
 *    los rieles previos (public/driver/admin · compat con los BFFs).
 *  - GetPaymentByTrip y GetUserCredit RECHAZAN service-rail (mínimo privilegio: NO se abrieron) y siguen
 *    aceptando los rieles previos.
 *  - Sin firma → UNAUTHENTICATED; firma válida pero riel no permitido → PERMISSION_DENIED (dos rechazos
 *    honestos y distintos).
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { status as GrpcStatus, Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import {
  grpcIdentityMetadata,
  InternalAudience,
  type AuthenticatedUser,
  type InternalAudience as Rail,
} from '@veo/auth';
import { PaymentGrpcController } from './payment.grpc.controller';
import type { PaymentGrpcRepository } from './payment-grpc.repository';
import type { Env } from '../config/env.schema';

const INTERNAL_IDENTITY_SECRET = 's'.repeat(32);

const PRINCIPAL: AuthenticatedUser = {
  userId: 'u-1',
  type: 'passenger',
  roles: [],
  sessionId: 'sess-1',
};

/** Metadata gRPC entrante FIRMADA con el riel `aud` indicado. */
function signedMetaAs(aud: Rail): Metadata {
  const meta = new Metadata();
  const headers = grpcIdentityMetadata(PRINCIPAL, INTERNAL_IDENTITY_SECRET, aud);
  for (const [k, v] of Object.entries(headers)) meta.set(k, v);
  return meta;
}

const paymentRow = {
  id: 'p1',
  tripId: 't1',
  method: 'YAPE',
  status: 'CAPTURED',
  amountCents: 1000,
  grossCents: 1000,
  commissionCents: 200,
  feeCents: 0,
  tipCents: 0,
  externalRef: null,
  externalUid: null,
  checkoutUrl: null,
  qrCode: null,
  deepLink: null,
  cip: null,
  checkoutExpiresAt: null,
  failureReason: null,
};

function makeController(): PaymentGrpcController {
  const repo = {
    findPaymentById: vi.fn(async () => paymentRow),
    findPaymentByDedupKey: vi.fn(async () => paymentRow),
    sumCapturedTipCentsByTrip: vi.fn(async () => 0),
    findUserCreditByUser: vi.fn(async () => ({ userId: 'u-1', balanceCents: 500 })),
  } as unknown as PaymentGrpcRepository;
  const config = new ConfigService<Env, true>({
    INTERNAL_IDENTITY_SECRET,
  } as unknown as Env);
  return new PaymentGrpcController(repo, config);
}

/** Extrae el code gRPC del error lanzado (RpcException envuelve `{ code, message }`). */
function rpcCodeOf(err: unknown): number | undefined {
  if (err instanceof RpcException) {
    const e = err.getError();
    return typeof e === 'object' && e !== null ? (e as { code?: number }).code : undefined;
  }
  return undefined;
}

describe('PaymentGrpcController · scoping por riel (per-RPC · ADR-014 §5.5)', () => {
  describe('GetPayment · SUMA service-rail (booking lee el cobro del carpooling)', () => {
    it('service-rail (PERMITIDO) pasa y devuelve el pago', async () => {
      const ctrl = makeController();
      const reply = await ctrl.getPayment(
        { id: 'p1' },
        signedMetaAs(InternalAudience.SERVICE_RAIL),
      );
      expect(reply.found).toBe(true);
      expect(reply.id).toBe('p1');
    });

    for (const aud of [
      InternalAudience.PUBLIC_RAIL,
      InternalAudience.DRIVER_RAIL,
      InternalAudience.ADMIN_RAIL,
    ]) {
      it(`${aud} (rieles previos · compat) sigue pasando`, async () => {
        const ctrl = makeController();
        const reply = await ctrl.getPayment({ id: 'p1' }, signedMetaAs(aud));
        expect(reply.found).toBe(true);
      });
    }
  });

  describe('GetPaymentByTrip · NO se abre a service-rail (mínimo privilegio)', () => {
    it('service-rail (NO permitido) → PERMISSION_DENIED', async () => {
      const ctrl = makeController();
      try {
        await ctrl.getPaymentByTrip({ tripId: 't1' }, signedMetaAs(InternalAudience.SERVICE_RAIL));
        expect.unreachable('debió rechazar el service-rail en GetPaymentByTrip');
      } catch (err) {
        expect(rpcCodeOf(err)).toBe(GrpcStatus.PERMISSION_DENIED);
      }
    });

    it('public-rail (riel previo) sigue pasando', async () => {
      const ctrl = makeController();
      const reply = await ctrl.getPaymentByTrip(
        { tripId: 't1' },
        signedMetaAs(InternalAudience.PUBLIC_RAIL),
      );
      expect(reply.found).toBe(true);
    });
  });

  describe('GetUserCredit · NO se abre a service-rail (mínimo privilegio)', () => {
    it('service-rail (NO permitido) → PERMISSION_DENIED', async () => {
      const ctrl = makeController();
      try {
        await ctrl.getUserCredit({ userId: 'u-1' }, signedMetaAs(InternalAudience.SERVICE_RAIL));
        expect.unreachable('debió rechazar el service-rail en GetUserCredit');
      } catch (err) {
        expect(rpcCodeOf(err)).toBe(GrpcStatus.PERMISSION_DENIED);
      }
    });

    it('admin-rail (riel previo) sigue pasando', async () => {
      const ctrl = makeController();
      const reply = await ctrl.getUserCredit(
        { userId: 'u-1' },
        signedMetaAs(InternalAudience.ADMIN_RAIL),
      );
      expect(reply.balanceCents).toBe(500);
    });
  });

  describe('autenticación vs autorización (dos rechazos honestos)', () => {
    it('sin firma → UNAUTHENTICATED', async () => {
      const ctrl = makeController();
      try {
        await ctrl.getPayment({ id: 'p1' }, new Metadata());
        expect.unreachable('debió rechazar la falta de firma');
      } catch (err) {
        expect(rpcCodeOf(err)).toBe(GrpcStatus.UNAUTHENTICATED);
      }
    });
  });
});
