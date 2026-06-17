import type {YapeAffiliationView} from '@veo/api-client';
import {affiliationStatus} from '@veo/api-client';
import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';

/** Clave de caché compartida del estado de afiliación Yape (perfil + señal en el quoting). */
export const YAPE_AFFILIATION_QUERY_KEY = ['affiliation', 'yape'] as const;

/**
 * Lee el estado de la afiliación Yape On File (cobro automático). Lo consumen tanto la card del perfil
 * como la señal sutil del quoting (misma `queryKey` → una sola fuente, sin doble fetch). Devuelve la
 * vista cruda; los consumidores derivan su propio estado de presentación del `status`.
 */
export function useYapeAffiliation(): UseQueryResult<
  YapeAffiliationView,
  Error
> {
  const getAffiliation = useDependency(TOKENS.getYapeAffiliationUseCase);
  return useQuery<YapeAffiliationView, Error>({
    queryKey: YAPE_AFFILIATION_QUERY_KEY,
    queryFn: () => getAffiliation.execute(),
    staleTime: 30_000,
  });
}

/** ¿El cobro automático con Yape está ACTIVO? Señal booleana para reflejar en el quoting. */
export function useIsYapeAutoActive(): boolean {
  const {data} = useYapeAffiliation();
  return data?.status?.toUpperCase() === affiliationStatus.enum.ACTIVE;
}
