import type {YapeAffiliationView} from '@veo/api-client';
import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {YAPE_AFFILIATION_QUERY_KEY} from '../../domain/queryKeys';

// La clave vive en `payments/domain` (compartida con `useIsYapeAutoActive` en shared → misma caché).
// La re-exportamos para no romper a los consumidores internos (barrel, `YapeLinkSheet`, `YapeManageSheet`).
export {YAPE_AFFILIATION_QUERY_KEY};

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
