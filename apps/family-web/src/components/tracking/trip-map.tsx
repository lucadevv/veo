'use client';

import { useEffect, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import { MapPinned } from 'lucide-react';
import type { GeoPoint } from '@veo/api-client';
import 'maplibre-gl/dist/maplibre-gl.css';
import { resolveMapStyle } from '@/lib/map-style';
import { decodePolyline } from '@/lib/polyline';
import { publicEnv } from '@/lib/env';

const ROUTE_SOURCE = 'route';
const ROUTE_LAYER = 'route-line';

export interface TripMapProps {
  driverLocation: GeoPoint | null;
  origin: GeoPoint | null;
  destination: GeoPoint | null;
  routePolyline: string | null;
}

interface MarkerRefs {
  driver?: MapLibreMarker;
  origin?: MapLibreMarker;
  destination?: MapLibreMarker;
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Crea el elemento DOM de un marcador (clases literales para que Tailwind las detecte). */
function createMarkerElement(kind: 'driver' | 'origin' | 'destination', label: string): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  el.title = label;
  // Borde CLARO (border-ink) como halo: sobre el tile oscurecido un borde oscuro se fundiría
  // con el fondo; el aro claro separa el marker del mapa y le da peso. Tokens, no hex.
  if (kind === 'driver') {
    el.className = 'relative grid place-items-center';
    el.innerHTML =
      '<span class="absolute inline-flex size-7 animate-ping rounded-full bg-accent/40"></span>' +
      '<span class="relative inline-flex size-4 rounded-full border-2 border-ink bg-accent shadow-2"></span>';
  } else if (kind === 'origin') {
    el.className = 'inline-flex size-3.5 rounded-full border-2 border-ink bg-brand shadow-1';
  } else {
    el.className = 'inline-flex size-4 rounded-full border-[3px] border-brand bg-surface shadow-1';
  }
  return el;
}

export function TripMap({ driverLocation, origin, destination, routePolyline }: TripMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<MarkerRefs>({});
  const readyRef = useRef(false);
  const fittedRef = useRef(false);
  const propsRef = useRef<TripMapProps>({ driverLocation, origin, destination, routePolyline });
  const [unavailable, setUnavailable] = useState(false);

  propsRef.current = { driverLocation, origin, destination, routePolyline };

  // Inicializa el mapa una sola vez.
  useEffect(() => {
    const style = resolveMapStyle(publicEnv.tileUrl);
    if (!style || !containerRef.current) {
      setUnavailable(true);
      return;
    }

    let cancelled = false;
    let map: MapLibreMap | null = null;

    void (async () => {
      const maplibregl = (await import('maplibre-gl')).default;
      if (cancelled || !containerRef.current) return;

      map = new maplibregl.Map({
        container: containerRef.current,
        style,
        center: [-77.0428, -12.0464], // Lima como encuadre inicial neutro hasta tener datos
        zoom: 11,
        attributionControl: { compact: true },
        cooperativeGestures: false,
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      mapRef.current = map;

      map.on('load', () => {
        readyRef.current = true;
        void syncMap();
      });
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      fittedRef.current = false;
      const refs = markersRef.current;
      refs.driver?.remove();
      refs.origin?.remove();
      refs.destination?.remove();
      markersRef.current = {};
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Sincroniza marcadores, ruta y encuadre con los datos actuales.
  useEffect(() => {
    if (readyRef.current) void syncMap();
  }, [driverLocation, origin, destination, routePolyline]);

  async function syncMap() {
    const map = mapRef.current;
    if (!map) return;
    const maplibregl = (await import('maplibre-gl')).default;
    const { driverLocation: driver, origin: from, destination: to, routePolyline: poly } = propsRef.current;

    const upsertMarker = (
      key: keyof MarkerRefs,
      point: GeoPoint | null,
      kind: 'driver' | 'origin' | 'destination',
      label: string,
    ) => {
      const refs = markersRef.current;
      if (!point) {
        refs[key]?.remove();
        refs[key] = undefined;
        return;
      }
      const existing = refs[key];
      if (existing) {
        existing.setLngLat([point.lon, point.lat]);
      } else {
        refs[key] = new maplibregl.Marker({ element: createMarkerElement(kind, label) })
          .setLngLat([point.lon, point.lat])
          .addTo(map);
      }
    };

    upsertMarker('origin', from, 'origin', 'Punto de partida');
    upsertMarker('destination', to, 'destination', 'Destino');
    upsertMarker('driver', driver, 'driver', 'Ubicación del conductor');

    // MapLibre pinta en WebGL y no puede leer variables CSS: resolvemos el token --accent
    // computado (respeta claro/oscuro) en vez de hardcodear un color.
    const accentColor =
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || 'oklch(0.823 0.135 207)';

    const routeCoords = poly ? decodePolyline(poly) : [];
    const existingSource = map.getSource<GeoJSONSource>(ROUTE_SOURCE);
    if (routeCoords.length > 1) {
      const data = {
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'LineString' as const, coordinates: routeCoords },
      };
      if (existingSource) {
        existingSource.setData(data);
      } else {
        map.addSource(ROUTE_SOURCE, { type: 'geojson', data });
        map.addLayer({
          id: ROUTE_LAYER,
          type: 'line',
          source: ROUTE_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': accentColor,
            'line-width': 5,
            'line-opacity': 0.85,
          },
        });
      }
    } else if (existingSource) {
      if (map.getLayer(ROUTE_LAYER)) map.removeLayer(ROUTE_LAYER);
      map.removeSource(ROUTE_SOURCE);
    }

    // Encuadre inicial a toda la geometría disponible (sin animar; respeta reduced-motion).
    if (!fittedRef.current) {
      const points: [number, number][] = [...routeCoords];
      for (const p of [driver, from, to]) {
        if (p) points.push([p.lon, p.lat]);
      }
      if (points.length === 1) {
        map.jumpTo({ center: points[0], zoom: 15 });
        fittedRef.current = true;
      } else if (points.length > 1) {
        const first = points[0];
        const bounds = points.reduce(
          (acc, p) => acc.extend(p),
          new maplibregl.LngLatBounds(first, first),
        );
        map.fitBounds(bounds, { padding: 64, maxZoom: 16, animate: false });
        fittedRef.current = true;
      }
    } else if (driver) {
      // Tras el encuadre inicial, seguimos suavemente al conductor sin reencuadrar todo.
      map.panTo([driver.lon, driver.lat], { animate: !reducedMotion(), duration: 600 });
    }
  }

  if (unavailable) {
    return (
      <div className="grid size-full place-items-center bg-surface-2 p-6 text-center">
        <div className="max-w-xs">
          <MapPinned className="mx-auto size-8 text-ink-subtle" aria-hidden />
          <p className="mt-3 text-base font-medium">Mapa no disponible</p>
          <p className="mt-1 text-sm text-ink-muted">
            El seguimiento del viaje sigue activo. Estamos reconectando el mapa.
          </p>
        </div>
      </div>
    );
  }

  // bg-surface oscuro detrás del canvas: evita el flash blanco de MapLibre mientras inicializa
  // y cargan los tiles, manteniendo coherencia con el lienzo negro de marca.
  return (
    <div
      ref={containerRef}
      className="size-full bg-surface"
      aria-label="Mapa del viaje en vivo"
      role="application"
    />
  );
}
