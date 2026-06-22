import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type DriverProfileView } from '@veo/api-client';
import { useRepositories } from '../../../../core/di/useDi';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { GetProfileUseCase, profileToSessionUser } from '../../../profile/domain';
import { isAwaitingReview, mapProfileToRegistrationStatus, resumeStepForProfile } from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';
import { useRegistrationHydration } from './useRegistrationHydration';

/** `true` si el error es un 404 del backend: el conductor aún no existe (alta no iniciada). */
function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Clave de caché del perfil usado SOLO para resolver el estado del alta (aislada del ProfileScreen). */
export const REGISTRATION_GATE_QUERY_KEY = ['registration', 'gate', 'me'] as const;

/**
 * Intervalo de sondeo (ms) del gate como RED DE SEGURIDAD del push: el aviso de aprobación/rechazo es
 * best-effort (puede no llegar). Mientras el alta está EN REVISIÓN, sondeamos cada 60s para que el
 * conductor pase a aprobado/rechazado SÍ o SÍ. Para al resolverse; no corre en background (sin batería).
 */
const REGISTRATION_GATE_POLL_MS = 60_000;

export interface RegistrationGate {
  /**
   * `true` mientras se resuelve el estado del alta por primera vez (sin confirmación previa del
   * backend). El `RootNavigator` debe mostrar carga en este caso para NO mandar al wizard por
   * defecto ni provocar parpadeos.
   */
  resolving: boolean;
  /**
   * `true` cuando la resolución del alta falló con un error NO definitivo (red / 5xx / 429, etc.) y
   * nunca se resolvió antes. El `RootNavigator` debe mostrar una pantalla de reintento — NO un banner
   * de error de login ni un dead-end, y SIN limpiar la sesión (los tokens son válidos; lo único que
   * falló fue `GET /drivers/me`). Un 404 NO entra acá: ese se mapea a `forceWizard()` (alta nueva).
   */
  needsRetry: boolean;
  /** Reintenta resolver el perfil del conductor (recupera del estado `needsRetry`). */
  retry(): void;
  /**
   * Perfil agregado del conductor (`GET /drivers/me`) tal como vive en el cache del gate, o `undefined`
   * si todavía no resolvió la primera vez (cache miss). La pantalla "En revisión" deriva su checklist
   * REAL de acá (documentos/biometría enviados) — la misma fuente de verdad que conmuta la navegación.
   */
  profile: DriverProfileView | undefined;
  /**
   * `true` mientras una re-consulta del gate está en vuelo (sondeo, pull-to-refresh o "Verificar mi
   * estado"), INCLUSO después de la primera resolución (a diferencia de `resolving`, que solo cubre la
   * carga inicial). Alimenta el spinner del pull-to-refresh y el estado de carga del botón.
   */
  isRefreshing: boolean;
  /**
   * `true` cuando una re-consulta del gate falló PERO ya habíamos resuelto antes (mantenemos el último
   * perfil bueno en pantalla). A diferencia de `needsRetry` —que solo cubre el primer fallo y bloquea
   * con la pantalla de reintento—, esto solo señala un banner no bloqueante: el conductor sigue viendo
   * "En revisión" mientras reintenta.
   */
  refreshError: boolean;
  /** Fuerza una re-consulta del gate contra el backend (invalida la query → refetch). */
  refresh(): void;
}

/**
 * Rehidrata `registrationStatus` desde `GET /drivers/me` tras autenticar y lo sincroniza en el
 * store (`applyBackendStatus`). Reutiliza el `ProfileRepository` por DI (abstracción) y el mapeo de
 * dominio. La conmutación de pantallas la hace el `RootNavigator` por estado (no imperativa): este
 * hook solo resuelve el estado y expone `resolving`/`needsRetry` para evitar parpadeos y dead-ends.
 *
 * Es además quien compone el `user` de la sesión para el conductor EXISTENTE: como el login ya NO
 * fetchea el perfil (un conductor nuevo da 404 y eso debe ir al wizard, no a un error), el `user` de
 * sesión se deriva acá del perfil resuelto (`profileToSessionUser`). Las pantallas que leen
 * `session.user` (tabs/home, perfil) lo obtienen una vez que el gate resuelve.
 */
export function useRegistrationGate(): RegistrationGate {
  const { profile } = useRepositories();
  const queryClient = useQueryClient();
  const sessionStatus = useSessionStore((s) => s.status);
  const setUser = useSessionStore((s) => s.setUser);
  const applyBackendStatus = useRegistrationStore((s) => s.applyBackendStatus);
  const setCurrentStep = useRegistrationStore((s) => s.setCurrentStep);
  const forceWizard = useRegistrationStore((s) => s.forceWizard);
  const resolvedFromBackend = useRegistrationStore((s) => s.statusResolvedFromBackend);

  // HIDRATA el avance local del wizard desde el SERVIDOR (`GET /drivers/me/documents`) al reanudar, para
  // que TODOS los pasos document-backed (DNI, licencia, SOAT, tarjeta, foto) deriven "hecho" de la MISMA
  // fuente de verdad (el server) — coherente. Antes el DNI miraba solo el estado local de sesión (vacío al
  // reanudar) y se re-pedía, mientras la licencia ya miraba el server: incoherencia. Corre una vez al
  // resolver los documentos; no destructivo (no pisa lo que el conductor escribe en esta sesión).
  useRegistrationHydration();

  const query = useQuery({
    queryKey: REGISTRATION_GATE_QUERY_KEY,
    queryFn: () => new GetProfileUseCase(profile).execute(),
    enabled: sessionStatus === 'authenticated',
    // El 404 de `GET /drivers/me` (conductor nuevo) es DEFINITIVO: no se reintenta. Solo reintentamos
    // errores reintentables (red / 5xx / 429, vía `ApiError.retryable`); cualquier 4xx termina ya.
    retry: (failureCount, error) =>
      error instanceof ApiError && error.retryable && failureCount < 2,
    // RED DE SEGURIDAD del push (best-effort): mientras el alta está EN REVISIÓN, sondeá para que el
    // conductor pase a aprobado/rechazado aunque el push no llegue. Para al resolverse (approved/rejected/
    // not_started → false). No corre en background (default) → sin drenaje de batería.
    refetchInterval: (query) => {
      const profile = query.state.data;
      return profile && isAwaitingReview(mapProfileToRegistrationStatus(profile))
        ? REGISTRATION_GATE_POLL_MS
        : false;
    },
  });

  const { data, error, isError } = query;
  useEffect(() => {
    if (data) {
      // Sincroniza el cache del servidor → store de dominio mediante una acción (no setState suelto).
      applyBackendStatus(mapProfileToRegistrationStatus(data));
      // Defense-in-depth de routing: un conductor con TODOS los documentos pero SIN biometría enrolada
      // vuelve al wizard como `in_progress` (ver `mapProfileToRegistrationStatus`). Debe REANUDAR en el
      // paso 3 (IdentityVerification / KYC, último del wizard de 3 pasos) para completar la biometría, no
      // en el paso 1. Solo forzamos
      // el paso cuando aplica (helper devuelve null en cualquier otro caso ⇒ se conserva el avance local).
      const resumeStep = resumeStepForProfile(data.compliance);
      if (resumeStep !== null) {
        setCurrentStep(resumeStep);
      }
      // Compone el `user` de sesión del conductor existente (el login ya no lo fetchea).
      setUser(profileToSessionUser(data));
    } else if (isError && isNotFound(error)) {
      // 404 definitivo ⇒ el conductor no existe en el backend: SIEMPRE wizard. No caemos al `status`
      // local persistido (que por la fuga de logout podía quedar `approved` y meter a un conductor
      // nuevo a las tabs sin aprobación). `forceWizard` descarta cualquier estado resuelto heredado.
      forceWizard();
    }
  }, [data, isError, error, applyBackendStatus, setCurrentStep, forceWizard, setUser]);

  // Solo "resolviendo" si el conductor está autenticado, aún no hay confirmación del backend y la
  // query sigue en vuelo (sin error).
  const resolving =
    sessionStatus === 'authenticated' && !resolvedFromBackend && query.isLoading && !query.isError;

  // Error NO definitivo (no es 404) sin resolución previa ⇒ pantalla de reintento. La sesión sigue
  // válida (tokens OK); lo único que falló fue resolver el perfil. NUNCA limpiamos la sesión acá.
  const needsRetry =
    sessionStatus === 'authenticated' && !resolvedFromBackend && isError && !isNotFound(error);

  // Re-consulta en vuelo (sondeo / pull-to-refresh / botón) tras la primera resolución. `isFetching`
  // cubre cualquier fetch activo del gate; el spinner del pull-to-refresh y el loading del botón lo leen.
  const isRefreshing = query.isFetching;

  // Fallo de una RE-consulta cuando ya teníamos un perfil resuelto: banner no bloqueante (no pantalla de
  // reintento). El 404 (conductor inexistente) no aplica acá: ese fuerza el wizard, no un refresh fallido.
  const refreshError = resolvedFromBackend && isError && !isNotFound(error);

  return {
    resolving,
    needsRetry,
    retry: () => void query.refetch(),
    profile: data,
    isRefreshing,
    refreshError,
    // Invalida la query del gate → dispara un refetch contra `GET /drivers/me` (server-authoritative).
    refresh: () => void queryClient.invalidateQueries({ queryKey: REGISTRATION_GATE_QUERY_KEY }),
  };
}
