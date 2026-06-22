/**
 * Spec del RBAC de PLATA de payouts (BR-S07 · VEO_SPEC_ADMIN L98/L102/L246/L254).
 *
 * `finance:payout` —ejecutar/transferir la liquidación— es EXCLUSIVO de FINANCE: "ni ADMIN ni SUPERADMIN
 * lo ven; el servidor los negaría". Las dos mutaciones de plata (`POST /payouts/run` y
 * `POST /payouts/drivers/:driverId/release`) deben aceptar SOLO FINANCE y negar ADMIN/SUPERADMIN.
 *
 * Estilo del repo (audience-scoping.spec): ejercitamos el `RolesGuard` REAL leyendo la metadata `@Roles(...)`
 * GENUINA aplicada a los handlers (vía Reflector), sin re-declarar los roles esperados. Si alguien afloja el
 * gate (re-agrega ADMIN/SUPERADMIN), este test lo caza. Sumamos un chequeo de BORDE del step-up MFA
 * (@RequireStepUpMfa + StepUpMfaGuard) en entorno hardened: la mutación de plata se rechaza ANTES del service
 * cuando el operador no trae MFA fresca.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenError, SystemClock } from '@veo/utils';
import {
  RolesGuard,
  StepUpMfaGuard,
  type AuthenticatedUser,
} from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { PayoutsController } from './payouts.controller';

/**
 * ExecutionContext mínimo que apunta a un HANDLER y CLASE reales (para que el Reflector lea la metadata
 * @Roles / @RequireStepUpMfa verdadera) y carga `req.user` con el operador simulado.
 */
function ctxFor(
  handler: (...args: never[]) => unknown,
  user: Partial<AuthenticatedUser>,
): ExecutionContext {
  const req = { user };
  return {
    getHandler: () => handler,
    getClass: () => PayoutsController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const rolesGuard = new RolesGuard(new Reflector());

function operator(roles: AdminRole[]): Partial<AuthenticatedUser> {
  return { userId: 'op-1', roles } as Partial<AuthenticatedUser>;
}

const MONEY_MOVERS: { name: string; handler: (...args: never[]) => unknown }[] = [
  { name: 'POST /payouts/run', handler: PayoutsController.prototype.run },
  {
    name: 'POST /payouts/drivers/:driverId/release',
    handler: PayoutsController.prototype.release,
  },
];

describe('RolesGuard · finance:payout es EXCLUSIVO de FINANCE (VEO_SPEC_ADMIN)', () => {
  for (const { name, handler } of MONEY_MOVERS) {
    describe(name, () => {
      it('FINANCE → ACEPTADO (es su acción exclusiva)', () => {
        const ctx = ctxFor(handler, operator([AdminRole.FINANCE]));
        expect(rolesGuard.canActivate(ctx)).toBe(true);
      });

      it('ADMIN → RECHAZADO (403 · el servidor lo niega aunque sea rango alto)', () => {
        const ctx = ctxFor(handler, operator([AdminRole.ADMIN]));
        expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenError);
      });

      it('SUPERADMIN → RECHAZADO (403 · ni el superadmin mueve plata de payout)', () => {
        const ctx = ctxFor(handler, operator([AdminRole.SUPERADMIN]));
        expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenError);
      });
    });
  }
});

describe('StepUpMfaGuard · defensa en el BORDE de las mutaciones de plata (BR-S07)', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  const stepUpGuard = new StepUpMfaGuard(new Reflector(), new SystemClock());

  for (const { name, handler } of MONEY_MOVERS) {
    describe(name, () => {
      it('hardened + SIN MFA fresca → RECHAZADO en el borde (ANTES del service)', () => {
        process.env.NODE_ENV = 'production';
        const ctx = ctxFor(handler, operator([AdminRole.FINANCE])); // sin mfaVerifiedAt
        expect(() => stepUpGuard.canActivate(ctx)).toThrow(ForbiddenError);
      });

      it('hardened + MFA fresca → pasa el borde (el service decide por monto)', () => {
        process.env.NODE_ENV = 'production';
        const fresh = {
          ...operator([AdminRole.FINANCE]),
          mfaVerifiedAt: Math.floor(Date.now() / 1000),
        };
        const ctx = ctxFor(handler, fresh);
        expect(stepUpGuard.canActivate(ctx)).toBe(true);
      });
    });
  }
});
