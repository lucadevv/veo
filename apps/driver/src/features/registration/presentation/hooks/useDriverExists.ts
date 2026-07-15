import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@veo/api-client';
import { useRepositories } from '../../../../core/di/useDi';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { GetProfileUseCase } from '../../../profile/domain';
import { REGISTRATION_GATE_QUERY_KEY } from './useRegistrationGate';

/**
 * ¿Existe el conductor en el SERVIDOR? Señal TIPADA (sin string mágico) derivada de `GET /drivers/me`:
 *  - `exists`: la query resolvió 200 → el driver YA está creado server-side (caso RESUME). Sus datos
 *    personales (`fullName`/`birthdate`) ya viven en el backend; re-PATCHearlos con el estado LOCAL del
 *    wizard (vacío al reanudar) es innecesario Y rompe (payload vacío → validación rechaza).
 *  - `not_found`: la query falló con 404 → el driver NO existe (ALTA FRESCA). El `PATCH /personal` del
 *    "Continuar" es quien lo CREA con el `personal` que pobló el escaneo del DNI.
 *  - `unknown`: aún no resolvió (carga inicial) o falló con un error NO definitivo (red/5xx). No sabemos:
 *    el continue se comporta como alta fresca (intenta el PATCH) — degradación honesta hacia el camino
 *    que CREA el driver, nunca asumimos que existe sin confirmación del servidor.
 */
export const DriverExistence = {
  Exists: 'exists',
  NotFound: 'not_found',
  Unknown: 'unknown',
} as const;
export type DriverExistence = (typeof DriverExistence)[keyof typeof DriverExistence];

/** `true` si el error es un 404 del backend: el conductor aún no existe (alta no iniciada). */
function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * Resuelve si el conductor EXISTE en el servidor, COMPARTIENDO el cache de la query del gate
 * (`useRegistrationGate`) por `queryKey` — React Query dedupea, así que NO dispara un segundo
 * `GET /drivers/me`: lee el resultado que el gate ya pobló al arrancar la app. NO replica los efectos
 * del gate (setUser, polling, routing): solo deriva la señal limpia que `PersonalDataScreen` consume
 * para decidir si re-PATCHea (alta fresca) o solo navega (resume).
 *
 * Hook FINO sobre la query; la decisión vive en el `DriverExistence` tipado (testeable sin React).
 */
export function useDriverExists(): DriverExistence {
  const { profile } = useRepositories();
  const sessionStatus = useSessionStore((s) => s.status);

  const query = useQuery({
    queryKey: REGISTRATION_GATE_QUERY_KEY,
    queryFn: () => new GetProfileUseCase(profile).execute(),
    enabled: sessionStatus === 'authenticated',
    // Mismo criterio que el gate: el 404 (conductor nuevo) es DEFINITIVO; solo se reintentan errores
    // reintentables (red / 5xx / 429). Mantener idéntico evita divergencias de reintento entre ambos.
    retry: (failureCount, error) =>
      error instanceof ApiError && error.retryable && failureCount < 2,
  });

  if (query.data) {
    return DriverExistence.Exists;
  }
  if (query.isError && isNotFound(query.error)) {
    return DriverExistence.NotFound;
  }
  return DriverExistence.Unknown;
}
