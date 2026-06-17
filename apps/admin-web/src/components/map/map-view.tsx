'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Map as MaplibreMap,
  Marker as MaplibreMarker,
  NavigationControl,
  type LngLatLike,
  type StyleSpecification,
} from 'maplibre-gl';
import { MapPinOff } from 'lucide-react';
import { MAP_DEFAULTS, TILE_URL } from '@/lib/config';
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

export interface MapViewProps {
  markers: MapMarker[];
  center?: { lon: number; lat: number };
  zoom?: number;
  className?: string;
  onMarkerClick?: (id: string) => void;
}

const MARKER_CLASS: Record<MarkerKind, string> = {
  driver: 'bg-accent text-accent-on',
  trip: 'bg-brand text-on-brand',
  panic: 'bg-danger text-danger-on ring-2 ring-danger animate-pulse-danger',
};

/**
 * Estilo soberano mínimo (sin tiles de terceros) cuando el tileserver propio no responde.
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
        paint: { 'background-color': '#1b2233' },
      },
    ],
  };
}

function createMarkerElement(marker: MapMarker): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.setAttribute('aria-label', marker.label ?? marker.kind);
  el.className = cn(
    'grid size-6 place-items-center rounded-full border border-surface shadow-2 transition-transform',
    'hover:scale-110 cursor-pointer',
    MARKER_CLASS[marker.kind],
  );
  el.innerHTML =
    marker.kind === 'panic'
      ? '<span style="font-size:12px;font-weight:700">!</span>'
      : '<span style="width:8px;height:8px;border-radius:9999px;background:currentColor;display:block"></span>';
  return el;
}

/** Mapa MapLibre reutilizable con tiles OSM self-hosted y fallback soberano. */
export function MapView({ markers, center, zoom, className, onMarkerClick }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const markersRef = useRef<Map<string, MaplibreMarker>>(new Map());
  const degradedRef = useRef(!TILE_URL);
  const [degraded, setDegraded] = useState(!TILE_URL);

  // Inicialización del mapa (una sola vez).
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const initialCenter: LngLatLike = [
      center?.lon ?? MAP_DEFAULTS.lon,
      center?.lat ?? MAP_DEFAULTS.lat,
    ];
    const map = new MaplibreMap({
      container: containerRef.current,
      style: TILE_URL ? TILE_URL : fallbackStyle(),
      center: initialCenter,
      zoom: zoom ?? MAP_DEFAULTS.zoom,
      attributionControl: { compact: true },
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');

    // Si el estilo/tiles propios fallan, degradar al estilo mínimo (nunca a terceros).
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
    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
  }, [center?.lat, center?.lon, zoom]);

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
        const marker = new MaplibreMarker({ element: el }).setLngLat([m.lon, m.lat]).addTo(map);
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

  return (
    <div className={cn('relative h-full w-full overflow-hidden', className)}>
      <div ref={containerRef} className="h-full w-full" />
      {degraded ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center p-3">
          <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-warn/30 bg-warn/15 px-3 py-1.5 text-xs font-medium text-warn shadow-1">
            <MapPinOff className="size-3.5" aria-hidden />
            Tileserver propio no disponible; mostrando mapa base mínimo.
          </div>
        </div>
      ) : null}
    </div>
  );
}
