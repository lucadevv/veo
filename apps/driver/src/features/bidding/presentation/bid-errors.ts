import { ApiError } from '@veo/api-client';

/**
 * true si el error significa que la puja YA NO ESTÁ (otro conductor la tomó / venció / se canceló): el
 * board pasó a CLOSED_MATCHED/EXPIRED (409 ConflictError) o desapareció (404 NotFoundError). La UI lo usa
 * para mostrar "ya no disponible" en vez del error crudo, y los hooks para soltar la puja de la lista.
 */
export function isBidGoneError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.status === 404);
}
