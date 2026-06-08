import type { GeoPoint } from '@veo/api-client';
import { type ElementRef, type RefObject, useCallback, useEffect, useRef } from 'react';
import type { Camera } from '@rnmapbox/maps';
import { boundsOf, distanceMeters, toLngLat } from '../../utils/geo';
import type { CameraTarget } from '../../../features/trip/presentation/hooks/mapDirector';

/** Tipo del ref imperativo de la `Camera` de rnmapbox (no se exporta como `CameraRef` desde el índice). */
export type DirectedCameraRef = ElementRef<typeof Camera>;

/** Duración de la animación de re-encuadre (ms). Suave, "se va acercando la cámara" sin tirón. */
const ANIM_MS = 900;
/** Mínimo entre re-encuadres por TIEMPO (ms): no peleamos con cada tick del socket. */
const MIN_INTERVAL_MS = 2_500;
/** Umbral de MOVIMIENTO (m): por debajo no re-encuadramos aunque pase el tiempo (evita micro-jitter). */
const MOVE_THRESHOLD_M = 40;
/** Tras un gesto manual, la cámara queda "libre" este tiempo (ms) antes de retomar el seguimiento. */
const FREE_MODE_MS = 8_000;

/** Firma estable de un target para detectar cambios de FASE/INTENCIÓN (no de cada coordenada). */
function targetSignature(t: CameraTarget): string {
  if (t.mode === 'fit') {
    return `fit:${t.fitPoints.length}`;
  }
  return `${t.mode}:${t.followZoom ?? ''}`;
}

/** Punto "principal" del target (el que driftea con el conductor) para medir el umbral de movimiento. */
function leadPoint(t: CameraTarget): GeoPoint | null {
  if (t.mode === 'fit') {
    return t.fitPoints[0] ?? null;
  }
  return t.followPoint;
}

/**
 * SEGUIMIENTO DE CÁMARA dirigido por el `mapDirector`. Imperativo sobre el `Camera` ref de rnmapbox
 * (`setCamera`/`fitBounds`), con:
 *  - THROTTLE doble: re-encuadra como mucho cada `MIN_INTERVAL_MS` O cuando el lead point se movió más
 *    de `MOVE_THRESHOLD_M`. Así el update de socket (que llega seguido) no dispara animaciones en cadena.
 *  - MODO LIBRE: si el usuario pellizca/arrastra (`onGesture`), pausa el follow `FREE_MODE_MS` y lo
 *    reanuda solo. El re-encuadre por CAMBIO DE FASE ignora el modo libre (intención explícita).
 *  - RE-ENCUADRE LIMPIO al cambiar de fase/intención o al volver de background (cambia la firma o se
 *    fuerza), sin throttle.
 *
 * No re-renderiza: todo vive en refs y se aplica vía la API imperativa del Camera. El `AppMap` solo le
 * pasa el ref, el target y el bottomInset.
 */
export function useDirectedCamera(
  cameraRef: RefObject<DirectedCameraRef | null>,
  target: CameraTarget,
  bottomInset: number,
): { onGesture: () => void } {
  const lastAppliedAt = useRef(0);
  const lastLead = useRef<GeoPoint | null>(null);
  const lastSignature = useRef<string>('');
  const freeUntil = useRef(0);
  const bottomInsetRef = useRef(bottomInset);
  bottomInsetRef.current = bottomInset;

  const apply = useCallback((t: CameraTarget): void => {
    const cam = cameraRef.current;
    if (!cam) return;
    const padBottom = bottomInsetRef.current;

    if (t.mode === 'fit') {
      if (t.fitPoints.length === 0) return; // el fit de ruta lo maneja la Camera declarativa del AppMap.
      const positions = t.fitPoints.map(toLngLat);
      const bounds = boundsOf(positions);
      if (!bounds) return;
      // Padding APRETADO + reserva del sheet abajo (ya CAPADA por el AppMap: `padBottom` nunca aplasta el
      // viewport). Calibración de GUSTO del dueño ("más encima de la acción"): bajamos de 56/48 a 40/36 →
      // el box [conductor+recogida] (enRoute) y el box casi-puntual sobre la recogida (arrived) cierran más,
      // dejando menos aire alrededor. En 'arrived' el conductor ya está sobre el origen → box mínimo → con
      // 40/36 el encuadre se siente BIEN cerrado (casi nivel calle sobre el punto de recogida) sin maxZoom
      // (fitBounds no lo aplica acá → se cierra por geometría). Con un solo punto, fitBounds centra y el
      // padding chico fija un zoom cerrado.
      cam.fitBounds(
        bounds.ne,
        bounds.sw,
        [40, 36, 40 + padBottom, 36], // [top, right, bottom, left]
        ANIM_MS,
      );
      return;
    }

    if (!t.followPoint) return;
    cam.setCamera({
      centerCoordinate: toLngLat(t.followPoint),
      ...(t.followZoom != null ? { zoomLevel: t.followZoom } : {}),
      padding: { paddingTop: 0, paddingBottom: padBottom, paddingLeft: 0, paddingRight: 0 },
      animationDuration: ANIM_MS,
      animationMode: 'easeTo',
    });
  }, [cameraRef]);

  useEffect(() => {
    const sig = targetSignature(target);
    const lead = leadPoint(target);
    const now = Date.now();
    const phaseChanged = sig !== lastSignature.current;

    // Cambio de FASE/INTENCIÓN: re-encuadre limpio inmediato, ignora throttle y modo libre.
    if (phaseChanged) {
      lastSignature.current = sig;
      lastLead.current = lead;
      lastAppliedAt.current = now;
      apply(target);
      return;
    }

    // Mismo target, mientras el usuario mueve el mapa a mano: no peleamos (modo libre).
    if (now < freeUntil.current) return;

    // Throttle: ni muy seguido en el tiempo, ni por micro-movimientos sub-umbral.
    const movedEnough =
      lead != null && lastLead.current != null
        ? distanceMeters(lastLead.current, lead) >= MOVE_THRESHOLD_M
        : lead != null && lastLead.current == null;
    const intervalOk = now - lastAppliedAt.current >= MIN_INTERVAL_MS;
    if (!movedEnough || !intervalOk) return;

    lastLead.current = lead;
    lastAppliedAt.current = now;
    apply(target);
  }, [target, apply]);

  // Gesto manual del usuario: entra en modo libre (el seguimiento se reanuda solo a los FREE_MODE_MS).
  const onGesture = useCallback(() => {
    freeUntil.current = Date.now() + FREE_MODE_MS;
  }, []);

  return { onGesture };
}
