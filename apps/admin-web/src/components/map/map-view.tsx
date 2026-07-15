'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Map as MaplibreMap,
  Marker as MaplibreMarker,
  NavigationControl,
  FullscreenControl,
  type GeoJSONSource,
  type LngLatLike,
  type RequestParameters,
  type RequestTransformFunction,
  type StyleSpecification,
} from 'maplibre-gl';
import { MapPinOff } from 'lucide-react';
import { MAP_DEFAULTS, MAPBOX_TOKEN } from '@/lib/config';
import { veoLightMapboxStyle } from '@/lib/map/veo-map-style';
import { cn } from '@/lib/cn';

export type MarkerKind = 'driver' | 'trip' | 'panic';

export interface MapMarker {
  id: string;
  lon: number;
  lat: number;
  kind: MarkerKind;
  label?: string;
  heading?: number | null;
}

/** Anillo de radio (km) a dibujar geo-exacto alrededor del centro — para el radar de Radios de dispatch. */
export interface RadiusCircle {
  radiusKm: number;
}

export interface MapViewProps {
  markers: MapMarker[];
  center?: { lon: number; lat: number };
  zoom?: number;
  className?: string;
  onMarkerClick?: (id: string) => void;
  /** Anillos concéntricos (km) dibujados alrededor del CENTRO VIVO del mapa (siguen el pan → radar centrado). */
  circles?: RadiusCircle[];
  /** Ruta a dibujar como línea (secuencia de puntos lon/lat). Ej: el trayecto del viaje hasta el punto de pánico. */
  route?: { lon: number; lat: number }[];
  /** Color de la línea de ruta. HEX literal (maplibre no parsea oklch). Default: danger (trayecto de pánico). */
  routeColor?: string;
  /** Deshabilita la interacción (zoom/drag) — para el radar de preview (mapa estático). */
  interactive?: boolean;
  /** Se dispara al terminar de mover/zoomear el mapa, con el nuevo centro (para re-consultar la densidad). */
  onMoveEnd?: (center: { lat: number; lon: number }) => void;
}

/** Polígono (64 lados) que aproxima un círculo de `radiusKm` alrededor de `center` (equirectangular, ok a escala urbana). */
function circleRing(center: { lon: number; lat: number }, radiusKm: number): [number, number][] {
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * 2 * Math.PI;
    pts.push([center.lon + dLon * Math.cos(t), center.lat + dLat * Math.sin(t)]);
  }
  return pts;
}

/** Color del pin por tipo (vía CSS var del theme trust): conductor azul, viaje verde, pánico rojo. */
const PIN_VAR: Record<MarkerKind, string> = {
  driver: 'var(--accent)',
  trip: 'var(--success)',
  panic: 'var(--danger)',
};

/**
 * Estilo soberano mínimo (fondo sólido, sin red) para cuando falta el token Mapbox o el estilo falla.
 * Color HEX literal a propósito: los tokens del tema son `oklch()`, que maplibre-gl NO parsea
 * (`paint.background-color: color expected`) — pasarle el CSS var resuelto disparaba un error que el
 * handler `map.on('error')` re-degradaba en BUCLE (miles de errores). Y SIN `glyphs` (un fondo sólido no
 * tiene texto; `glyphs:''` era una URL inválida que sumaba más errores al loop). Estilo 100% estático y válido.
 */
function fallbackStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#F5F7FA' },
      },
    ],
  };
}

const MAPBOX_FONTS_PREFIX = 'mapbox://fonts/';
const MAPBOX_SCHEME = 'mapbox://';

/**
 * Reescribe URLs `mapbox://…` a HTTPS + token. maplibre-gl 4.x ELIMINÓ el soporte de URLs `mapbox://`
 * (era exclusivo de mapbox-gl), así que el estilo veo-dark — que las usa para el tileset Streets v8 y
 * los glyphs — necesita esta traducción. Es el enfoque oficial documentado por maplibre.
 *
 *   1. glyphs   `mapbox://fonts/mapbox/{stack}/{range}.pbf`
 *               → `https://api.mapbox.com/fonts/v1/mapbox/{stack}/{range}.pbf?access_token=…`
 *   2. tileset  `mapbox://mapbox.mapbox-streets-v8`
 *               → `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8.json?secure&access_token=…` (TileJSON)
 *   3. tiles    el TileJSON devuelve URLs de tiles SIN token → se les añade `access_token` aquí.
 *
 * Tipada con `RequestTransformFunction` de maplibre-gl 4.7.1: `(url, resourceType?) => RequestParameters | undefined`.
 */
const transformRequest: RequestTransformFunction = (url): RequestParameters => {
  if (url.startsWith(MAPBOX_FONTS_PREFIX)) {
    return {
      url: `https://api.mapbox.com/fonts/v1/${url.slice(MAPBOX_FONTS_PREFIX.length)}?access_token=${MAPBOX_TOKEN}`,
    };
  }
  if (/^mapbox:\/\/[^/]+$/.test(url)) {
    return {
      url: `https://api.mapbox.com/v4/${url.slice(MAPBOX_SCHEME.length)}.json?secure&access_token=${MAPBOX_TOKEN}`,
    };
  }
  if (
    (url.includes('api.mapbox.com') || url.includes('tiles.mapbox.com')) &&
    !url.includes('access_token=')
  ) {
    return {
      url: `${url}${url.includes('?') ? '&' : '?'}access_token=${MAPBOX_TOKEN}`,
    };
  }
  return { url };
};

/** Teardrop del pin (viewBox 0 0 48 58, cabeza r≈20 en (24,20), punta en (24,58)) — verbatim del board. */
const PIN_PATH =
  'M24 58C24 58 44 34 44 20C44 8.95 35.05 0 24 0C12.95 0 4 8.95 4 20C4 34 24 58 24 58Z';

/**
 * Ícono DENTRO del círculo blanco de la cabeza, COLOREADO igual que el pin (fiel al board `T/MapMarker`/`Pax`):
 * carro (conductor), persona (pasajero/viaje), punto (pánico — no existe en el board, derivado en danger).
 * Paths de lucide (car/user) escalados a ~14u y centrados en (24,20).
 */
const PIN_GLYPH: Record<MarkerKind, string> = {
  driver:
    '<g transform="translate(17,13) scale(0.583)" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/>' +
    '<circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></g>',
  trip:
    '<g transform="translate(17.5,13) scale(0.56)" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></g>',
  panic: '<circle cx="24" cy="20" r="5" />',
};

/**
 * Marcador tipo PIN fiel al veo.pen (`T/MapMarker`/`T/MapMarkerPax`): teardrop COLOREADO (sin borde) + círculo
 * BLANCO en la cabeza + ÍCONO coloreado (carro/persona) adentro. viewBox 48×58, anclado en `bottom` → la punta
 * cae exacto sobre la coordenada. Sombra `0 6px 14px -3px #00000059`.
 *
 * CLAVE (bug de "drift"/animación al panear): maplibre posiciona el marcador con `transform: translate(...)`
 * en CADA frame del pan. Si el elemento posicionado tiene transición, el browser ANIMA cada translate → el pin
 * se desliza en vez de quedarse fijo. Por eso el `el` externo NO lleva transición; el hover-scale vive en un
 * `<span>` INTERNO (su transform es independiente del que aplica maplibre).
 */
function createMarkerElement(marker: MapMarker): HTMLElement {
  const color = PIN_VAR[marker.kind];
  const el = document.createElement('button');
  el.type = 'button';
  el.setAttribute('aria-label', marker.label ?? marker.kind);
  el.className = cn('block cursor-pointer', marker.kind === 'panic' && 'animate-pulse-danger');
  // El glyph hereda el color del pin: stroke+fill = currentColor vía el `color` del <g> raíz.
  el.innerHTML =
    `<span class="block transition-transform hover:scale-110" style="transform-origin:50% 100%">` +
    `<svg width="30" height="36" viewBox="0 0 48 58" style="display:block;filter:drop-shadow(0 6px 14px rgba(0,0,0,0.35))">` +
    `<path d="${PIN_PATH}" style="fill:${color}"/>` +
    `<circle cx="24" cy="20" r="12" fill="#ffffff"/>` +
    `<g style="stroke:${color};fill:${color}">${PIN_GLYPH[marker.kind]}</g></svg></span>`;
  return el;
}

/** Mapa MapLibre con estilo veo-dark (Mapbox Streets v8) y fallback soberano si no hay token. */
export function MapView({
  markers,
  center,
  zoom,
  className,
  onMarkerClick,
  circles,
  route,
  routeColor,
  interactive,
  onMoveEnd,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const markersRef = useRef<Map<string, MaplibreMarker>>(new Map());
  const degradedRef = useRef(!MAPBOX_TOKEN);
  const [degraded, setDegraded] = useState(!MAPBOX_TOKEN);

  // Inicialización del mapa (una sola vez).
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const initialCenter: LngLatLike = [
      center?.lon ?? MAP_DEFAULTS.lon,
      center?.lat ?? MAP_DEFAULTS.lat,
    ];
    const map = new MaplibreMap({
      container: containerRef.current,
      // Con token → estilo veo-light "Daylight Trust" (Mapbox Streets v8, paleta clara del panel). Sin
      // token → fallback soberano claro. El objeto del estilo es un Style spec v8 válido (tipado laxo).
      style: MAPBOX_TOKEN ? (veoLightMapboxStyle as unknown as StyleSpecification) : fallbackStyle(),
      // maplibre 4.x dropeó `mapbox://`; reescribimos tileset + glyphs a HTTPS + token público.
      transformRequest: MAPBOX_TOKEN ? transformRequest : undefined,
      center: initialCenter,
      zoom: zoom ?? MAP_DEFAULTS.zoom,
      // Sin control de atribución: el "© Mapbox © OpenStreetMap Improve this map" es ruido visual en el panel
      // admin interno. (Si el mapa fuera público, la atribución de Mapbox/OSM es legalmente requerida y habría
      // que reponerla.)
      attributionControl: false,
      interactive: interactive ?? true,
    });
    if (interactive ?? true) {
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
      // Pantalla completa (nativo maplibre) en TODOS los mapas (radar, En Vivo, detalle de viaje).
      map.addControl(new FullscreenControl(), 'top-right');
    }

    // Si el estilo/tiles de Mapbox fallan (token inválido, red caída), degradar al estilo mínimo.
    map.on('error', (e) => {
      // Guard anti-BUCLE: degradar UNA sola vez. Sin esto, si el fallback disparara cualquier error, el
      // handler lo re-aplicaría sin fin (era la causa de los miles de errores). Usamos el REF, no el state,
      // para no leer un valor viejo en el closure del listener.
      if (degradedRef.current) return;
      const failed = e.error instanceof Error;
      if (failed) {
        degradedRef.current = true;
        setDegraded(true);
        try {
          map.setStyle(fallbackStyle());
        } catch {
          // El estilo de respaldo es estático; ignorar fallos secundarios.
        }
      }
    });

    mapRef.current = map;

    // El canvas de MapLibre NO se re-dimensiona solo cuando el contenedor cambia de tamaño (p.ej. el panel
    // de detalle se reacomoda al cargar datos async, o un flex/grid re-fluye): sin esto el mapa queda como una
    // franja fina con la altura vieja. El ResizeObserver fuerza map.resize() para que llene siempre su caja.
    const ro = new ResizeObserver(() => map.resize());
    if (containerRef.current) ro.observe(containerRef.current);
    // Fix del drawing-buffer chico: si el mapa inicializó antes de que el contenedor tuviera su altura final
    // (montado dentro de un panel async / flex que re-fluye), el buffer WebGL queda pequeño y el mapa se ve
    // como una franja. Un resize en el primer frame y al cargar el estilo lo ajusta a la caja real.
    requestAnimationFrame(() => mapRef.current?.resize());
    map.once('load', () => map.resize());

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
    // Init UNA sola vez: los cambios de center/zoom los aplica el effect de sync de abajo (sin re-crear el
    // mapa → sin flash de tiles ni re-init en cada drag del slider de radio). center/zoom se leen al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sincroniza SOLO el center sin re-inicializar (llegada tardía del center en En Vivo · reset programático).
  // El zoom NO se fuerza tras el init: así el usuario puede zoomear libre (en el radar) y el mapa no le
  // revierte el gesto. El zoom inicial se aplica al montar (init). Nota: setCenter al mismo punto es no-op,
  // así que el `onMoveEnd` → setCenter(centro-actual) NO genera loop ni salto.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center) return;
    map.setCenter([center.lon, center.lat]);
  }, [center?.lat, center?.lon]);

  // Sincroniza marcadores con las props.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const active = new Set<string>();

    for (const m of markers) {
      active.add(m.id);
      const existing = markersRef.current.get(m.id);
      if (existing) {
        existing.setLngLat([m.lon, m.lat]);
      } else {
        const el = createMarkerElement(m);
        if (onMarkerClick) {
          el.addEventListener('click', () => onMarkerClick(m.id));
        }
        const marker = new MaplibreMarker({ element: el, anchor: 'bottom' })
          .setLngLat([m.lon, m.lat])
          .addTo(map);
        markersRef.current.set(m.id, marker);
      }
    }

    // Elimina marcadores que ya no están.
    for (const [id, marker] of markersRef.current) {
      if (!active.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    }
  }, [markers, onMarkerClick]);

  // Ruta del viaje como línea GeoJSON (ej: trayecto origen → punto de pánico). Se instala al cargar el estilo
  // y se actualiza vía setData cuando cambia `route`. [] = sin línea. Color de peligro (pánico).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const lineData = () => ({
      type: 'FeatureCollection' as const,
      features:
        route && route.length >= 2
          ? [
              {
                type: 'Feature' as const,
                properties: {},
                geometry: {
                  type: 'LineString' as const,
                  coordinates: route.map((p) => [p.lon, p.lat]),
                },
              },
            ]
          : [],
    });
    const color = routeColor ?? '#E5484D';
    const install = () => {
      const src = map.getSource('trip-route') as GeoJSONSource | undefined;
      if (src) {
        src.setData(lineData());
        map.setPaintProperty('trip-route-line', 'line-color', color);
      } else {
        map.addSource('trip-route', { type: 'geojson', data: lineData() });
        map.addLayer({
          id: 'trip-route-line',
          type: 'line',
          source: 'trip-route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': color, 'line-width': 3.5, 'line-opacity': 0.85 },
        });
      }
    };
    if (map.isStyleLoaded()) install();
    else map.once('load', install);
  }, [route, routeColor]);

  // Anillos de radio como capas GeoJSON alrededor del CENTRO VIVO del mapa → quedan CENTRADOS en pantalla
  // mientras las calles se mueven debajo (comportamiento de radar). Al terminar de mover, `onMoveEnd` re-consulta
  // la densidad de ESE centro nuevo. HEX literal (oklch no lo parsea maplibre).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !circles) return;
    const ringData = () => {
      const c = map.getCenter();
      return {
        type: 'FeatureCollection' as const,
        features: circles.map((circle) => ({
          type: 'Feature' as const,
          properties: {},
          geometry: {
            type: 'Polygon' as const,
            coordinates: [circleRing({ lon: c.lng, lat: c.lat }, circle.radiusKm)],
          },
        })),
      };
    };
    const redraw = () => {
      const src = map.getSource('radius-rings') as GeoJSONSource | undefined;
      if (src) src.setData(ringData());
    };
    const install = () => {
      if (!map.getSource('radius-rings')) {
        map.addSource('radius-rings', { type: 'geojson', data: ringData() });
        map.addLayer({
          id: 'radius-fill',
          type: 'fill',
          source: 'radius-rings',
          paint: { 'fill-color': '#0075A9', 'fill-opacity': 0.07 },
        });
        map.addLayer({
          id: 'radius-line',
          type: 'line',
          source: 'radius-rings',
          paint: { 'line-color': '#0075A9', 'line-width': 1.5, 'line-opacity': 0.55 },
        });
      } else {
        redraw();
      }
    };
    if (map.isStyleLoaded()) install();
    else map.once('load', install);
    const onMove = () => redraw();
    const onEnd = () => {
      redraw();
      const c = map.getCenter();
      onMoveEnd?.({ lat: c.lat, lon: c.lng });
    };
    map.on('move', onMove);
    map.on('moveend', onEnd);
    return () => {
      map.off('move', onMove);
      map.off('moveend', onEnd);
    };
  }, [circles, onMoveEnd]);

  return (
    <div className={cn('relative h-full w-full overflow-hidden', className)}>
      <div ref={containerRef} className="h-full w-full" />
      {degraded ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center p-3">
          <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-warn/30 bg-warn/15 px-3 py-1.5 text-xs font-medium text-warn shadow-1">
            <MapPinOff className="size-3.5" aria-hidden />
            Mapa base no disponible — los marcadores en vivo siguen actualizándose.
          </div>
        </div>
      ) : null}
    </div>
  );
}
