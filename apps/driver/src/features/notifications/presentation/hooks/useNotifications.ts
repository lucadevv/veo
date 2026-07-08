import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import { GetNotificationsUseCase, type AppNotification } from '../../domain';

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
 * (misma `queryKey`) que el feed: no dispara una llamada extra. Hoy el backend aún no trackea lectura →
 * el repo marca todo como leído (degradación honesta), así que el contador es 0 hasta que exista `read`
 * real en el endpoint; el punto queda listo para encenderse sin tocar la UI.
 */
export function useUnreadNotificationsCount(): number {
  const query = useNotifications();
  return (query.data ?? []).reduce((acc, n) => (n.read ? acc : acc + 1), 0);
}
