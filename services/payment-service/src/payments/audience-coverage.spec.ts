/**
 * Spec de COBERTURA DE RIEL de payment-service (invariante ejecutable · cross-rail / confused-deputy H7).
 * Espeja `audience-coverage.spec.ts` de identity-service y lo extiende a payment.
 *
 * RAÍZ que vuelve verificable: `core.module.ts` amplió `ALLOWED_AUDIENCES` a los 4 rieles (incl. service-rail)
 * y `AudienceGuard` es FAIL-OPEN sin `@Audiences` (`audience.guard.ts`: `if (!required) return true`). Hoy los
 * controllers están anotados, pero NADA garantiza que un endpoint/RPC FUTURO no quede abierto a service-rail
 * por OLVIDO. Este test convierte "todo endpoint interno declara su riel" en un INVARIANTE que falla en CI.
 *
 * Dos superficies:
 *  1. HTTP — TODO controller que monta `InternalIdentityGuard` debe scopear su riel: o `@Audiences` de CLASE
 *     (cubre todo handler futuro de esa clase), o `@Audiences` por MÉTODO en CADA handler de ruta. Un handler
 *     bajo el guard SIN ninguno de los dos → fail-open → FALLA acá.
 *  2. gRPC — TODO handler `@GrpcMethod` del controller gRPC debe tener una entrada en `GRPC_METHOD_AUDIENCES`
 *     (el mapa per-RPC que `requireIdentity` consulta). Un RPC nuevo sin entrada quedaría sin scoping de riel.
 *
 * NO toca `packages/auth/audience.guard.ts` (afecta a toda la flota · fuera de scope): cierra el hueco con
 * un TEST en payment, no cambiando el guard.
 */
import { describe, it, expect } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PATTERN_HANDLER_METADATA } from '@nestjs/microservices/constants';
import { AUDIENCES_KEY, type InternalAudience } from '@veo/auth';
import { PaymentsController } from './payments.controller';
import { PromotionsController } from '../promotions/promotions.controller';
import { AffiliationsController } from '../affiliations/affiliations.controller';
import { IncentivesController } from '../incentives/incentives.controller';
import { PayoutsController } from '../payouts/payouts.controller';
import { AnalyticsController } from '../analytics/analytics.controller';
import { DriverPaymentsController } from '../drivers/driver-payments.controller';
import { CommissionController } from '../commission/commission.controller';
import { CommissionRateController } from '../commission/commission-rate.controller';
import { PaymentGrpcController, GRPC_METHOD_AUDIENCES } from '../grpc/payment.grpc.controller';

type AnyCtor = new (...args: never[]) => object;
type HandlerMap = Record<string, ((...args: never[]) => unknown) | undefined>;

function protoOf(controller: AnyCtor): HandlerMap {
  return controller.prototype as unknown as HandlerMap;
}

/** Handlers de RUTA HTTP del controller (Nest deja PATH + METHOD sobre cada @Get/@Post/etc.). */
function routeHandlerNames(controller: AnyCtor): string[] {
  const proto = protoOf(controller);
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .filter((name) => {
      const handler = proto[name];
      if (typeof handler !== 'function') return false;
      const hasPath = Reflect.getMetadata(PATH_METADATA, handler) !== undefined;
      const hasMethod = Reflect.getMetadata(METHOD_METADATA, handler) !== undefined;
      return hasPath && hasMethod;
    });
}

/** Handlers gRPC del controller (Nest deja PATTERN_HANDLER_METADATA sobre cada @GrpcMethod). */
function grpcHandlerNames(controller: AnyCtor): string[] {
  const proto = protoOf(controller);
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .filter((name) => {
      const handler = proto[name];
      if (typeof handler !== 'function') return false;
      return Reflect.getMetadata(PATTERN_HANDLER_METADATA, handler) !== undefined;
    });
}

/** ¿La CLASE declara `@Audiences(...)` (cubre todo handler futuro)? */
function classHasAudiences(controller: AnyCtor): boolean {
  const aud = Reflect.getMetadata(AUDIENCES_KEY, controller) as InternalAudience[] | undefined;
  return !!aud && aud.length > 0;
}

/** ¿El handler declara `@Audiences(...)` por método? */
function handlerHasAudiences(handler: ((...args: never[]) => unknown) | undefined): boolean {
  if (!handler) return false;
  const aud = Reflect.getMetadata(AUDIENCES_KEY, handler) as InternalAudience[] | undefined;
  return !!aud && aud.length > 0;
}

/**
 * TODOS los controllers HTTP que montan `InternalIdentityGuard`. Si se agrega uno nuevo, sumalo acá — el
 * test entonces exige que scopee su riel. (PaymentsController es el único MIXTO; el resto son UNIFORMES con
 * @Audiences de clase — el test verifica ambos modos sin distinguir, así un cambio de modo no lo rompe.)
 */
const HTTP_CONTROLLERS: AnyCtor[] = [
  PaymentsController,
  PromotionsController,
  AffiliationsController,
  IncentivesController,
  PayoutsController,
  AnalyticsController,
  DriverPaymentsController,
  CommissionController,
  CommissionRateController,
];

describe('Cobertura de riel · payment-service (sin huecos fail-open)', () => {
  describe('HTTP · todo handler bajo InternalIdentityGuard declara @Audiences (clase o método)', () => {
    for (const Controller of HTTP_CONTROLLERS) {
      it(`${Controller.name}: ningún handler de ruta queda sin riel`, () => {
        // Clase con @Audiences → cubre todo handler futuro: invariante satisfecho por construcción.
        if (classHasAudiences(Controller)) {
          expect(classHasAudiences(Controller)).toBe(true);
          return;
        }
        // Controller MIXTO (sin @Audiences de clase): CADA handler debe declararlo por método.
        const handlerNames = routeHandlerNames(Controller);
        expect(handlerNames.length).toBeGreaterThan(0); // sanity: hay handlers que enumerar
        const proto = protoOf(Controller);
        const sinRiel = handlerNames.filter((name) => !handlerHasAudiences(proto[name]));
        expect(
          sinRiel,
          `${Controller.name}: handlers bajo AudienceGuard SIN @Audiences → fail-open cross-rail ` +
            `(AudienceGuard es no-op sin metadata): ${sinRiel.join(', ')}. ` +
            `Agregales @Audiences(InternalAudience.<RIEL>) o ponelo a nivel de clase.`,
        ).toEqual([]);
      });
    }
  });

  describe('gRPC · todo @GrpcMethod tiene entrada en GRPC_METHOD_AUDIENCES (scoping per-RPC)', () => {
    const grpcHandlers = grpcHandlerNames(PaymentGrpcController);

    it('detecta los handlers gRPC vía reflection (sanity: hay RPCs que enumerar)', () => {
      expect(grpcHandlers.length).toBeGreaterThan(0);
    });

    it('TODO RPC declara su riel en GRPC_METHOD_AUDIENCES (sin RPC sin scoping)', () => {
      const covered = new Set(Object.keys(GRPC_METHOD_AUDIENCES));
      // El nombre del método del handler debe coincidir con la clave del mapa (GetPayment, etc.).
      const sinRiel = grpcHandlers
        .map((name) => name.charAt(0).toUpperCase() + name.slice(1))
        .filter((rpcName) => !covered.has(rpcName));
      expect(
        sinRiel,
        `RPCs @GrpcMethod sin entrada en GRPC_METHOD_AUDIENCES → sin scoping de riel per-RPC: ` +
          `${sinRiel.join(', ')}. Agregá su riel al mapa.`,
      ).toEqual([]);
    });
  });
});
