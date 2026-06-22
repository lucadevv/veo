/**
 * Spec del SCOPING POR RIEL en HTTP de payment-service (cross-rail / confused-deputy H7 · ADR-014 §5.5).
 * Ejercita el `AudienceGuard` REAL leyendo la metadata `@Audiences(...)` GENUINA aplicada a los handlers
 * (vía Reflector), sin re-declarar los rieles esperados: si alguien cambia el riel de un endpoint, el test
 * lo refleja.
 *
 * F3a abrió a service-rail SOLO `POST /charge` y `GET /debt` (+ el gRPC GetPayment, cubierto aparte). El
 * resto de los comandos de pago NO se abren (mínimo privilegio). Por cada superficie probamos las DOS
 * direcciones que importan: un riel PERMITIDO pasa, uno NO permitido es RECHAZADO (403 · ForbiddenError).
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenError } from '@veo/utils';
import { AudienceGuard, InternalAudience, type InternalAudience as Rail } from '@veo/auth';
import { PaymentsController } from './payments.controller';
import { PromotionsController } from '../promotions/promotions.controller';

/**
 * ExecutionContext mínimo que apunta a un HANDLER y CLASE reales (para que el Reflector lea la metadata
 * @Audiences verdadera) y carga `req.user.aud` con el riel del caller simulado.
 */
function ctxFor(
  controller: new (...args: never[]) => object,
  handler: (...args: never[]) => unknown,
  aud: Rail,
): ExecutionContext {
  const req = { user: { aud } };
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new AudienceGuard(new Reflector());

describe('AudienceGuard · scoping por riel HTTP de payment (ADR-014 §5.5)', () => {
  describe('POST /payments/charge · SUMA service-rail (booking dispara el cobro · F3b)', () => {
    const handler = PaymentsController.prototype.charge;

    it('service-rail (PERMITIDO · booking) pasa', () => {
      const ctx = ctxFor(PaymentsController, handler, InternalAudience.SERVICE_RAIL);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    for (const aud of [
      InternalAudience.PUBLIC_RAIL,
      InternalAudience.DRIVER_RAIL,
      InternalAudience.ADMIN_RAIL,
    ]) {
      it(`${aud} (riel previo · compat) pasa`, () => {
        const ctx = ctxFor(PaymentsController, handler, aud);
        expect(guard.canActivate(ctx)).toBe(true);
      });
    }
  });

  describe('GET /payments/debt · SUMA service-rail (gate de deuda al reservar)', () => {
    const handler = PaymentsController.prototype.debt;

    it('service-rail (PERMITIDO · booking) pasa', () => {
      const ctx = ctxFor(PaymentsController, handler, InternalAudience.SERVICE_RAIL);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('public-rail (riel previo · debt-proxy del home) pasa', () => {
      const ctx = ctxFor(PaymentsController, handler, InternalAudience.PUBLIC_RAIL);
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe('POST /payments/:tripId/refund · NO se abre a service-rail (mínimo privilegio)', () => {
    const handler = PaymentsController.prototype.refund;

    it('admin-rail (PERMITIDO) pasa', () => {
      const ctx = ctxFor(PaymentsController, handler, InternalAudience.ADMIN_RAIL);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('service-rail (NO permitido) → 403 ForbiddenError', () => {
      const ctx = ctxFor(PaymentsController, handler, InternalAudience.SERVICE_RAIL);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenError);
    });
  });

  describe('POST /payments/:id/retry-charge (saldar deuda) · NO service-rail', () => {
    const handler = PaymentsController.prototype.retryCharge;

    it('public-rail (PERMITIDO) pasa', () => {
      const ctx = ctxFor(PaymentsController, handler, InternalAudience.PUBLIC_RAIL);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('service-rail (NO permitido) → 403 ForbiddenError', () => {
      const ctx = ctxFor(PaymentsController, handler, InternalAudience.SERVICE_RAIL);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenError);
    });
  });

  describe('POST /promotions/redeem · NO se abre a service-rail (mínimo privilegio · nivel clase)', () => {
    const handler = PromotionsController.prototype.redeem;

    it('public-rail (PERMITIDO) pasa', () => {
      const ctx = ctxFor(PromotionsController, handler, InternalAudience.PUBLIC_RAIL);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('service-rail (NO permitido) → 403 ForbiddenError', () => {
      const ctx = ctxFor(PromotionsController, handler, InternalAudience.SERVICE_RAIL);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenError);
    });
  });
});
