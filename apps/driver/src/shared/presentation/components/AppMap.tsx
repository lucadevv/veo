import type { GeoPoint } from '@veo/api-client';
import { Camera, CircleLayer, LineLayer, MapView, MarkerView, ShapeSource } from '@rnmapbox/maps';
import { driverMapRoute, RoutePin, useTheme } from '@veo/ui-kit';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { env } from '../../../core/config/env';
import {
  boundsOf,
  distanceMeters,
  LIMA_CENTER_LNGLAT,
  LIMA_ZOOM,
  toLngLat,
} from '../../utils/geo';
import { fitVerticalPadding, focusPadding } from '../../utils/mapCamera';
import { useMapViewModeStore } from '../stores/mapViewModeStore';
import { veoLightMapboxStyleJSON, veoLightMapboxStyleJSON2D } from './mapbox/veoLightStyle';
import { NavPuck } from './NavPuck';

/** Celda de demanda a pintar sobre el mapa (centroide + estilo ya derivado de la intensidad). */
export interface HeatCell {
  /** Identificador estable de la celda (índice H3). */
  id: string;
  /** Centro de la celda en orden GeoJSON [lng, lat]. */
  coordinate: [number, number];
  /** Opacidad del relleno (0..1) derivada de la intensidad. */
  opacity: number;
  /** Radio del círculo en metros derivado de la intensidad. */
  radiusMeters: number;
}

export interface AppMapProps {
  /** Centro inicial del mapa (cuando no se ajusta a la ruta). */
  center?: GeoPoint | null;
  /** Ubicación en vivo del conductor (anillo cian pulsante). */
  driver?: GeoPoint | null;
  /** Origen del trayecto / punto de recojo (anillo cian). */
  origin?: GeoPoint | null;
  /** Destino del trayecto (punto sólido cian). */
  destination?: GeoPoint | null;
  /** Geometría de la ruta en orden GeoJSON [lng, lat] (de `/maps/quote` o polyline decodificada). */
  routeCoordinates?: ReadonlyArray<[number, number]>;
  /** Paradas intermedias ORDENADAS (Ola 2B): se pintan como beads `stop` entre origen y destino. */
  waypoints?: ReadonlyArray<GeoPoint>;
  /** Celdas de demanda (mapa de calor). Cuando se pasan, se pintan como círculos cian translúcidos. */
  heatCells?: ReadonlyArray<HeatCell>;
  /** Ajusta el encuadre a la ruta + markers (fitBounds). */
  fitToRoute?: boolean;
  /**
   * Modo NAVEGACIÓN (estilo Waze): la cámara SIGUE al conductor con vista inclinada, orientada al
   * rumbo (heading-up) y zoom cercano, en vez del encuadre general. Requiere `driver` válido; si no
   * hay ubicación, degrada al encuadre/centro normal. Tiene prioridad sobre `fitToRoute`.
   */
  navMode?: boolean;
  /** Rumbo del conductor en grados (0=N, 90=E) para orientar la cámara en navegación (heading-up). */
  heading?: number | null;
  /**
   * Chrome que TAPA el mapa por arriba, en px (banner de maniobras, header flotante). La cámara
   * centra el foco en el ÁREA VISIBLE (viewport − insets), no en la pantalla completa.
   */
  topInset?: number;
  /** Chrome que TAPA el mapa por abajo, en px (sheet del viaje, dock del dashboard). */
  bottomInset?: number;
  /**
   * Clase del vehículo activo (wire string `VehicleClass`): el puck de navegación lleva el glyph
   * moto/auto. Sin dato (`null`) el puck cae a la flecha genérica (degradación honesta).
   */
  vehicleType?: string | null;
  /** Deshabilita gestos (mapa decorativo en sheets). */
  interactive?: boolean;
}

const ROUTE_SOURCE = 'veo-route';
const HEAT_SOURCE = 'veo-heat';
const FIT_PADDING = 64;

/* ── Cámara de NAVEGACIÓN (Waze) — constantes tipadas, NO magic numbers (§4-ter) ──────────────────
 * Vista de conducción: inclinada para dar profundidad 3D, zoom cercano para ver la próxima maniobra,
 * y transición `easeTo` corta para que el seguimiento se sienta fluido sin marearse. */
/** Inclinación de la cámara en navegación (grados desde el cenital). */
const NAV_PITCH = 55;
/** Inclinación en modo 2D: cenital puro — la navegación queda heading-up pero PLANA. */
const NAV_PITCH_FLAT = 0;
/** Zoom de navegación (calle/maniobra). */
const NAV_ZOOM = 17;
/** Duración de la transición de seguimiento entre muestras de GPS (ms). */
const NAV_ANIM_MS = 700;
/**
 * Posición del puck en NAVEGACIÓN como fracción (desde ARRIBA) del área visible: 0.70 = tercio
 * inferior (patrón Waze/Google — se ve más carretera adelante que atrás). Parámetro de gusto.
 */
const NAV_PUCK_VIEWPORT_FRACTION = 0.7;
/** Posición del foco FUERA de navegación: centro geométrico del área visible. */
const CENTER_VIEWPORT_FRACTION = 0.5;

const isValidPoint = (p: GeoPoint | null | undefined): p is GeoPoint =>
  p != null && Number.isFinite(p.lat) && Number.isFinite(p.lon);

/* ── Suavizado del puck (gemelo del pasajero — misma técnica, mismos umbrales) ─────────────────── */
/** Duración del deslizamiento entre dos muestras de GPS (~cadencia del ping). */
const DRIVER_LERP_MS = 900;
/** Paso de la interpolación (~30 fps: el puck se DESLIZA en vez de saltar de celda en celda). */
const DRIVER_LERP_STEP_MS = 33;
/** Salto mayor a esto = teletransporte deliberado (primer fix / reset del sim), sin deslizar. */
const DRIVER_TELEPORT_METERS = 300;

/**
 * Suaviza la posición del conductor entre muestras del GPS: en vez de SALTAR a la coord cruda de
 * cada ping (1-3 s entre muestras → brincos visibles con el zoom de navegación), DESLIZA linealmente
 * hacia el nuevo punto. SOLO alimenta el MarkerView del puck: la Camera sigue el ping CRUDO (su
 * easeTo de NAV_ANIM_MS ya interpola solo; dárselo suavizado reiniciaría la animación cada 33 ms).
 * Un salto grande (> 300 m: primer fix, vuelta a base del sim) se aplica directo.
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
 * Lienzo de mapa del conductor sobre **`@rnmapbox/maps`** (Lote 0+1: migración a Mapbox). El estilo
 * veo-light "Daylight Trust" (Theme de Confianza) se inyecta vía `styleJSON` (Mapbox Streets v8, paleta
 * idéntica al passenger/admin-web; canvas #F5F7FA = token `bg`). Centraliza el encuadre, los markers de
 * conductor/recojo/destino (ruta teal `driverMapRoute`), la
 * polyline de ruta con glow (dos capas: halo ancho translúcido + línea cian nítida, tokens
 * `driverMapRoute`) y el mapa de calor de demanda. El chrome (overlays) lo aporta `MapShell`.
 *
 * El token público de Mapbox se establece una sola vez en el bootstrap nativo
 * (`src/core/maps/mapbox.ts`, llamado desde `index.js`), por eso aquí no se toca el token.
 */
function AppMapComponent({
  center,
  driver,
  origin,
  destination,
  routeCoordinates,
  waypoints,
  heatCells,
  fitToRoute = false,
  navMode = false,
  heading,
  topInset = 0,
  bottomInset = 0,
  vehicleType = null,
  interactive = true,
}: AppMapProps): React.JSX.Element {
  const theme = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  // MODO DE VISTA 2D/3D (preferencia persistida del usuario, espejo del pasajero). En 2D: estilo sin
  // extrusiones (`building-3d` oculto) + pitch de navegación CLAMPEADO a 0 — el heading-up sigue
  // rotando el rumbo, pero plano. En 3D: comportamiento vigente intacto.
  const viewMode = useMapViewModeStore((s) => s.mode);
  // Navegación activa SOLO si se pidió `navMode` Y hay una ubicación de conductor válida que seguir
  // (sin ubicación no hay a quién seguir → degrada al encuadre normal, degradación honesta).
  const navigating = navMode && isValidPoint(driver);
  // Puck DESLIZADO entre pings (solo el marker; la cámara y los bounds siguen el ping crudo).
  const smoothedDriver = useSmoothedPoint(isValidPoint(driver) ? driver : null);
  // GeoJSON de la ruta (LineString). Vacío si no hay suficientes puntos.
  const routeShape = useMemo<GeoJSON.Feature<GeoJSON.LineString> | null>(() => {
    if (!routeCoordinates || routeCoordinates.length < 2) {
      return null;
    }
    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: routeCoordinates as [number, number][] },
    };
  }, [routeCoordinates]);

  // GeoJSON del mapa de calor (FeatureCollection de puntos con opacidad/radio por celda). Los
  // estilos data-driven (`get`) leen estas propiedades por feature, así una sola capa pinta todas
  // las celdas con distinta intensidad. Vacío si no hay celdas.
  const heatShape = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point> | null>(() => {
    if (!heatCells || heatCells.length === 0) {
      return null;
    }
    // Solo celdas con coordenada [lng, lat] numérica válida: una coordenada NaN/incompleta produce un
    // GeoJSON inválido que la capa nativa puede rechazar (crash nativo). Si tras filtrar no queda
    // ninguna, devolvemos null para no montar la `ShapeSource`.
    const features = heatCells
      .filter(
        (cell) =>
          Array.isArray(cell.coordinate) &&
          Number.isFinite(cell.coordinate[0]) &&
          Number.isFinite(cell.coordinate[1]),
      )
      .map((cell) => ({
        type: 'Feature' as const,
        id: cell.id,
        properties: { opacity: cell.opacity, radiusMeters: cell.radiusMeters },
        geometry: { type: 'Point' as const, coordinates: cell.coordinate as [number, number] },
      }));
    if (features.length === 0) {
      return null;
    }
    return { type: 'FeatureCollection', features };
  }, [heatCells]);

  // Encuadre: si se pide ajustar a la ruta, calcula bounds de ruta + markers.
  const bounds = useMemo(() => {
    if (!fitToRoute) {
      return null;
    }
    const positions: [number, number][] = [];
    if (routeCoordinates) {
      positions.push(...(routeCoordinates as [number, number][]));
    }
    for (const point of [origin, destination, driver]) {
      if (isValidPoint(point)) {
        positions.push(toLngLat(point));
      }
    }
    return boundsOf(positions);
  }, [fitToRoute, routeCoordinates, origin, destination, driver]);

  // Centro estable POR VALOR (no por referencia de array): evita que la `Camera` se re-anime en CADA
  // render del padre. Sin esto, las pantallas que re-renderizan (Dashboard refrescando estado/heatmap)
  // producirían un `centerCoordinate` nuevo en cada pasada → la Camera entra en bucle de re-animación
  // → el contexto GL nunca se asienta → mapa negro. Defensa ante coordenadas no finitas (GPS corrupto):
  // caemos al centro de Lima en vez de pasar [NaN, NaN] a la Camera nativa.
  const centerCoordinate = useMemo<[number, number]>(() => {
    if (isValidPoint(center)) return toLngLat(center);
    if (isValidPoint(driver)) return toLngLat(driver);
    return LIMA_CENTER_LNGLAT;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.lat, center?.lon, driver?.lat, driver?.lon]);

  // ── Paddings de cámara CONSCIENTES del chrome (sheet abajo + banner arriba) ────────────────────
  // Memoizados sobre NÚMEROS (misma disciplina que `centerCoordinate`: estables POR VALOR): un objeto
  // nuevo por render re-animaría la Camera en bucle. Solo cambian cuando el snap del sheet se asienta
  // o el banner (re)aparece — cuantizado aguas arriba — y ahí SÍ queremos el re-encuadre animado.
  // En navegación el puck va al TERCIO INFERIOR del área visible (más carretera adelante).
  // VERIFICADO en runtime (2026-07-14, iOS new-arch + @rnmapbox 10.3.1, GPS congelado): un cambio de
  // SOLO `padding` con el MISMO centerCoordinate SÍ re-anima la Camera declarativa — el `stop` se
  // deep-compara en Fabric (folly::dynamic) y el nativo aplica cada set sin dedup. No hace falta
  // setCamera imperativo para re-encuadrar al cambiar el inset del sheet.
  const navPadding = useMemo(() => {
    const v = focusPadding(windowHeight, topInset, bottomInset, NAV_PUCK_VIEWPORT_FRACTION);
    return { paddingTop: v.top, paddingBottom: v.bottom, paddingLeft: 0, paddingRight: 0 };
  }, [windowHeight, topInset, bottomInset]);
  const centerPadding = useMemo(() => {
    const v = focusPadding(windowHeight, topInset, bottomInset, CENTER_VIEWPORT_FRACTION);
    return { paddingTop: v.top, paddingBottom: v.bottom, paddingLeft: 0, paddingRight: 0 };
  }, [windowHeight, topInset, bottomInset]);
  // Encuadre fit: el FIT_PADDING fijo + el chrome dinámico (la ruta completa se ve aun con el sheet
  // en 'content'). Acotado a un área visible mínima para no degenerar el zoom.
  const fitPadding = useMemo(() => {
    const v = fitVerticalPadding(windowHeight, FIT_PADDING, topInset, bottomInset);
    return {
      paddingTop: v.top,
      paddingBottom: v.bottom,
      paddingLeft: FIT_PADDING,
      paddingRight: FIT_PADDING,
    };
  }, [windowHeight, topInset, bottomInset]);

  // FAIL-SAFE de token (fail-closed contra el crash NATIVO): `@rnmapbox/maps` v10 CRASHEA el proceso al
  // montar un `MapView` si nunca se llamó a `setAccessToken` (token ausente → `initMapbox` lo saltea). Sin
  // `MAPBOX_ACCESS_TOKEN` degradamos a un lienzo CLARO (el `bg` del tema, = canvas del estilo veo-light) en
  // vez de montar el mapa: los overlays del `MapShell` siguen funcionando y la app NO se cierra (degradación
  // honesta). Va DESPUÉS de los hooks (rules-of-hooks). Con token configurado, el mapa real se monta normal.
  if (!env.MAPBOX_ACCESS_TOKEN) {
    return <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.bg }]} />;
  }

  return (
    <MapView
      style={StyleSheet.absoluteFill}
      // Variante del estilo por preferencia 2D/3D: alternar recarga el estilo — aceptable, es un
      // gesto deliberado y esporádico del usuario, no un hot-path.
      styleJSON={viewMode === '2d' ? veoLightMapboxStyleJSON2D : veoLightMapboxStyleJSON}
      logoEnabled={false}
      attributionEnabled={false}
      compassEnabled={false}
      scaleBarEnabled={false}
      rotateEnabled={interactive}
      scrollEnabled={interactive}
      zoomEnabled={interactive}
      pitchEnabled={false}
    >
      {navigating ? (
        // NAVEGACIÓN (Waze): cámara siguiendo al conductor, orientada al rumbo (heading-up), inclinada
        // y con zoom de calle. Se re-anima en cada muestra de GPS (centerCoordinate/heading cambian).
        <Camera
          centerCoordinate={centerCoordinate}
          heading={heading ?? 0}
          pitch={viewMode === '2d' ? NAV_PITCH_FLAT : NAV_PITCH}
          zoomLevel={NAV_ZOOM}
          padding={navPadding}
          animationMode="easeTo"
          animationDuration={NAV_ANIM_MS}
        />
      ) : bounds ? (
        <Camera bounds={{ ne: bounds.ne, sw: bounds.sw }} padding={fitPadding} animationDuration={500} />
      ) : (
        <Camera
          centerCoordinate={centerCoordinate}
          zoomLevel={LIMA_ZOOM}
          padding={centerPadding}
          animationDuration={500}
        />
      )}

      {heatShape ? (
        <ShapeSource id={HEAT_SOURCE} shape={heatShape}>
          {/* Una capa de círculos cian; opacidad por feature (intensidad). El radio escala con el
              zoom para que las "zonas" sigan siendo legibles al alejar/acercar el mapa. */}
          <CircleLayer
            id="veo-heat-fill"
            style={{
              circleColor: driverMapRoute.routeColor,
              circleOpacity: ['get', 'opacity'],
              circleBlur: 0.55,
              circleRadius: [
                'interpolate',
                ['linear'],
                ['zoom'],
                10,
                ['*', ['get', 'radiusMeters'], 0.012],
                14,
                ['*', ['get', 'radiusMeters'], 0.08],
                17,
                ['*', ['get', 'radiusMeters'], 0.4],
              ],
            }}
          />
        </ShapeSource>
      ) : null}

      {routeShape ? (
        <ShapeSource id={ROUTE_SOURCE} shape={routeShape}>
          {/* Halo ancho translúcido (glow). */}
          <LineLayer
            id="veo-route-glow"
            style={{
              lineColor: driverMapRoute.routeGlowColor,
              lineWidth: driverMapRoute.routeGlowWidth,
              lineCap: 'round',
              lineJoin: 'round',
            }}
          />
          {/* Línea cian nítida encima. */}
          <LineLayer
            id="veo-route-line"
            style={{
              lineColor: driverMapRoute.routeColor,
              lineWidth: driverMapRoute.routeWidth,
              lineCap: 'round',
              lineJoin: 'round',
            }}
          />
        </ShapeSource>
      ) : null}

      {isValidPoint(smoothedDriver) ? (
        <MarkerView coordinate={toLngLat(smoothedDriver)} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
          {/* En navegación: puck direccional (la cámara heading-up hace que apunte al rumbo de viaje),
              con el glyph del vehículo activo si se conoce. Fuera de navegación: anillo pulsante. */}
          {navigating ? <NavPuck vehicleType={vehicleType} /> : <RoutePin variant="user" pulse />}
        </MarkerView>
      ) : null}

      {isValidPoint(origin) ? (
        <MarkerView coordinate={toLngLat(origin)} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
          <RoutePin variant="origin" />
        </MarkerView>
      ) : null}

      {/* Paradas intermedias (Ola 2B): beads `stop` más chicos, entre origen y destino. */}
      {waypoints?.map((wp, i) =>
        isValidPoint(wp) ? (
          <MarkerView
            key={`wp:${wp.lat}:${wp.lon}:${i}`}
            coordinate={toLngLat(wp)}
            anchor={{ x: 0.5, y: 0.5 }}
            allowOverlap
          >
            <RoutePin variant="stop" size={13} />
          </MarkerView>
        ) : null,
      )}

      {isValidPoint(destination) ? (
        <MarkerView coordinate={toLngLat(destination)} anchor={{ x: 0.5, y: 1 }} allowOverlap>
          <RoutePin variant="destination" />
        </MarkerView>
      ) : null}
    </MapView>
  );
}

/**
 * Memoizado: el mapa solo re-renderiza si sus props cambian de VALOR (shallow). Sin esto, cada
 * re-render del padre (Dashboard refrescando estado/ofertas) re-ejecutaba el componente y, junto con
 * un centro inestable, mantenía al contexto GL en churn → mapa negro. Con memo + centro estable, el
 * GL se asienta y el mapa renderiza.
 */
export const AppMap = React.memo(AppMapComponent);
