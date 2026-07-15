/**
 * Spec de COBERTURA DE RIEL (invariante ejecutable · cross-rail / confused-deputy H7).
 *
 * `DriversController` es un controller MIXTO: monta `AudienceGuard` a nivel CLASE (corre para todos los
 * handlers) pero SIN `@Audiences` de clase — cada handler declara su riel POR MÉTODO. El problema latente:
 * `AudienceGuard` es FAIL-OPEN cuando un handler NO tiene metadata `@Audiences` (`audience.guard.ts`:
 * `if (!required || required.length === 0) return true`). Hoy los handlers están todos anotados, pero nada
 * impide que un handler FUTURO se agregue SIN `@Audiences` y quede silenciosamente fail-open (cross-rail
 * abierto en ese endpoint).
 *
 * Este test convierte esa fragilidad en un INVARIANTE: enumera programáticamente TODOS los handlers de ruta
 * de `DriversController` (vía la metadata de routing que Nest deja al decorar con @Get/@Post/etc.) y asserta
 * que CADA UNO declara `@Audiences` (la `AUDIENCES_KEY` de @veo/auth) con al menos un riel. Si mañana alguien
 * agrega `@Post('foo') foo() {}` sin `@Audiences`, el test lo lista y FALLA — antes de que llegue a prod.
 *
 * NOTA: solo aplica a controllers MIXTOS (AudienceGuard sin `@Audiences` de clase). Los controllers
 * UNIFORMES (users/referrals/consents/kyc, con `@Audiences` de clase) ya cubren sus handlers futuros vía la
 * clase, y `AdminController` también lleva `@Audiences` de clase — por eso NO necesitan esta enumeración.
 */
import { describe, it, expect } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { AUDIENCES_KEY, type InternalAudience } from '@veo/auth';
import { DriversController } from './drivers.controller';

/**
 * Enumera los nombres de método del prototype del controller que son HANDLERS DE RUTA. Nest deja
 * `PATH_METADATA` + `METHOD_METADATA` sobre cada método decorado con @Get/@Post/@Patch/@Delete/etc.;
 * filtrar por ambos descarta el constructor, getters/setters y helpers privados sin routing.
 */
// El prototype es un mapa nombre→método. El cast puntual (vía `unknown`, requerido por tsc al no haber
// index signature en la clase) está acotado a este helper de reflection del test.
type HandlerMap = Record<string, ((...args: never[]) => unknown) | undefined>;

function protoOf(controller: new (...args: never[]) => object): HandlerMap {
  return controller.prototype as unknown as HandlerMap;
}

function routeHandlerNames(controller: new (...args: never[]) => object): string[] {
  const proto = protoOf(controller);
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .filter((name) => {
      const handler = proto[name];
      if (typeof handler !== 'function') return false;
      // Si Nest le puso ruta (PATH) y verbo (METHOD), es un handler HTTP expuesto.
      const hasPath = Reflect.getMetadata(PATH_METADATA, handler) !== undefined;
      const hasMethod = Reflect.getMetadata(METHOD_METADATA, handler) !== undefined;
      return hasPath && hasMethod;
    });
}

/** Lee los rieles declarados por `@Audiences(...)` en un handler (undefined si no tiene metadata). */
function audiencesOf(
  handler: ((...args: never[]) => unknown) | undefined,
): InternalAudience[] | undefined {
  if (!handler) return undefined;
  return Reflect.getMetadata(AUDIENCES_KEY, handler) as InternalAudience[] | undefined;
}

describe('Cobertura de riel · DriversController (controller MIXTO bajo AudienceGuard)', () => {
  const proto = protoOf(DriversController);
  const handlerNames = routeHandlerNames(DriversController);

  it('detecta los handlers de ruta vía reflection (sanity: hay handlers que enumerar)', () => {
    // Si esto se rompe, el mecanismo de enumeración dejó de ver las rutas (no que falten rieles):
    // el invariante de abajo quedaría vacío y pasaría en falso. Este sanity lo protege.
    expect(handlerNames.length).toBeGreaterThan(0);
  });

  it('TODO handler de ruta declara @Audiences con al menos un riel (sin huecos fail-open)', () => {
    const sinRiel = handlerNames.filter((name) => {
      const audiences = audiencesOf(proto[name]);
      return !audiences || audiences.length === 0;
    });

    expect(
      sinRiel,
      `Handlers bajo AudienceGuard SIN @Audiences → fail-open cross-rail (AudienceGuard es no-op sin ` +
        `metadata): ${sinRiel.join(', ')}. Agregales @Audiences(InternalAudience.<RIEL>).`,
    ).toEqual([]);
  });
});
