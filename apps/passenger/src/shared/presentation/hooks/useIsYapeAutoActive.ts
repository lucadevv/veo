import type {YapeAffiliationView} from '@veo/api-client';
import {affiliationStatus} from '@veo/api-client';
import {useQuery} from '@tanstack/react-query';
import {TOKENS} from '../../../core/di/tokens';
import {useDependency} from '../../../core/di/useDependency';
import {YAPE_AFFILIATION_QUERY_KEY} from '../../../features/payments/domain/queryKeys';

/**
 * ¿El cobro automático con Yape está ACTIVO? Señal booleana derivada del estado de afiliación Yape On
 * File. La consumen las pantallas de quote/checkout de 3 features (Maps, Trip, Carpool), así que vive en
 * `shared/presentation` —como `useAutocomplete`— en vez de en `payments/presentation` (romperia el
 * aislamiento de features). Reusa la MISMA `queryKey` compartida (`payments/domain`) que el
 * `useYapeAffiliation` de Payments → una sola fuente de caché, sin doble fetch. Depende solo del caso de
 * uso público (resuelto por DI) y del dominio de Payments —nunca de sus internals de presentación.
 */
export function useIsYapeAutoActive(): boolean {
  const getAffiliation = useDependency(TOKENS.getYapeAffiliationUseCase);
  const {data} = useQuery<YapeAffiliationView, Error>({
    queryKey: YAPE_AFFILIATION_QUERY_KEY,
    queryFn: () => getAffiliation.execute(),
    staleTime: 30_000,
  });
  return data?.status?.toUpperCase() === affiliationStatus.enum.ACTIVE;
}
