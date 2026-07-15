import { HttpClient, driverOnboardResult, driverProfileView } from '@veo/api-client';
import { HttpRegistrationRepository } from '../http-registration-repository';
import type { LicenseOnboardInput } from '../../../domain';

/**
 * Pruebas de `onboardLicense` (subida DIFERIDA de la licencia tras el PATCH personal).
 *
 * BUG: `POST /drivers/onboard` devuelve SOLO el perfil FINO `{ driverId, backgroundCheckStatus }`
 * (identity `drivers.service.ts` → `{ driverId, backgroundCheckStatus }`; el driver-bff lo proxypasa
 * tal cual). El repo validaba esa respuesta con `driverProfileView`, que EXIGE `userId/phone/kycStatus/
 * currentStatus/documents/compliance/…`: Zod reventaba por campos faltantes y el onboard tiraba aunque
 * el backend respondiera 201 → la app reportaba un FALSO "no se pudo subir tu licencia".
 *
 * Usamos un `HttpClient` REAL con `fetchImpl` mockeado para EJERCITAR la validación Zod de verdad
 * (un mock de `post` se saltearía el `schema.parse`, que es justo lo que el bug rompía).
 */

const LICENSE_INPUT: LicenseOnboardInput = {
  licenseNumber: 'Q12345678',
  licenseExpiresAt: '2030-01-01',
};

/** Respuesta REAL del endpoint: perfil fino. */
const ONBOARD_RESPONSE = { driverId: 'drv_123', backgroundCheckStatus: 'PENDING' };

/** `HttpClient` real cuyo transporte (`fetch`) devuelve `body` con status 201; así corre el schema.parse. */
function httpReturning(body: unknown): HttpClient {
  const fetchImpl = jest.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
  return new HttpClient({ baseUrl: 'http://test.local/api/v1', fetchImpl, retries: 0 });
}

describe('HttpRegistrationRepository.onboardLicense · valida contra la respuesta FINA real', () => {
  it('resuelve OK cuando el endpoint devuelve { driverId, backgroundCheckStatus }', async () => {
    const repo = new HttpRegistrationRepository(httpReturning(ONBOARD_RESPONSE));

    await expect(repo.onboardLicense(LICENSE_INPUT)).resolves.toBeUndefined();
  });

  it('el schema fino (driverOnboardResult) ACEPTA la respuesta real del onboard', () => {
    expect(() => driverOnboardResult.parse(ONBOARD_RESPONSE)).not.toThrow();
  });

  it('REGRESIÓN: el perfil agregado (driverProfileView) RECHAZA esa misma respuesta (era el bug)', () => {
    // Esto demuestra POR QUÉ el onboard tiraba antes del fix: la respuesta fina no satisface el
    // perfil completo. Si esto dejara de tirar, el schema fino sería redundante.
    expect(() => driverProfileView.parse(ONBOARD_RESPONSE)).toThrow();
  });
});
