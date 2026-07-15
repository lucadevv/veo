'use client';

import { useMemo } from 'react';
import { Radar as RadarIcon } from 'lucide-react';
import type { RadarPreview } from '@/lib/api/schemas';
import { MapView, type MapMarker, type RadiusCircle } from '@/components/map/lazy-map';

/** Zoom que hace caber un círculo de `maxRadiusKm` (diámetro) en ~280px del preview (Web Mercator). */
function zoomForRadius(lat: number, maxRadiusKm: number): number {
  const fitPx = 280;
  const metersPerPixel = (2 * Math.max(maxRadiusKm, 0.2) * 1000) / fitPx;
  return Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / metersPerPixel);
}

interface DispatchRadarProps {
  preview: RadarPreview | undefined;
  /** Centro de medición (lat/lon) — el mapa arranca acá antes de que llegue el preview. */
  center: { lat: number; lon: number };
  /** Radio máximo configurado (km) → escala del zoom + anillo externo. */
  maxRadiusKm: number;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  /** Al mover/soltar el mapa: re-escanear la densidad de ESE centro nuevo. */
  onRecenter?: (center: { lat: number; lon: number }) => void;
}

/**
 * Radar EXACTO de cobertura SOBRE EL MAPA REAL (mismo estilo light de En Vivo): mapa base de Lima + anillos
 * geo-exactos de los km configurados (capas GeoJSON) + conductores en su POSICIÓN real (marcadores del hot-index,
 * vía radar-preview) + barrido militar (respeta prefers-reduced-motion). Data-driven: cero valores del ojo.
 * Degradación honesta: sin flota → 0 marcadores + nota; error → reintentar.
 */
export function DispatchRadar({
  preview,
  center,
  maxRadiusKm,
  loading,
  error,
  onRetry,
  onRecenter,
}: DispatchRadarProps) {
  // El mapa arranca en el centro dado; luego el USUARIO lo mueve y el radar re-escanea (no lo re-centramos
  // nosotros al llegar el preview — el centro lo manda el mapa vía onMoveEnd). Zoom fijo por el radio máximo.
  const zoom = useMemo(() => zoomForRadius(center.lat, maxRadiusKm), [center.lat, maxRadiusKm]);

  const markers = useMemo<MapMarker[]>(
    () =>
      (preview?.drivers ?? []).map((d, i) => ({
        id: `radar-drv-${i}`,
        lon: d.lon,
        lat: d.lat,
        kind: 'driver' as const,
      })),
    [preview?.drivers],
  );

  const circles = useMemo<RadiusCircle[]>(
    () =>
      preview && preview.rings.length > 0
        ? preview.rings.map((r) => ({ radiusKm: r.radiusKm }))
        : [{ radiusKm: maxRadiusKm }],
    [preview, maxRadiusKm],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="relative aspect-square w-full overflow-hidden rounded-[14px] border border-border">
        <MapView
          markers={markers}
          center={{ lon: center.lon, lat: center.lat }}
          zoom={zoom}
          circles={circles}
          onMoveEnd={onRecenter}
        />

        {/* Barrido (cono giratorio) fijo al centro de la vista (el reticulado del radar). Solo con motion. */}
        {!loading && !error ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center motion-reduce:hidden">
            <div
              className="size-[130%] rounded-full opacity-60 motion-safe:[animation:veo-radar-sweep_4s_linear_infinite]"
              style={{
                background:
                  'conic-gradient(from 0deg, transparent 0deg, color-mix(in srgb, var(--accent) 24%, transparent) 40deg, transparent 62deg)',
              }}
            />
          </div>
        ) : null}

        {/* Origen = centro de escaneo (fijo en pantalla; el mapa se mueve debajo). */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-[2] -translate-x-1/2 -translate-y-1/2">
          <span className="block size-3.5 rounded-full border-2 border-surface bg-success shadow-2" />
        </div>

        {/* Overlays de estado */}
        {loading ? (
          <div className="absolute inset-0 grid place-items-center bg-bg/50">
            <span className="text-[13px] text-ink-muted">Midiendo cobertura…</span>
          </div>
        ) : error ? (
          <div className="absolute inset-0 grid place-items-center gap-2 bg-bg/70 text-center">
            <p className="text-[13px] font-medium text-ink-muted">No se pudo medir la cobertura</p>
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-[10px] border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink"
              >
                Reintentar
              </button>
            ) : null}
          </div>
        ) : preview && preview.totalInRange === 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <span className="flex items-center gap-1.5 rounded-full bg-surface/90 px-3 py-1 text-xs font-medium text-ink-subtle shadow-1">
              <RadarIcon className="size-3.5" aria-hidden />
              Sin conductores en rango
            </span>
          </div>
        ) : null}
      </div>

      {/* Stats reales debajo */}
      <dl className="flex flex-col gap-0">
        <RadarStat k="Conductores en rango" v={preview ? String(preview.totalInRange) : '—'} accent />
        <RadarStat k="Radio máximo" v={`${maxRadiusKm.toFixed(1)} km`} />
        <RadarStat k="Anillos activos" v={preview ? String(preview.rings.length) : '—'} last />
      </dl>
    </div>
  );
}

function RadarStat({ k, v, accent, last }: { k: string; v: string; accent?: boolean; last?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-2.5 ${last ? '' : 'border-b border-divider'}`}>
      <dt className="text-[13px] text-ink-muted">{k}</dt>
      <dd className={`font-mono text-[13px] font-semibold tabular ${accent ? 'text-accent' : 'text-ink'}`}>
        {v}
      </dd>
    </div>
  );
}
