import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  GetNotificationsUseCase,
  MarkAllNotificationsReadUseCase,
  type AppNotification,
} from '../../domain';

/** Clave de caché de la bandeja de avisos del conductor. */
export const NOTIFICATIONS_QUERY_KEY = ['notifications', 'list'] as const;

/** Tamaño de página pedido al BFF (el servidor lo acota a su tope; es solo una sugerencia). */
const NOTIFICATIONS_PAGE_SIZE = 30;

/**
 * Query: bandeja de avisos del conductor (más recientes primero). Sigue el patrón de DI del driver
 * (`useRepositories()` + clase use case), igual que `useTrips`/`useEarnings`. `staleTime` moderado: el
 * feed no cambia a cada segundo y el push ya empuja lo urgente en tiempo real.
 */
export function useNotifications(): UseQueryResult<AppNotification[]> {
  const { notifications } = useRepositories();
  return useQuery({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: () => new GetNotificationsUseCase(notifications).execute(NOTIFICATIONS_PAGE_SIZE),
    staleTime: 30_000,
  });
}

/**
 * Cantidad de avisos NO leídos, para el punto rojo de la campana del Dashboard. Reusa la MISMA query
 * (misma `queryKey`) que el feed: no dispara una llamada extra. El `read` es REAL (derivado de
 * `read_at` server-side): el punto se enciende con avisos nuevos y se apaga al entrar a Avisos
 * (read-all al entrar) o al marcar individualmente.
 */
export function useUnreadNotificationsCount(): number {
  const query = useNotifications();
  return (query.data ?? []).reduce((acc, n) => (n.read ? acc : acc + 1), 0);
}

/**
 * Mutación: marca TODOS los avisos como leídos (`PATCH /notifications/read-all`). En éxito actualiza
 * la caché del feed en el lugar (sin refetch) — la MISMA query alimenta el borde de acento de las
 * filas y el punto de la campana del Dashboard, así ambos se apagan con el estado REAL confirmado
 * por el server. Si falla, no se toca la caché (los no-leídos siguen marcados, honesto).
 */
export function useMarkAllNotificationsRead(): UseMutationResult<void, Error, void> {
  const { notifications } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => new MarkAllNotificationsReadUseCase(notifications).execute(),
    onSuccess: () => {
      queryClient.setQueryData<AppNotification[]>(NOTIFICATIONS_QUERY_KEY, (prev) =>
        prev?.map((n) => (n.read ? n : { ...n, read: true })),
      );
    },
  });
}
