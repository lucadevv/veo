import {useEffect} from 'react';
import {useQuery} from '@tanstack/react-query';
import {ApiError} from '@veo/api-client';
import {useRepositories} from '../../../../core/di/useDi';
import {useSessionStore} from '../../../../core/session/sessionStore';
import {GetProfileUseCase} from '../../../profile/domain';
import {mapProfileToRegistrationStatus} from '../../domain';
import {useRegistrationStore} from '../state/registrationStore';

/** `true` si el error es un 404 del backend: el conductor aún no existe (alta no iniciada). */
function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Clave de caché del perfil usado SOLO para resolver el estado del alta (aislada del ProfileScreen). */
export const REGISTRATION_GATE_QUERY_KEY = ['registration', 'gate', 'me'] as const;

export interface RegistrationGate {
  /**
   * `true` mientras se resuelve el estado del alta por primera vez (sin confirmación previa del
   * backend). El `RootNavigator` debe mostrar carga en este caso para NO mandar al wizard por
   * defecto ni provocar parpadeos.
   */
  resolving: boolean;
}

/**
 * Rehidrata `registrationStatus` desde `GET /drivers/me` tras autenticar y lo sincroniza en el
 * store (`applyBackendStatus`). Reutiliza el `ProfileRepository` por DI (abstracción) y el mapeo de
 * dominio. La conmutación de pantallas la hace el `RootNavigator` por estado (no imperativa): este
 * hook solo resuelve el estado y expone `resolving` para evitar parpadeos.
 *
 * Fallback de demo: si la llamada falla y nunca se resolvió antes, se conserva el `status` local
 * persistido (override de demostración) sin bloquear. TODO(backend): cuando el endpoint sea estable
 * podríamos endurecer el fallback (p. ej. forzar re-login o reintento visible).
 */
export function useRegistrationGate(): RegistrationGate {
  const {profile} = useRepositories();
  const sessionStatus = useSessionStore(s => s.status);
  const applyBackendStatus = useRegistrationStore(s => s.applyBackendStatus);
  const forceWizard = useRegistrationStore(s => s.forceWizard);
  const resolvedFromBackend = useRegistrationStore(s => s.statusResolvedFromBackend);

  const query = useQuery({
    queryKey: REGISTRATION_GATE_QUERY_KEY,
    queryFn: () => new GetProfileUseCase(profile).execute(),
    enabled: sessionStatus === 'authenticated',
    // El 404 de `GET /drivers/me` (conductor nuevo) es DEFINITIVO: no se reintenta. Solo reintentamos
    // errores reintentables (red / 5xx / 429, vía `ApiError.retryable`); cualquier 4xx termina ya.
    retry: (failureCount, error) =>
      error instanceof ApiError && error.retryable && failureCount < 2,
  });

  const {data, error, isError} = query;
  useEffect(() => {
    if (data) {
      // Sincroniza el cache del servidor → store de dominio mediante una acción (no setState suelto).
      applyBackendStatus(mapProfileToRegistrationStatus(data));
    } else if (isError && isNotFound(error)) {
      // 404 definitivo ⇒ el conductor no existe en el backend: SIEMPRE wizard. No caemos al `status`
      // local persistido (que por la fuga de logout podía quedar `approved` y meter a un conductor
      // nuevo a las tabs sin aprobación). `forceWizard` descarta cualquier estado resuelto heredado.
      forceWizard();
    }
  }, [data, isError, error, applyBackendStatus, forceWizard]);

  // Solo "resolviendo" si el conductor está autenticado, aún no hay confirmación del backend y la
  // query sigue en vuelo (sin error). Ante error sin resolución previa, dejamos de cargar y se usa
  // el `status` local como fallback de demo (salvo el 404, que ya fuerza wizard arriba).
  const resolving =
    sessionStatus === 'authenticated' &&
    !resolvedFromBackend &&
    query.isLoading &&
    !query.isError;

  return {resolving};
}
