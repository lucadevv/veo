import type {GeoPoint} from '@veo/api-client';
import {type RefObject, useCallback, useEffect, useRef} from 'react';
import {LIMA_ZOOM, toLngLat} from '../../utils/geo';
import type {DirectedCameraRef} from './useDirectedCamera';

/** Duración de la animación al recentrar a demanda (ms). Suave, sin tirón. */
const RECENTER_ANIM_MS = 500;

const isValidPoint = (p: GeoPoint | null | undefined): p is GeoPoint =>
  p != null && Number.isFinite(p.lat) && Number.isFinite(p.lon);

/**
 * CÁMARA IDLE del mapa "mi ubicación" (Home / OffersBoard). A diferencia de `useDirectedCamera` (que
 * SIGUE al conductor), acá la cámara NO persigue al usuario: lo CENTRA UNA SOLA VEZ sobre el primer fix
 * de GPS y después el mapa es del usuario (paneo libre, sin snap-back). El botón "recentrarme" vuelve a
 * mi ubicación a demanda.
 *
 * Imperativo sobre el `Camera` ref de rnmapbox (`setCamera`), gemelo del patrón de `useDirectedCamera`:
 *  - La `Camera` del AppMap va con `defaultSettings` (NO controlada) → no re-asserta el centro en cada
 *    cambio de `point`. Por eso el centrado inicial lo hacemos acá, imperativo, una sola vez.
 *  - El centrado inicial fija `zoomLevel` (mismo encuadre-ciudad que la cámara controlada anterior); el
 *    recentrado del botón OMITE el zoom → conserva el zoom actual del usuario (estándar de apps de mapas).
 *
 * No re-renderiza: todo vive en refs y se aplica vía la API imperativa del Camera.
 */
export function useIdleCamera(
  cameraRef: RefObject<DirectedCameraRef | null>,
  point: GeoPoint | null | undefined,
  bottomInset: number,
): {recenter: () => void} {
  const centeredRef = useRef(false);
  const bottomInsetRef = useRef(bottomInset);
  bottomInsetRef.current = bottomInset;

  const moveTo = useCallback(
    (p: GeoPoint, opts: {zoom?: number; animMs: number}): void => {
      const cam = cameraRef.current;
      if (!cam) return;
      cam.setCamera({
        centerCoordinate: toLngLat(p),
        ...(opts.zoom != null ? {zoomLevel: opts.zoom} : {}),
        padding: {
          paddingTop: 0,
          paddingBottom: bottomInsetRef.current,
          paddingLeft: 0,
          paddingRight: 0,
        },
        animationDuration: opts.animMs,
        animationMode: 'easeTo',
      });
    },
    [cameraRef],
  );

  // Centra UNA vez sobre el primer fix válido (null → fix). Después NO vuelve a tocar la cámara: el mapa
  // queda libre para el usuario. `animMs: 0` = salto instantáneo (sin fly-over desde el centro de Lima).
  useEffect(() => {
    if (centeredRef.current || !isValidPoint(point)) return;
    centeredRef.current = true;
    moveTo(point, {zoom: LIMA_ZOOM, animMs: 0});
  }, [point, moveTo]);

  // Botón "recentrarme": vuelve a mi ubicación conservando el zoom actual (no lo OMITimos a propósito).
  const recenter = useCallback(() => {
    if (!isValidPoint(point)) return;
    moveTo(point, {animMs: RECENTER_ANIM_MS});
  }, [point, moveTo]);

  return {recenter};
}
