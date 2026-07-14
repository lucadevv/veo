import type {GeoPoint} from '@veo/api-client';
import {
  type ElementRef,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import type {Camera} from '@rnmapbox/maps';
import {boundsOf, distanceMeters, toLngLat} from '../../utils/geo';
import type {CameraTarget} from '../../../features/trip/presentation/hooks/mapDirector';

/** Tipo del ref imperativo de la `Camera` de rnmapbox (no se exporta como `CameraRef` desde el índice). */
export type DirectedCameraRef = ElementRef<typeof Camera>;

/** Duración de la animación de re-encuadre (ms). Suave, "se va acercando la cámara" sin tirón. */
const ANIM_MS = 900;
/** Mínimo entre re-encuadres por TIEMPO (ms): no peleamos con cada tick del socket. */
const MIN_INTERVAL_MS = 2_500;
/**
 * Umbral de MOVIMIENTO (m): por debajo no re-encuadramos aunque pase el tiempo (evita micro-jitter).
 * Calibración del dueño (2026-07-14): 40→20 — cerca del recojo el zoom es alto y 40 m de deriva sin
 * re-encuadre eran ~100 px: el conductor se deslizaba debajo del sheet.
 */
const MOVE_THRESHOLD_M = 20;
/**
 * Span MÍNIMO (m) del box del fit dirigido. Cuando el conductor está llegando, el box
 * [conductor, recogida] degenera (metros) → zoom nivel-puerta y cualquier deriva lo saca del marco.
 * Inflamos el bounds a este span alrededor de su centro: el encuadre queda estable mientras se
 * acerca y el conductor SIEMPRE vive dentro de la ventana visible.
 */
const MIN_FIT_SPAN_M = 240;
/** Metros por grado de latitud (esférico, suficiente para inflar un box urbano). */
const METERS_PER_DEG_LAT = 111_320;
/** Tras un gesto manual, la cámara queda "libre" este tiempo (ms) antes de retomar el seguimiento. */
const FREE_MODE_MS = 8_000;
/**
 * Umbral (px) de cambio del inset inferior (sheet) que dispara un RE-ENCUADRE inmediato: el snap del
 * sheet cambió el área visible del mapa → el foco debe volver a quedar centrado en ella. Por debajo
 * (re-medidas sub-píxel del contenido) no vale la pena re-animar.
 */
const INSET_REFRAME_THRESHOLD_PX = 8;

/** Firma estable de un target para detectar cambios de FASE/INTENCIÓN (no de cada coordenada). */
function targetSignature(t: CameraTarget): string {
  if (t.mode === 'fit') {
    return `fit:${t.fitPoints.length}`;
  }
  // El pitch entra en la firma: el toggle 2D/3D del usuario clampea followPitch (AppMap) y debe
  // re-aplicar la cámara YA (es intención explícita), no esperar al próximo umbral de movimiento.
  return `${t.mode}:${t.followZoom ?? ''}:${t.followPitch ?? ''}`;
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
/** Infla un bounds [ne, sw] (lng,lat) hasta un span mínimo en metros, alrededor de su centro. */
function ensureMinSpan(
  bounds: {ne: [number, number]; sw: [number, number]},
  minSpanM: number,
): {ne: [number, number]; sw: [number, number]} {
  const [neLng, neLat] = bounds.ne;
  const [swLng, swLat] = bounds.sw;
  const centerLat = (neLat + swLat) / 2;
  const centerLng = (neLng + swLng) / 2;
  const metersPerDegLng =
    METERS_PER_DEG_LAT * Math.max(0.2, Math.cos((centerLat * Math.PI) / 180));
  const halfLatDeg = Math.max(
    (neLat - swLat) / 2,
    minSpanM / 2 / METERS_PER_DEG_LAT,
  );
  const halfLngDeg = Math.max(
    (neLng - swLng) / 2,
    minSpanM / 2 / metersPerDegLng,
  );
  return {
    ne: [centerLng + halfLngDeg, centerLat + halfLatDeg],
    sw: [centerLng - halfLngDeg, centerLat - halfLatDeg],
  };
}

export function useDirectedCamera(
  cameraRef: RefObject<DirectedCameraRef | null>,
  target: CameraTarget,
  bottomInset: number,
  topInset = 0,
): {onGesture: () => void} {
  const lastAppliedAt = useRef(0);
  const lastLead = useRef<GeoPoint | null>(null);
  const lastSignature = useRef<string>('');
  const freeUntil = useRef(0);
  const bottomInsetRef = useRef(bottomInset);
  bottomInsetRef.current = bottomInset;
  const topInsetRef = useRef(topInset);
  topInsetRef.current = topInset;
  // ÚLTIMO rumbo VÁLIDO aplicado en `follow` (course-up). Un ping sin heading (`null`) NO vuelve la
  // cámara al Norte de golpe: se mantiene este valor hasta la próxima muestra válida.
  const lastHeading = useRef<number | null>(null);
  // Target VIGENTE (para re-aplicarlo cuando cambia el inset del sheet, sin esperar otro tick).
  const currentTarget = useRef<CameraTarget>(target);
  currentTarget.current = target;

  const apply = useCallback(
    (t: CameraTarget): void => {
      const cam = cameraRef.current;
      if (!cam) return;
      const padBottom = bottomInsetRef.current;

      if (t.mode === 'fit') {
        if (t.fitPoints.length === 0) return; // el fit de ruta lo maneja la Camera declarativa del AppMap.
        const positions = t.fitPoints.map(toLngLat);
        const rawBounds = boundsOf(positions);
        if (!rawBounds) return;
        // Box con span MÍNIMO: llegando al recojo el bounds degenera y el conductor se salía del
        // marco entre re-encuadres (lo tapaba el sheet). Ver MIN_FIT_SPAN_M.
        const bounds = ensureMinSpan(rawBounds, MIN_FIT_SPAN_M);
        // Padding APRETADO + reserva del sheet abajo (ya CAPADA por el AppMap: `padBottom` nunca aplasta el
        // viewport). Calibración de GUSTO del dueño ("más encima de la acción"): bajamos de 56/48 a 40/36 →
        // el box [conductor+recogida] (enRoute) y el box casi-puntual sobre la recogida (arrived) cierran más,
        // dejando menos aire alrededor. En 'arrived' el conductor ya está sobre el origen → box mínimo → con
        // 40/36 el encuadre se siente BIEN cerrado (casi nivel calle sobre el punto de recogida) sin maxZoom
        // (el fit no lo aplica acá → se cierra por geometría). Con un solo punto, el bounds centra y el
        // padding chico fija un zoom cerrado. `setCamera` con bounds (no `fitBounds`) para RESETEAR
        // heading/pitch: al venir del follow course-up del viaje en curso, el overview vuelve norte-arriba
        // y cenital (un fit con la cámara girada/inclinada desconcierta).
        lastHeading.current = null;
        cam.setCamera({
          bounds: {ne: bounds.ne, sw: bounds.sw},
          padding: {
            // Top = chrome superior REAL (chip de ubicación/EN VIVO) que baja el AppMap; fallback al
            // margen histórico si nadie lo pasa.
            paddingTop: topInsetRef.current > 0 ? topInsetRef.current : 40,
            paddingRight: 36,
            paddingBottom: 40 + padBottom,
            paddingLeft: 36,
          },
          heading: 0,
          pitch: 0,
          animationDuration: ANIM_MS,
          animationMode: 'easeTo',
        });
        return;
      }

      if (!t.followPoint) return;
      // Course-up del viaje en curso: heading de la ÚLTIMA muestra válida (ping sin heading → se mantiene
      // el anterior; sin muestra previa → no se manda heading, la cámara conserva el que tenga). El easeTo
      // de ANIM_MS interpola el giro solo — no hace falta re-animar por ping (más sereno, sin mareo).
      const sample =
        typeof t.followHeading === 'number' && Number.isFinite(t.followHeading)
          ? t.followHeading
          : null;
      if (sample != null) lastHeading.current = sample;
      const heading = sample ?? lastHeading.current;
      cam.setCamera({
        centerCoordinate: toLngLat(t.followPoint),
        ...(t.followZoom != null ? {zoomLevel: t.followZoom} : {}),
        ...(heading != null ? {heading} : {}),
        // Pitch declarado por el target (viaje en curso ~FOLLOW_PITCH); sin él, cenital explícito (0)
        // para que un follow "plano" (compat) no herede la inclinación de una fase anterior.
        pitch: t.followPitch ?? 0,
        padding: {
          paddingTop: 0,
          paddingBottom: padBottom,
          paddingLeft: 0,
          paddingRight: 0,
        },
        animationDuration: ANIM_MS,
        animationMode: 'easeTo',
      });
    },
    [cameraRef],
  );

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

  // RE-ENCUADRE POR SNAP DEL SHEET: cuando el inset inferior cambia (el sheet se asentó en otro anclaje:
  // expandir/contraer/colapsar), el área visible del mapa cambió → re-aplicamos el target VIGENTE ya,
  // sin throttle (es un cambio de viewport, no un tick del socket) e ignorando el modo libre (colapsar
  // el sheet es intención explícita de ver el mapa re-encuadrado). Umbral chico para no re-animar por
  // re-medidas sub-píxel del contenido del sheet.
  const lastInsetApplied = useRef(bottomInset);
  useEffect(() => {
    if (
      Math.abs(bottomInset - lastInsetApplied.current) <
      INSET_REFRAME_THRESHOLD_PX
    ) {
      return;
    }
    lastInsetApplied.current = bottomInset;
    const t = currentTarget.current;
    lastLead.current = leadPoint(t);
    lastAppliedAt.current = Date.now();
    apply(t);
  }, [bottomInset, apply]);

  // Gesto manual del usuario: entra en modo libre (el seguimiento se reanuda solo a los FREE_MODE_MS).
  const onGesture = useCallback(() => {
    freeUntil.current = Date.now() + FREE_MODE_MS;
  }, []);

  return {onGesture};
}
