/**
 * Helpers LOCALES de la verificación de celular del pasajero (validación de forma + constantes de UI).
 *
 * El CONTRATO de los endpoints (`requestPhoneLink` / `requestPhoneLinkResult` / `verifyPhoneLink` y la
 * respuesta `passengerProfile`) vive en `@veo/api-client` (`mobile.ts`): es la única fuente de verdad de
 * la forma de request/response. Acá solo quedan las piezas que NO son contrato: la validación local del
 * número (para no disparar el POST con un valor inválido) y las longitudes que la presentación usa para
 * acotar inputs. El api-client no expone estas constantes porque son una preocupación de UI, no del wire.
 */

/** Longitud del código de verificación (alineado al OTP del auth y a `verifyPhoneLink.code.length(6)`). */
export const PHONE_CODE_LENGTH = 6;
/** Largo del celular peruano local (9 dígitos: 9XXXXXXXX). */
export const PHONE_LOCAL_LENGTH = 9;

/** Validación local del celular peruano: 9 dígitos y empieza por 9 (móviles PE). */
export function isPeruMobileValid(raw: string): boolean {
  return /^9\d{8}$/.test(raw.trim());
}
