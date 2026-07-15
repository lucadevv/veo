import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { GetProfileUseCase, PROFILE_QUERY_KEY, profileToSessionUser } from '../../../profile/domain';

/**
 * Hook fino LOCAL de `shift` para leer el perfil del conductor (nombre para el saludo del Dashboard).
 *
 * Consume el use-case PÚBLICO de profile (`GetProfileUseCase`, en `profile/domain` — importar el domain
 * de otra feature está PERMITIDO por el arquetipo) en vez del `useProfile` de `profile/presentation`
 * (importarlo violaba el aislamiento: prohibido cruzar la presentation de otra feature).
 *
 * Comparte la MISMA `PROFILE_QUERY_KEY` (también de `profile/domain`) → el cache de React Query es único
 * entre features: una sola request, y el saludo del Dashboard queda coherente con `ProfileScreen`.
 *
 * Replica el sync de sesión del owner a propósito: React Query DEDUPE por key, así que solo corre el
 * `queryFn` del PRIMER hook montado con esa key. Como el Dashboard suele ser la primera pantalla tras el
 * login, su fetch debe mantener el `sessionStore` fresco igual que lo hace `useProfile` — si no, el
 * usuario de sesión no se refresca hasta abrir la pantalla de Cuenta.
 */
export function useProfileData() {
  const { profile } = useRepositories();
  return useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: async () => {
      const data = await new GetProfileUseCase(profile).execute();
      useSessionStore.getState().setUser(profileToSessionUser(data));
      return data;
    },
  });
}
