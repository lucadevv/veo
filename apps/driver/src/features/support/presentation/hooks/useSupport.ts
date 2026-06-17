import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import { CreateTicketUseCase, ListTicketsUseCase, type TicketDraft } from '../../domain';

/** Clave de caché de los tickets del conductor. */
export const SUPPORT_TICKETS_QUERY_KEY = ['support', 'tickets'] as const;

/** Query: tickets del conductor (más recientes primero, según el server). */
export function useTickets() {
  const { support } = useRepositories();
  return useQuery({
    queryKey: SUPPORT_TICKETS_QUERY_KEY,
    queryFn: () => new ListTicketsUseCase(support).execute(),
  });
}

/**
 * Mutación: crear un ticket de soporte. Al confirmar, invalida la lista para que el nuevo ticket
 * aparezca arriba. La validación del borrador ocurre en el caso de uso (y en el formulario).
 */
export function useCreateTicket() {
  const { support } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: TicketDraft) => new CreateTicketUseCase(support).execute(draft),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SUPPORT_TICKETS_QUERY_KEY });
    },
  });
}
