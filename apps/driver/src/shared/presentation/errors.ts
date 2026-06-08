import {ApiError} from '@veo/api-client';
import type {TFunction} from 'i18next';

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
