import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { useBiometricGateStore, useProfileLocalStore } from '../../../auth/presentation';

/**
 * Clave de caché del perfil real del pasajero (`GET /users/me`), AISLADA por `userId`.
 *
 * Incluir el `userId` evita una ventana de staleness entre cuentas: si un usuario cierra sesión y
 * otro entra (o se rehidrata otra sesión), su perfil cacheado NO se confunde con el del usuario
 * anterior. Las invalidaciones amplias (`['profile']`) siguen casando por prefijo.
 */
export function profileQueryKey(userId: string | null) {
  return ['profile', 'me', userId] as const;
}

/** Estado de completitud del perfil con el que el `RootNavigator` decide el stack. */
export type ProfileCompletion = 'loading' | 'complete' | 'incomplete';

/**
 * Deriva la completitud del perfil del pasajero. REGLA ÚNICA: el perfil está COMPLETO cuando tiene
 * `name` real (no vacío). El correo NO alcanza —un usuario que entró por OTP/Google/Apple puede
 * traer correo pero sin nombre, y a ese conductor no le sirve saber a quién recoge.
 *
 * La bandera local `profile.completed.<userId>` (MMKV) es un MERO fast-path optimista para no
 * volver a mostrar `CompleteProfileScreen` justo tras guardar, pero NO es una señal autónoma de
 * "completo": NUNCA saltea el chequeo del nombre. En la práctica, cuando el usuario guarda su
 * nombre, `CompleteProfileScreen` hace `setQueryData` con el perfil ya nombrado, así que la caché
 * responde `complete` sin red; la bandera solo evita un refetch redundante en ese instante.
 *
 * Por qué la bandera ya no decide sola: antes hacía short-circuit a `complete` ANTES de mirar el
 * nombre, así que un usuario marcado localmente pero sin nombre real llegaba a Main igual. Ahora la
 * decisión final SIEMPRE sale del `name` del perfil real.
 *
 * Estados:
 *  - perfil aún cargando (sin caché) → `loading` (no destellar la pantalla a una sesión rehidratada).
 *  - perfil cargado con `name` no vacío → `complete`.
 *  - perfil cargado sin `name` → `incomplete` (el navegador muestra `CompleteProfileScreen`).
 *  - error de red → `complete` (fail-open): nunca bloqueamos la app por un fallo transitorio; el
 *    nombre se puede completar luego en Perfil.
 */
function hasRealName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.trim().length > 0;
}

export function useProfileCompletion(): ProfileCompletion {
  const userId = useSessionStore((state) => state.user?.id ?? null);
  const status = useSessionStore((state) => state.status);
  const biometricLocked = useBiometricGateStore((state) => state.locked);

  const hydrateUser = useProfileLocalStore((state) => state.hydrateUser);
  const completedLocally = useProfileLocalStore((state) =>
    userId ? state.completedByUser[userId] === true : false,
  );

  // Hidrata la bandera local del usuario actual (lectura síncrona de MMKV).
  useEffect(() => {
    if (userId) {
      hydrateUser(userId);
    }
  }, [userId, hydrateUser]);

  const getProfile = useDependency(TOKENS.getProfileUseCase);

  const active = status === 'authenticated' && !biometricLocked && Boolean(userId);
  const query = useQuery({
    queryKey: profileQueryKey(userId),
    queryFn: () => getProfile.execute(),
    enabled: active,
  });

  if (!active) {
    return 'loading';
  }
  // Fail-open SOLO si NO tenemos ninguna lectura del perfil: ante un fallo transitorio de red sin
  // datos no bloqueamos la app. Si ya hay `data` cacheada, esa data manda sobre el error.
  if (query.isError && !query.data) {
    return 'complete';
  }
  if (query.data) {
    return hasRealName(query.data.name) ? 'complete' : 'incomplete';
  }
  // Sin datos todavía: si el usuario quedó marcado localmente como completado (acaba de guardar su
  // nombre en este dispositivo) asumimos `complete` para no destellar la pantalla mientras refetchea;
  // la caché real (con `name`) confirma el estado en cuanto llega. Si no, esperamos (`loading`).
  if (completedLocally) {
    return 'complete';
  }
  return 'loading';
}
