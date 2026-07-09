import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import { DOCUMENTS_QUERY_KEY, ListDocumentsUseCase } from '../../../documents/domain';

/**
 * Query FINA de documentos que consume el TURNO (dashboard + pantalla de bloqueo por docs). Envuelve el
 * caso de uso público `ListDocumentsUseCase` (documents/domain) sobre la clave COMPARTIDA
 * `DOCUMENTS_QUERY_KEY`: MISMO cache que `documents/presentation` (coherente), SIN importar sus hooks
 * internos (feature-isolation).
 */
export function useDocuments() {
  const { documents } = useRepositories();
  return useQuery({
    queryKey: DOCUMENTS_QUERY_KEY,
    queryFn: () => new ListDocumentsUseCase(documents).execute(),
  });
}
