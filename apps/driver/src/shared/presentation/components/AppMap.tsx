import type { GeoPoint } from '@veo/api-client';
import { Camera, CircleLayer, LineLayer, MapView, MarkerView, ShapeSource } from '@rnmapbox/maps';
import { driverMapRoute, RoutePin } from '@veo/ui-kit';
import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { boundsOf, LIMA_CENTER_LNGLAT, LIMA_ZOOM, toLngLat } from '../../utils/geo';
import { veoDarkMapboxStyleJSON } from './mapbox/veoDarkStyle';
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
/** Zoom de navegación (calle/maniobra). */
const NAV_ZOOM = 17;
/** Duración de la transición de seguimiento entre muestras de GPS (ms). */
const NAV_ANIM_MS = 700;

const isValidPoint = (p: GeoPoint | null | undefined): p is GeoPoint =>
  p != null && Number.isFinite(p.lat) && Number.isFinite(p.lon);

/**
 * Lienzo de mapa del conductor sobre **`@rnmapbox/maps`** (Lote 0+1: migración a Mapbox). El estilo
 * veo-dark "Midnight Motion" se inyecta vía `styleJSON` (Mapbox Streets v8, paleta idéntica al
 * tileserver propio anterior). Centraliza el encuadre, los markers de conductor/recojo/destino, la
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
  interactive = true,
}: AppMapProps): React.JSX.Element {
  // Navegación activa SOLO si se pidió `navMode` Y hay una ubicación de conductor válida que seguir
  // (sin ubicación no hay a quién seguir → degrada al encuadre normal, degradación honesta).
  const navigating = navMode && isValidPoint(driver);
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

  return (
    <MapView
      style={StyleSheet.absoluteFill}
      styleJSON={veoDarkMapboxStyleJSON}
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
          pitch={NAV_PITCH}
          zoomLevel={NAV_ZOOM}
          animationMode="easeTo"
          animationDuration={NAV_ANIM_MS}
        />
      ) : bounds ? (
        <Camera
          bounds={{ ne: bounds.ne, sw: bounds.sw }}
          padding={{
            paddingLeft: FIT_PADDING,
            paddingRight: FIT_PADDING,
            paddingTop: FIT_PADDING,
            paddingBottom: FIT_PADDING,
          }}
          animationDuration={500}
        />
      ) : (
        <Camera centerCoordinate={centerCoordinate} zoomLevel={LIMA_ZOOM} animationDuration={500} />
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

      {isValidPoint(driver) ? (
        <MarkerView coordinate={toLngLat(driver)} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
          {/* En navegación: puck direccional (la cámara heading-up hace que apunte al rumbo de viaje).
              Fuera de navegación: anillo pulsante de presencia. */}
          {navigating ? <NavPuck /> : <RoutePin variant="user" pulse />}
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
