import type {GeoPoint} from '@veo/api-client';
import {useCallback, useEffect, useRef, useState} from 'react';
import {AppState} from 'react-native';
import {TOKENS} from '../di/tokens';
import {useDependency} from '../di/useDependency';
import type {LocationAvailability} from '../../shared/location/domain/locationProvider';

/**
 * Estado del ciclo de vida de la ubicación, en términos de UI:
 *  - `locating`    → pidiendo permiso y/o esperando el fix.
 *  - `ready`       → tenemos posición (`point` no nulo).
 *  - `denied`      → permiso negado/sin decidir → derivar a Ajustes de la app.
 *  - `servicesOff` → permiso ok pero GPS del dispositivo apagado → derivar a Ajustes de ubicación.
 *  - `error`       → no se pudo obtener un fix (sin señal, indoor, puerto no disponible) → reintentar.
 */
export type LocationStatus =
  | 'locating'
  | 'ready'
  | 'denied'
  | 'servicesOff'
  | 'error';

export interface CurrentLocation {
  point: GeoPoint | null;
  status: LocationStatus;
  /** Reintenta permiso + fix bajo demanda (botón "Reintentar"). */
  retry: () => void;
  /** Compat: derivado para consumidores que aún leen `loading`. */
  loading: boolean;
  /** Compat: derivado para consumidores que aún leen `error` (cualquier estado no-feliz que no sea ubicando). */
  error: boolean;
}

/**
 * Resuelve la ubicación del pasajero gestionando TODO el ciclo de vida de permiso + GPS, no un
 * único intento al montar (ese era el bug: si fallaba la primera vez, se quedaba pegado en error
 * aunque el usuario prendiera el GPS después). Reintenta automáticamente en tres momentos:
 *
 *  1. al montar la pantalla (pide el permiso del SO si está sin decidir — decisión: al abrir el Home),
 *  2. cuando la app vuelve al foreground (el usuario fue a Ajustes a prender el GPS y volvió),
 *  3. cuando el SO avisa que cambió la disponibilidad (`onAvailabilityChange`, event-driven, sin poll).
 *
 * Más un `retry()` manual. Nunca inventa coordenadas: degrada a un estado honesto y accionable.
 */
export function useCurrentLocation(): CurrentLocation {
  const location = useDependency(TOKENS.locationProvider);
  const [point, setPoint] = useState<GeoPoint | null>(null);
  const [status, setStatus] = useState<LocationStatus>('locating');

  // Evita actualizaciones tras desmontar y descarta resultados de intentos viejos (carrera entre
  // el intento inicial, el de foreground y el de onAvailabilityChange disparados casi a la vez).
  const mountedRef = useRef(true);
  const runIdRef = useRef(0);
  // ¿Ya disparamos el prompt del SO una vez? No re-prompteamos en cada foreground (el SO ya no lo
  // muestra tras la primera decisión, pero evitamos la llamada extra).
  const requestedRef = useRef(false);

  const attempt = useCallback(async () => {
    const runId = ++runIdRef.current;
    const settle = (
      next: LocationStatus,
      resolved: GeoPoint | null = null,
    ): void => {
      if (!mountedRef.current || runId !== runIdRef.current) {
        return;
      }
      setStatus(next);
      if (resolved) {
        setPoint(resolved);
      } else if (next === 'denied' || next === 'servicesOff') {
        // Pérdida DEFINITIVA de permiso/servicios mid-sesión: el punto anterior ya no es verdad →
        // limpiarlo para que el mapa no muestre un dot FANTASMA en la posición vieja (honestidad: no
        // inventar coordenadas). En `error` (fix transitorio fallido) conservamos el last-known: es una
        // pérdida temporal de señal, y limpiar parpadearía el mapa en cada re-intento de foreground.
        setPoint(null);
      }
    };

    // No parpadear a "locating" si ya estábamos en ready (re-intento de refresco en foreground).
    setStatus(prev => (prev === 'ready' ? prev : 'locating'));

    let availability: LocationAvailability;
    try {
      availability = await location.getAvailability();
    } catch {
      settle('error');
      return;
    }

    // Primera vez sin decidir: pedimos el permiso (decisión de producto: al abrir el Home).
    if (availability.permission === 'undetermined' && !requestedRef.current) {
      requestedRef.current = true;
      try {
        availability = await location.requestPermission();
      } catch {
        settle('error');
        return;
      }
    }

    // Permiso negado/restringido, o el usuario cerró el prompt sin decidir → derivar a Ajustes.
    if (availability.permission !== 'granted') {
      settle('denied');
      return;
    }
    // Permiso ok pero GPS del dispositivo apagado → derivar a Ajustes de ubicación.
    if (!availability.servicesEnabled) {
      settle('servicesOff');
      return;
    }

    // Permiso + servicios ok: pedimos el fix.
    try {
      const resolved = await location.getCurrentPosition();
      settle('ready', resolved);
    } catch {
      settle('error');
    }
  }, [location]);

  // (1) Intento inicial al montar.
  useEffect(() => {
    mountedRef.current = true;
    void attempt();
    return () => {
      mountedRef.current = false;
    };
  }, [attempt]);

  // (2) Reintento al volver al foreground (volvió de Ajustes tras prender GPS / conceder permiso).
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        void attempt();
      }
    });
    return () => sub.remove();
  }, [attempt]);

  // (3) Recuperación instantánea event-driven: el SO avisa cuando cambia el GPS / el permiso.
  useEffect(() => {
    const unsubscribe = location.onAvailabilityChange(() => {
      void attempt();
    });
    return unsubscribe;
  }, [location, attempt]);

  const retry = useCallback(() => {
    void attempt();
  }, [attempt]);

  return {
    point,
    status,
    retry,
    loading: status === 'locating',
    error: status !== 'locating' && status !== 'ready',
  };
}
