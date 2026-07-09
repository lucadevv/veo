import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  DOCUMENTS_QUERY_KEY,
  ListDocumentsUseCase,
  RegisterDocumentUseCase,
  type RegisterDocumentInput,
} from '../../domain';

// `DOCUMENTS_QUERY_KEY` vive ahora en `documents/domain` (cache compartido con el dashboard de turno).
// Se re-exporta para no romper a los consumidores del barrel.
export { DOCUMENTS_QUERY_KEY };

/** Query: documentos del conductor, ya ordenados por urgencia en el caso de uso. */
export function useDocuments() {
  const { documents } = useRepositories();
  return useQuery({
    queryKey: DOCUMENTS_QUERY_KEY,
    queryFn: () => new ListDocumentsUseCase(documents).execute(),
  });
}

/**
 * Mutación: registra/actualiza un documento (metadatos). Al confirmar, invalida la query del
 * listado para que la pantalla refleje el nuevo estado (típicamente "en revisión").
 */
export function useRegisterDocument() {
  const { documents } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterDocumentInput) =>
      new RegisterDocumentUseCase(documents).execute(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DOCUMENTS_QUERY_KEY });
    },
  });
}
