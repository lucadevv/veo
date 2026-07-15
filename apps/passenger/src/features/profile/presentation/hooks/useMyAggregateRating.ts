import type {RatingAggregateView} from '@veo/api-client';
import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {myAggregateRatingKey} from '../../../ratings/domain/queryKeys';

/**
 * Chequeo ESTRUCTURAL tipado de un 404 (sin `instanceof`): el `ApiError` del `@veo/api-client` lleva
 * `status: number`. No usamos `instanceof` porque, cruzando el límite del package compartido (otra copia
 * del módulo o un mock en tests), la identidad de clase no es confiable; el shape sí. Acotamos `unknown`
 * leyendo `status` defensivamente.
 */
function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as {status?: unknown}).status === 404
  );
}

/**
 * MI agregado de calificaciones (rolling 30d) como sujeto calificado: el score (`rollingAvg30d`) y el
 * volumen (`count30d`) que la cabecera del Perfil muestra como "protagonista" (estrella + score).
 *
 * MATIZ DEL BACKEND: el rating-service responde 404 (`NotFoundException`) cuando el sujeto AÚN no tiene
 * agregado (pasajero sin calificaciones todavía). Eso NO es un error: lo mapeamos a `null` ("sin
 * calificaciones aún") para que la UI pinte el estado vacío honesto. Cualquier otro error sí propaga
 * (la UI lo trata silencioso, sin romper el perfil).
 *
 * `staleTime` largo: el agregado rolling se recomputa server-side de forma diferida, no en cada foco.
 *
 * Hook fino LOCAL de la cabecera del Perfil: envuelve el puerto público `RatingsRepository` (resuelto
 * por DI) y la clave compartida `myAggregateRatingKey` de `ratings/domain` —sin tocar la `presentation`
 * de Ratings, respetando el aislamiento de features (la caché del agregado sigue siendo una sola).
 */
export function useMyAggregateRating(
  subjectId: string,
): UseQueryResult<RatingAggregateView | null> {
  const ratings = useDependency(TOKENS.ratingsRepository);
  return useQuery({
    queryKey: myAggregateRatingKey(subjectId),
    queryFn: async () => {
      try {
        return await ratings.getAggregate(subjectId);
      } catch (err) {
        // 404 = sujeto sin agregado todavía → estado vacío, NO error.
        if (isNotFoundError(err)) return null;
        throw err;
      }
    },
    enabled: Boolean(subjectId),
    staleTime: 1000 * 60 * 30, // 30 min: el agregado no cambia en cada foco.
    gcTime: 1000 * 60 * 60,
    retry: 1,
  });
}
