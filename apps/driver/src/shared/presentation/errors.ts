import { ApiError } from '@veo/api-client';
import type { TFunction } from 'i18next';

/**
 * Traduce cualquier error a un mensaje accionable para el conductor.
 * - `ApiError` de red (status 0) → mensaje de conexión.
 * - `ApiError` de negocio → el mensaje del BFF (ya viene en español y es seguro mostrarlo).
 * - Otros errores conocidos → su `message`.
 * - Desconocido → mensaje genérico.
 */
export function toErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return t('errors.networkDescription');
    }
    return error.message || t('errors.genericDescription');
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return t('errors.genericDescription');
}

/** true si el error es un fallo de red (sin respuesta del servidor). */
export function isNetworkError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

/**
 * true si el error es un conflicto del servidor (409 `CONFLICT`). En el alta de vehículo lo emite fleet
 * cuando la placa ya existe ("Ya existe un vehículo con esa placa"). Como el backend es idempotente para
 * la placa PROPIA del conductor (un re-submit del mismo vehículo avanza), un 409 que llega a la app es
 * siempre una placa de OTRO conductor → se mapea al campo placa, no a un banner genérico.
 */
export function isConflictError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

/**
 * Código del backend (identity, vía driver-bff) cuando el DNI que el conductor intenta registrar YA
 * pertenece a OTRA cuenta. Es el contrato TIPADO (code, no el texto del mensaje) que el `PATCH
 * /drivers/me/personal` emite como backstop de carrera del pre-check `POST /drivers/me/check-dni`.
 * No hardcodear el string fuera de acá.
 */
export const DNI_ALREADY_REGISTERED_CODE = 'DNI_ALREADY_REGISTERED';

/**
 * true si el error es "el DNI ya está registrado en otra cuenta" (`DNI_ALREADY_REGISTERED`), detectado
 * por el `code` TIPADO del `ApiError` (no por el status ni el mensaje). El alta lo trata igual que un
 * pre-check `{ exists: true }`: corta con "DNI ya registrado" sin subir nada.
 */
export function isDniAlreadyRegisteredError(error: unknown): boolean {
  return error instanceof ApiError && error.code === DNI_ALREADY_REGISTERED_CODE;
}
