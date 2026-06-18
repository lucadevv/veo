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
