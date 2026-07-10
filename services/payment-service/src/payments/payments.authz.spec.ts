/**
 * Spec de la DEFENSA EN PROFUNDIDAD del refund (BR-P06 · money-OUT). Simetría con `payouts.authz.spec`:
 * el refund es una mutación de PLATA como el payout, así que re-valida en el servicio los MISMOS gates que
 * el admin-bff ya exige en su borde — RBAC (@Roles FINANCE/ADMIN/SUPERADMIN) + step-up MFA (@RequireStepUpMfa
 * + StepUpMfaGuard). El servicio NO confía en el caller: es la última línea.
 *
 * Estilo del repo (audience-scoping.spec / payouts.authz.spec): ejercitamos los guards REALES leyendo la
 * metadata GENUINA aplicada al handler `refund` (vía Reflector), sin re-declarar lo esperado. Si alguien
 * afloja el gate (quita el step-up o el RolesGuard del refund), este test lo caza.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenError, SystemClock } from '@veo/utils';
import { RolesGuard, StepUpMfaGuard, type AuthenticatedUser } from '@veo/auth';
import { AdminRole } from '@veo/shared-types';
import { PaymentsController } from './payments.controller';

/**
 * ExecutionContext mínimo que apunta al HANDLER y CLASE reales (para que el Reflector lea la metadata
 * @Roles / @RequireStepUpMfa verdadera) y carga `req.user` con el operador simulado.
 */
function ctxFor(
  handler: (...args: never[]) => unknown,
  user: Partial<AuthenticatedUser>,
): ExecutionContext {
  const req = { user };
  return {
    getHandler: () => handler,
    getClass: () => PaymentsController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function operator(roles: AdminRole[]): Partial<AuthenticatedUser> {
  return { userId: 'op-1', roles } as Partial<AuthenticatedUser>;
}

const refund = PaymentsController.prototype.refund;
const rolesGuard = new RolesGuard(new Reflector());

describe('RolesGuard · el refund es acción de FINANZAS (BR-P06 · finance:refund)', () => {
  for (const role of [AdminRole.FINANCE, AdminRole.ADMIN, AdminRole.SUPERADMIN]) {
    it(`${role} → ACEPTADO (rol autorizado a mover money-OUT)`, () => {
      expect(rolesGuard.canActivate(ctxFor(refund, operator([role])))).toBe(true);
    });
  }

  it('SUPPORT_L1 → RECHAZADO (403 · soporte NO refunda, es acción de finanzas)', () => {
    expect(() => rolesGuard.canActivate(ctxFor(refund, operator([AdminRole.SUPPORT_L1])))).toThrow(
      ForbiddenError,
    );
  });
});

describe('StepUpMfaGuard · defensa en el BORDE del refund (simetría con payouts)', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  const stepUpGuard = new StepUpMfaGuard(new Reflector(), new SystemClock());

  it('hardened + SIN MFA fresca → RECHAZADO en el borde (ANTES del service)', () => {
    process.env.NODE_ENV = 'production';
    const ctx = ctxFor(refund, operator([AdminRole.FINANCE])); // sin mfaVerifiedAt
    expect(() => stepUpGuard.canActivate(ctx)).toThrow(ForbiddenError);
  });

  it('hardened + MFA fresca → pasa el borde (el service decide el resto)', () => {
    process.env.NODE_ENV = 'production';
    const fresh = {
      ...operator([AdminRole.FINANCE]),
      mfaVerifiedAt: Math.floor(Date.now() / 1000),
    };
    expect(stepUpGuard.canActivate(ctxFor(refund, fresh))).toBe(true);
  });

  it('NO hardened (local/dev) → el step-up se omite (el @Roles sigue protegiendo)', () => {
    process.env.NODE_ENV = 'development';
    const ctx = ctxFor(refund, operator([AdminRole.FINANCE])); // sin mfaVerifiedAt
    expect(stepUpGuard.canActivate(ctx)).toBe(true);
  });
});
