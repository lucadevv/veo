import type {GeoPoint, NearbyVehicle} from '@veo/api-client';
import {
  Camera,
  LineLayer,
  MapView,
  type MapState,
  MarkerView,
  ShapeSource,
} from '@rnmapbox/maps';
import {passengerMapRoute, RoutePin} from '@veo/ui-kit';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {StyleSheet, useWindowDimensions, View} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type {NearbyVehicleType} from '../../../features/dispatch/domain/dispatchRepository';
import {VehicleIcon} from '../../../features/dispatch/presentation/components/VehicleIcon';
import type {CameraTarget} from '../../../features/trip/presentation/hooks/mapDirector';
import {
  boundsOf,
  distanceMeters,
  LIMA_CENTER_LNGLAT,
  LIMA_ZOOM,
  toLngLat,
} from '../../utils/geo';
import {type DirectedCameraRef, useDirectedCamera} from './useDirectedCamera';
import {useIdleCamera} from './useIdleCamera';
import {RecenterButton} from './RecenterButton';
import {
  veoLightMapboxStyleJSON,
  veoLightMapboxStyleJSON2D,
} from './mapbox/veoLightStyle';
import {useMapViewModeStore} from '../stores/mapViewModeStore';

export interface AppMapProps {
  /** Centro inicial del mapa (cuando no se ajusta a la ruta). */
  center?: GeoPoint | null;
  /** Punto de ubicación del usuario (punto lima con halo). */
  userPoint?: GeoPoint | null;
  /** Origen del trayecto (anillo lima). */
  origin?: GeoPoint | null;
  /** Destino del trayecto (punto sólido lima). */
  destination?: GeoPoint | null;
  /** Ubicación en vivo del conductor. Se pinta como `VehicleIcon` (taxi del trip) si `showDriverVehicle`. */
  driver?: GeoPoint | null;
  /**
   * Rumbo del conductor en grados (0=N, horario). Si llega, el ícono del taxi se ROTA (transform rotate,
   * barato/GPU). `null`/ausente → sin rotación (mejor que un salto brusco a 0°).
   */
  driverHeading?: number | null;
  /** Tipo de vehículo del conductor para el ícono (CAR/MOTO). Default CAR si no se conoce. */
  driverVehicleType?: NearbyVehicleType;
  /**
   * Pinta el marker del conductor como `VehicleIcon` (taxi asignado, jerarquía sobre los nearby) en vez
   * del pin genérico. Lo decide el `mapDirector` por fase (pre-pickup / en curso). Default `false`.
   */
  showDriverVehicle?: boolean;
  /**
   * Muestra el punto de MI ubicación (`userPoint`). El `mapDirector` lo apaga en el viaje EN CURSO (el
   * pasajero va dentro del taxi; su punto es ruido). Default `true` (no rompe llamadas previas).
   */
  showUserPoint?: boolean;
  /**
   * Objetivo de cámara DECLARATIVO del `mapDirector` (fit conductor+recogida / follow taxi / center). Si
   * se pasa, el encuadre lo maneja `useDirectedCamera` (imperativo, con throttle + modo libre) en vez de
   * la `Camera` declarativa por `fitToRoute`/`center`. Memoizá el objeto en el padre (React.memo).
   */
  cameraTarget?: CameraTarget;
  /**
   * Vehículos cercanos ANÓNIMOS de AMBIENTE (idle/searching): autitos top-down de "hay autos por tu
   * zona". NO interactivos, z-order DEBAJO de usuario/origen/destino/conductor. Las coords ya vienen
   * REDONDEADAS del backend (~110m) → sirven de identidad estable para el `key`.
   */
  nearbyVehicles?: ReadonlyArray<NearbyVehicle>;
  /** Geometría de la ruta en orden GeoJSON [lng, lat] (de `/maps/quote` o polyline decodificada). */
  routeCoordinates?: ReadonlyArray<[number, number]>;
  /** Paradas intermedias ORDENADAS (Ola 2B): se pintan como beads `stop` entre origen y destino. */
  waypoints?: ReadonlyArray<GeoPoint>;
  /** Ajusta el encuadre a la ruta + markers (fitBounds). */
  fitToRoute?: boolean;
  /**
   * Padding del encuadre `fitBounds` por borde (px). Default 64 en los 4 lados. Útil cuando un panel
   * flota sobre el mapa: pasar `{ bottom: altoDelPanel }` reserva ese espacio para que la ruta no
   * quede tapada. Memoizá el objeto en el padre para no romper el `React.memo` del mapa.
   */
  fitEdgePadding?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  /** Permite fijar puntos tocando el mapa. */
  onPress?: (point: GeoPoint) => void;
  /**
   * Reporta el CENTRO del mapa cuando la cámara cambia (pan/zoom). Habilita el patrón "pin fijo al centro
   * + el mapa se mueve debajo + confirmar" (elegir recojo/destino). Se lee de `MapState.properties.center`.
   */
  onCenterChange?: (center: GeoPoint) => void;
  /** Deshabilita gestos (mapa decorativo en sheets). */
  interactive?: boolean;
  /**
   * Espacio (px) reservado ABAJO para un panel/bottomsheet que flota sobre el mapa. Desplaza el centro
   * de la cámara hacia ARRIBA esa cantidad, para que el punto centrado (userPoint) quede en la franja
   * VISIBLE por encima del sheet y no tapado por él. Memoizá el valor en el padre (React.memo).
   */
  bottomInset?: number;
  /**
   * Mapa de "mi ubicación" LIBRE (Home / OffersBoard): la cámara NO se controla por `center`/`userPoint`
   * (que llegan EN VIVO del GPS). Se centra UNA sola vez sobre el primer fix y luego el usuario panea
   * libre, sin snap-back, con un botón flotante para recentrarse. Sin esto, la cámara idle sigue el
   * `center` DECLARATIVO (patrón "pin al centro" de MapPick, que pasa un center ESTABILIZADO). Default
   * `false` → comportamiento idle previo intacto. Ver `useIdleCamera`.
   */
  showRecenter?: boolean;
}

const ROUTE_SOURCE = 'veo-route';
const FIT_PADDING = 64;
/**
 * CAP DURO del inset inferior que se reserva para el sheet en el `fitBounds`. El sheet de búsqueda/
 * ofertas puede medir hasta el 50% de la pantalla (su `maxContentFraction`); reservar TODO ese alto como
 * padding inferior comprimía el viewport útil del fit a ~43% y Mapbox bajaba el zoom brutalmente (la ruta
 * "se alejaba demasiado"). El encuadre debe reservar SIEMPRE como mucho la altura del PEEK colapsado:
 * topeamos el inset a este % de la pantalla. El sheet expandido TAPA el mapa (no lo comprime), igual que
 * Uber/Lyft. Por encima de este tope, el fit ignora el resto del sheet.
 */
const FIT_BOTTOM_INSET_FRACTION = 0.32;
/**
 * CAP del inset inferior para las cámaras de CENTRO/FOLLOW (no-fit). El `bottomInset` ahora sigue la
 * altura del snap ACTUAL del sheet (no solo el peek): expandido a ~94%, reservar TODO eso como padding
 * empujaría el punto centrado fuera de pantalla. Tope al 50%: el foco queda centrado en la franja
 * visible mientras haya franja razonable; con el sheet casi a pantalla completa, el sheet TAPA el mapa
 * (igual que el fit — misma filosofía Uber/Lyft del CAP de arriba, con más margen porque centrar un
 * punto tolera más padding que encuadrar un bounds).
 */
const CENTER_BOTTOM_INSET_FRACTION = 0.5;
/**
 * Red de zoom para el `fitBounds` declarativo: si la ruta es geográficamente chica (origen y destino
 * muy cerca), Mapbox acercaría demasiado; este tope evita un zoom-calle agresivo. NO impide el alejado
 * correcto de una ruta larga (eso es `minZoomLevel`, que dejamos libre para encuadrar bien). Es una red,
 * no la regla: el encuadre correcto manda. Calibración de GUSTO del dueño ("más encima"): subido de 16.5
 * a 17.0 → con los paddings de ruta ya más apretados (40), las rutas CORTAS pueden cerrar un toque más
 * sin irse a nivel-puerta (17.0 es el techo: por arriba ya no se ve la cuadra de contexto).
 */
const FIT_MAX_ZOOM = 17.0;
/** Tamaño del autito de ambiente (px). Chico: es decoración, no compite con los pins del flujo. */
const VEHICLE_SIZE = 30;
/** Tamaño del taxi ASIGNADO (px). Mayor que el ambiente → jerarquía: es EL conductor, no relleno. */
const DRIVER_VEHICLE_SIZE = 38;
/** Duración del fade-in de aparición del autito (ms). Sobrio, solo opacity (GPU). */
const VEHICLE_FADE_MS = 260;

const isValidPoint = (p: GeoPoint | null | undefined): p is GeoPoint =>
  p != null && Number.isFinite(p.lat) && Number.isFinite(p.lon);

interface NearbyVehicleMarkerProps {
  vehicle: NearbyVehicle;
}

/**
 * Marker de un autito de AMBIENTE. NO interactivo (sin `onPress`), `allowOverlap` para que se vean
 * apilados sin que el mapa los descarte. Aparición SUAVE con un fade-in de solo `opacity` (GPU, sin
 * translate que lo correría de su coordenada). `React.memo` (abajo) evita re-renderizar cada autito
 * cuando el poll trae la misma lista → no se castiga el 60fps del mapa.
 */
function NearbyVehicleMarkerComponent({
  vehicle,
}: NearbyVehicleMarkerProps): React.JSX.Element {
  const opacity = useSharedValue(0);
  useEffect(() => {
    opacity.value = withTiming(1, {duration: VEHICLE_FADE_MS});
  }, [opacity]);
  const fadeStyle = useAnimatedStyle(() => ({opacity: opacity.value}));

  return (
    <MarkerView
      coordinate={toLngLat({lat: vehicle.lat, lon: vehicle.lon})}
      anchor={{x: 0.5, y: 0.5}}
      allowOverlap>
      <Animated.View style={fadeStyle} pointerEvents="none">
        <VehicleIcon vehicleType={vehicle.vehicleType} size={VEHICLE_SIZE} />
      </Animated.View>
    </MarkerView>
  );
}

/** Memoizado por valor del vehículo: el poll re-renderiza el mapa, no cada autito ya pintado. */
const NearbyVehicleMarker = React.memo(NearbyVehicleMarkerComponent);

interface DriverVehicleMarkerProps {
  point: GeoPoint;
  heading: number | null | undefined;
  vehicleType: NearbyVehicleType;
}

/**
 * Marker del CONDUCTOR ASIGNADO: `VehicleIcon` (CAR/MOTO del trip) más grande que el ambiente para
 * jerarquía. Si llega `heading` se rota con `transform: rotate` (barato, GPU); sin heading NO se rota
 * (mejor que clavarlo en 0°/Norte y que pegue saltos). Memoizado por valor → el stream del socket no
 * re-monta el SVG, solo actualiza la coord del `MarkerView`.
 */
function DriverVehicleMarkerComponent({
  point,
  heading,
  vehicleType,
}: DriverVehicleMarkerProps): React.JSX.Element {
  const rotation =
    typeof heading === 'number' && Number.isFinite(heading) ? heading : null;
  return (
    <MarkerView
      coordinate={toLngLat(point)}
      anchor={{x: 0.5, y: 0.5}}
      allowOverlap>
      <View
        pointerEvents="none"
        style={
          rotation != null
            ? {transform: [{rotate: `${rotation}deg`}]}
            : undefined
        }>
        <VehicleIcon vehicleType={vehicleType} size={DRIVER_VEHICLE_SIZE} />
      </View>
    </MarkerView>
  );
}

const DriverVehicleMarker = React.memo(DriverVehicleMarkerComponent);

/** Duración del deslizamiento entre dos ticks del socket (~cadencia del ping GPS). */
const DRIVER_LERP_MS = 900;
/** Paso de la interpolación (~30 fps: el auto se DESLIZA en vez de avanzar en pasitos; con la New
 * Architecture (Fabric) el único prop que cambia es la coordenada del MarkerView — barato). */
const DRIVER_LERP_STEP_MS = 33;
/** Salto mayor a esto = teletransporte deliberado (primer fix / reasignación), sin deslizar. */
const DRIVER_TELEPORT_METERS = 300;

/**
 * Suaviza la posición del conductor entre ticks del socket: en vez de SALTAR a la coord cruda de
 * cada `driver:location` (2-5 s entre pings → brincos visibles, sobre todo en `follow` con zoom
 * alto), DESLIZA linealmente hacia el nuevo punto en ~0.9 s a 10 fps. Un salto grande (> 300 m:
 * primer fix, reasignación de conductor) se aplica directo — deslizar medio distrito sería mentir.
 */
function useSmoothedPoint(target: GeoPoint | null): GeoPoint | null {
  const [smoothed, setSmoothed] = useState<GeoPoint | null>(target);
  const shownRef = useRef<GeoPoint | null>(target);
  useEffect(() => {
    const from = shownRef.current;
    if (!target) {
      shownRef.current = null;
      setSmoothed(null);
      return;
    }
    if (!from || distanceMeters(from, target) > DRIVER_TELEPORT_METERS) {
      shownRef.current = target;
      setSmoothed(target);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / DRIVER_LERP_MS);
      const next = {
        lat: from.lat + (target.lat - from.lat) * t,
        lon: from.lon + (target.lon - from.lon) * t,
      };
      shownRef.current = next;
      setSmoothed(next);
      if (t >= 1) clearInterval(id);
    }, DRIVER_LERP_STEP_MS);
    return () => clearInterval(id);
  }, [target?.lat, target?.lon]); // eslint-disable-line react-hooks/exhaustive-deps
  return smoothed;
}

/**
 * Lienzo de mapa del pasajero sobre **`@rnmapbox/maps`** (Lote 4: migración a Mapbox, gemelo del
 * conductor). El estilo veo-dark "Midnight Motion" se inyecta vía `styleJSON` (Mapbox Streets v8,
 * paleta idéntica al tileserver propio anterior). Centraliza el encuadre, los markers de
 * origen/destino/usuario/conductor y la polyline de ruta con glow (dos capas: halo ancho translúcido
 * + línea lima nítida, tokens `passengerMapRoute`). El chrome (overlays) lo aporta `MapShell`.
 *
 * El marker `driver` es el diferenciador "ver el taxi en vivo por tu zona": la ubicación llega del
 * socket `/passenger` (`driver:location` → `driverLocation`) y se pinta como `RoutePin` pulsante.
 *
 * El token público de Mapbox se establece una sola vez en el bootstrap nativo
 * (`src/core/maps/mapbox.ts`, invocado desde `src/bootstrap/native.ts`), por eso aquí no se toca el
 * token.
 */
function AppMapComponent({
  center,
  userPoint,
  origin,
  destination,
  driver,
  driverHeading,
  driverVehicleType = 'CAR',
  showDriverVehicle = false,
  showUserPoint = true,
  cameraTarget,
  nearbyVehicles,
  routeCoordinates,
  waypoints,
  fitToRoute = false,
  fitEdgePadding,
  onPress,
  onCenterChange,
  interactive = true,
  bottomInset = 0,
  showRecenter = false,
}: AppMapProps): React.JSX.Element {
  // Posición del conductor SUAVIZADA (lerp entre ticks del socket): el marker desliza, no salta.
  const smoothedDriver = useSmoothedPoint(isValidPoint(driver) ? driver : null);
  // MODO DE VISTA 2D/3D (preferencia persistida del usuario). En 2D: estilo sin extrusiones
  // (building-3d oculto) + pitch CLAMPEADO a 0 — el course-up del viaje en curso sigue rotando el
  // bearing, pero plano. En 3D: comportamiento vigente intacto.
  const viewMode = useMapViewModeStore(s => s.mode);
  const effectiveCameraTarget = useMemo<CameraTarget | undefined>(() => {
    if (!cameraTarget) return undefined;
    // Solo el follow declara pitch; clampearlo acá (y no en el director) mantiene al director PURO de
    // preferencias de vista — la fase decide la coreografía, el usuario decide la perspectiva.
    if (viewMode === '2d' && (cameraTarget.followPitch ?? 0) !== 0) {
      return {...cameraTarget, followPitch: 0};
    }
    return cameraTarget;
  }, [cameraTarget, viewMode]);
  // Cámara DIRIGIDA por el `mapDirector` (encuadre conductor+recogida / follow taxi). Cuando hay
  // `cameraTarget`, el encuadre lo maneja `useDirectedCamera` imperativamente (throttle + modo libre);
  // si no, la `Camera` declarativa de abajo gobierna como siempre (bounds de ruta / center).
  const directedCamera = effectiveCameraTarget != null;
  const cameraRef = useRef<DirectedCameraRef | null>(null);
  const noopTarget = useMemo<CameraTarget>(
    () => ({mode: 'center', fitPoints: [], followPoint: null}),
    [],
  );

  // CAP del inset inferior reservado al sheet en el encuadre: la altura del PEEK puede llegar al 50% de
  // pantalla, pero para FITear (ruta / conductor+recogida) jamás reservamos más que `FIT_BOTTOM_INSET_FRACTION`.
  // Así el viewport útil del fit no se aplasta cuando el sheet de ofertas mide alto. El `center` simple
  // (idle) SÍ usa el inset crudo: ahí no hay fit que comprimir, solo se sube el punto centrado.
  const {height: windowHeight} = useWindowDimensions();
  const fitBottomInset = useMemo(
    () =>
      Math.min(
        bottomInset,
        Math.round(windowHeight * FIT_BOTTOM_INSET_FRACTION),
      ),
    [bottomInset, windowHeight],
  );
  // CAP (más laxo) para las cámaras de CENTRO: ver CENTER_BOTTOM_INSET_FRACTION. Aplica al center
  // declarativo y al idle imperativo; el follow dirigido usa el CAP de fit (comparten viewport útil).
  const centerBottomInset = useMemo(
    () =>
      Math.min(
        bottomInset,
        Math.round(windowHeight * CENTER_BOTTOM_INSET_FRACTION),
      ),
    [bottomInset, windowHeight],
  );

  const {onGesture} = useDirectedCamera(
    cameraRef,
    effectiveCameraTarget ?? noopTarget,
    fitBottomInset,
  );

  // Mapa "mi ubicación" libre: solo cuando se pide recentrar Y la cámara NO está dirigida (la dirigida la
  // gobierna `useDirectedCamera` por el MISMO `cameraRef` → nunca deben pelear). Punto a centrar = el
  // centro válido, o el userPoint. Si no aplica, `null` → `useIdleCamera` no toca la cámara.
  const freeBrowse = showRecenter && !directedCamera;
  const idlePoint = isValidPoint(center)
    ? center
    : isValidPoint(userPoint)
      ? userPoint
      : null;
  const {recenter} = useIdleCamera(
    cameraRef,
    freeBrowse ? idlePoint : null,
    centerBottomInset,
  );

  // Gesto manual del usuario → modo libre (solo si la cámara está dirigida). `isGestureActive` lo
  // reporta rnmapbox en `onCameraChanged`: detectar el pellizco/arrastre es barato con este callback.
  // onCameraChanged dispara por FRAME durante el pan (~60×/s). Emitir el centro en cada frame haría
  // re-renderizar al consumer 60×/s (jank, regla "Map a 60fps"). Throttle leading+trailing a ~120ms:
  // emite ya si pasó el intervalo, y agenda el ÚLTIMO punto al soltar (trailing) para no perder el destino.
  const centerEmit = useRef<{
    last: number;
    timer: ReturnType<typeof setTimeout> | null;
    pending: GeoPoint | null;
  }>({
    last: 0,
    timer: null,
    pending: null,
  });
  const emitCenter = useCallback(
    (point: GeoPoint) => {
      if (!onCenterChange) return;
      const ref = centerEmit.current;
      ref.pending = point;
      const elapsed = Date.now() - ref.last;
      if (elapsed >= 120) {
        ref.last = Date.now();
        onCenterChange(point);
      } else if (!ref.timer) {
        ref.timer = setTimeout(() => {
          ref.timer = null;
          ref.last = Date.now();
          if (ref.pending) onCenterChange(ref.pending);
        }, 120 - elapsed);
      }
    },
    [onCenterChange],
  );
  useEffect(
    () => () => {
      if (centerEmit.current.timer) clearTimeout(centerEmit.current.timer);
    },
    [],
  );

  const onCameraChanged = useCallback(
    (state: MapState) => {
      if (directedCamera && state.gestures?.isGestureActive) {
        onGesture();
      }
      // Patrón "pin al centro": reporta el centro ([lng, lat] → GeoPoint), throttleado. Defensa ante
      // coords no finitas (la cámara nativa puede emitir un estado transitorio inválido).
      if (onCenterChange) {
        const c = state.properties?.center;
        const lng = c?.[0];
        const lat = c?.[1];
        if (
          typeof lng === 'number' &&
          typeof lat === 'number' &&
          Number.isFinite(lng) &&
          Number.isFinite(lat)
        ) {
          emitCenter({lat, lon: lng});
        }
      }
    },
    [directedCamera, onGesture, onCenterChange, emitCenter],
  );
  // GeoJSON de la ruta (LineString). Vacío si no hay suficientes puntos.
  const routeShape = useMemo<GeoJSON.Feature<GeoJSON.LineString> | null>(() => {
    if (!routeCoordinates || routeCoordinates.length < 2) {
      return null;
    }
    return {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: routeCoordinates as [number, number][],
      },
    };
  }, [routeCoordinates]);

  // Encuadre: si se pide ajustar a la ruta, calcula bounds de ruta + markers.
  const bounds = useMemo(() => {
    if (!fitToRoute) {
      return null;
    }
    const positions: [number, number][] = [];
    if (routeCoordinates) {
      positions.push(...(routeCoordinates as [number, number][]));
    }
    for (const point of [origin, destination, userPoint, driver]) {
      if (isValidPoint(point)) {
        positions.push(toLngLat(point));
      }
    }
    return boundsOf(positions);
  }, [fitToRoute, routeCoordinates, origin, destination, userPoint, driver]);

  // Centro estable POR VALOR (no por referencia de array): evita que la `Camera` se re-anime en
  // CADA render del padre. Sin esto, RequestFlowScreen re-renderiza al tipear/cambiar estado y
  // `toLngLat` devuelve un array nuevo → la Camera entra en bucle de re-animación → el contexto GL
  // nunca se asienta → mapa NEGRO. Memoizar por lat/lng corta el churn. Defensa ante coordenadas no
  // finitas (GPS corrupto): caemos al centro de Lima en vez de pasar [NaN, NaN] a la Camera nativa.
  const centerCoordinate = useMemo<[number, number]>(() => {
    if (isValidPoint(center)) return toLngLat(center);
    if (isValidPoint(userPoint)) return toLngLat(userPoint);
    return LIMA_CENTER_LNGLAT;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.lat, center?.lon, userPoint?.lat, userPoint?.lon]);

  const mapView = (
    <MapView
      style={StyleSheet.absoluteFill}
      // Variante del estilo por preferencia 2D/3D: alternar recarga el estilo — aceptable, es un
      // gesto deliberado y esporádico (no un hot-path del render).
      styleJSON={
        viewMode === '2d' ? veoLightMapboxStyleJSON2D : veoLightMapboxStyleJSON
      }
      logoEnabled={false}
      attributionEnabled={false}
      compassEnabled={false}
      scaleBarEnabled={false}
      rotateEnabled={interactive}
      scrollEnabled={interactive}
      zoomEnabled={interactive}
      pitchEnabled={false}
      onCameraChanged={
        directedCamera || onCenterChange ? onCameraChanged : undefined
      }
      onPress={
        onPress
          ? feature => {
              const geometry = feature.geometry;
              if (
                geometry &&
                geometry.type === 'Point' &&
                geometry.coordinates.length >= 2
              ) {
                const [lng, lat] = geometry.coordinates as [number, number];
                onPress({lat, lon: lng});
              }
            }
          : undefined
      }>
      {directedCamera ? (
        // Cámara DIRIGIDA: el encuadre lo aplica `useDirectedCamera` por el ref (fit conductor+recogida /
        // follow taxi, con throttle + modo libre). `defaultSettings` da un estado inicial estable hasta el
        // primer comando del director (evita un flash en el centro de Lima al montar el modo trip).
        <Camera
          ref={cameraRef}
          defaultSettings={{centerCoordinate, zoomLevel: LIMA_ZOOM}}
          animationDuration={500}
        />
      ) : bounds ? (
        <Camera
          bounds={{ne: bounds.ne, sw: bounds.sw}}
          padding={{
            paddingLeft: fitEdgePadding?.left ?? FIT_PADDING,
            paddingRight: fitEdgePadding?.right ?? FIT_PADDING,
            paddingTop: fitEdgePadding?.top ?? FIT_PADDING,
            // El bottom del fit jamás supera el CAP (no aplastamos el viewport con un sheet alto). El
            // padre ya pasa `peekHeight`, pero acá lo topamos por seguridad ante un peek medido grande.
            paddingBottom: Math.min(
              fitEdgePadding?.bottom ?? FIT_PADDING,
              Math.round(windowHeight * FIT_BOTTOM_INSET_FRACTION),
            ),
          }}
          // Red de zoom: si la ruta es chica, no acercamos a zoom-calle agresivo. NO limita el alejado
          // de rutas largas (encuadre correcto manda). Ver FIT_MAX_ZOOM.
          maxZoomLevel={FIT_MAX_ZOOM}
          // Overview de ruta SIEMPRE norte-arriba y cenital: al montar viniendo de una fase con follow
          // course-up/pitch (viaje en curso), sin esto la cámara heredaría el giro/inclinación previos.
          heading={0}
          pitch={0}
          animationDuration={500}
        />
      ) : freeBrowse ? (
        // Mapa "mi ubicación" LIBRE: cámara NO controlada (`defaultSettings` = solo estado inicial). Sin
        // `centerCoordinate` declarativo, rnmapbox NO re-asserta el centro cuando `myLocation` cambia (GPS
        // tick / foreground) → se acabó el snap-back que peleaba el paneo. El centrado inicial sobre el
        // primer fix y el botón "recentrarme" los maneja `useIdleCamera` (imperativo, por el `cameraRef`).
        <Camera
          ref={cameraRef}
          defaultSettings={{centerCoordinate, zoomLevel: LIMA_ZOOM}}
          animationDuration={500}
        />
      ) : (
        <Camera
          centerCoordinate={centerCoordinate}
          zoomLevel={LIMA_ZOOM}
          // Reserva el alto del sheet abajo → el centro real sube y el userPoint queda en la franja
          // visible (no tapado por el bottomsheet). CAPADO (CENTER_BOTTOM_INSET_FRACTION): el inset
          // ahora sigue el snap ACTUAL del sheet y expandido casi-full empujaría el centro fuera de
          // pantalla. Sin sheet (bottomInset=0) centra como siempre.
          padding={{
            paddingTop: 0,
            paddingBottom: centerBottomInset,
            paddingLeft: 0,
            paddingRight: 0,
          }}
          // Norte-arriba y cenital explícitos (mismo motivo que el fit de arriba: no heredar el
          // course-up/pitch del follow del viaje en curso al volver a una fase de centro).
          heading={0}
          pitch={0}
          animationDuration={500}
        />
      )}

      {routeShape ? (
        <ShapeSource id={ROUTE_SOURCE} shape={routeShape}>
          {/* Halo ancho translúcido (glow). */}
          <LineLayer
            id="veo-route-glow"
            style={{
              lineColor: passengerMapRoute.routeGlowColor,
              lineWidth: passengerMapRoute.routeGlowWidth,
              lineCap: 'round',
              lineJoin: 'round',
            }}
          />
          {/* Línea lima nítida encima. */}
          <LineLayer
            id="veo-route-line"
            style={{
              lineColor: passengerMapRoute.routeColor,
              lineWidth: passengerMapRoute.routeWidth,
              lineCap: 'round',
              lineJoin: 'round',
            }}
          />
        </ShapeSource>
      ) : null}

      {/* AMBIENTE: autitos cercanos anónimos. Se renderizan ANTES (z-order DEBAJO) de los pins del flujo
          (usuario/origen/destino/conductor), que van a continuación. Key estable por coord (ya redondeada
          por el backend) + tipo: identidad de la celda, sin re-montar cuando el poll repite la misma. */}
      {nearbyVehicles?.map(vehicle => (
        <NearbyVehicleMarker
          key={`${vehicle.lat}:${vehicle.lon}:${vehicle.vehicleType}`}
          vehicle={vehicle}
        />
      ))}

      {showUserPoint && isValidPoint(userPoint) ? (
        <MarkerView
          coordinate={toLngLat(userPoint)}
          anchor={{x: 0.5, y: 0.5}}
          allowOverlap>
          <RoutePin variant="user" pulse />
        </MarkerView>
      ) : null}

      {isValidPoint(origin) ? (
        <MarkerView
          coordinate={toLngLat(origin)}
          anchor={{x: 0.5, y: 0.5}}
          allowOverlap>
          <RoutePin variant="origin" />
        </MarkerView>
      ) : null}

      {/* Paradas intermedias (Ola 2B): beads `stop` más chicos, entre origen y destino. */}
      {waypoints?.map((wp, i) =>
        isValidPoint(wp) ? (
          <MarkerView
            key={`wp:${wp.lat}:${wp.lon}:${i}`}
            coordinate={toLngLat(wp)}
            anchor={{x: 0.5, y: 0.5}}
            allowOverlap>
            <RoutePin variant="stop" size={13} />
          </MarkerView>
        ) : null,
      )}

      {isValidPoint(destination) ? (
        <MarkerView
          coordinate={toLngLat(destination)}
          anchor={{x: 0.5, y: 1}}
          allowOverlap>
          <RoutePin variant="destination" />
        </MarkerView>
      ) : null}

      {/* CONDUCTOR ASIGNADO en vivo (socket `/passenger`). Con `showDriverVehicle` (fases de viaje), el
          taxi del trip (VehicleIcon CAR/MOTO, rotado por heading). Si no, el pin pulsante genérico
          (compat: "taxi en vivo en tu zona" del ambiente previo). */}
      {smoothedDriver ? (
        showDriverVehicle ? (
          <DriverVehicleMarker
            point={smoothedDriver}
            heading={driverHeading}
            vehicleType={driverVehicleType}
          />
        ) : (
          <MarkerView
            coordinate={toLngLat(smoothedDriver)}
            anchor={{x: 0.5, y: 0.5}}
            allowOverlap>
            <RoutePin variant="user" pulse />
          </MarkerView>
        )
      ) : null}
    </MapView>
  );

  // Sin modo libre → solo el lienzo (byte-idéntico para los consumidores que NO lo activan: MapPick,
  // RequestFlow, Reassign… o un dirigido). El árbol no cambia para ellos.
  if (!freeBrowse) return mapView;

  // Modo "mi ubicación" libre: el lienzo + el botón flotante "recentrarme" por encima (y del sheet).
  return (
    <View style={StyleSheet.absoluteFill}>
      {mapView}
      {interactive && isValidPoint(idlePoint) ? (
        <RecenterButton onPress={recenter} bottomInset={bottomInset} />
      ) : null}
    </View>
  );
}

/**
 * Memoizado: el mapa solo re-renderiza si sus props cambian de VALOR (shallow). Sin esto, cada
 * re-render del padre (RequestFlowScreen tipeando/cambiando estado, OffersBoard refrescando ofertas)
 * re-ejecutaba el componente y, junto con un centro inestable, mantenía al contexto GL en churn
 * → mapa negro. Con memo + centro estable, el GL se asienta y el mapa renderiza.
 */
export const AppMap = React.memo(AppMapComponent);
