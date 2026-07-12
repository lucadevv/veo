'use client';

import { forwardRef, useEffect, useState } from 'react';
import { Video } from 'lucide-react';
import type { LiveCabin } from '@/lib/api/schemas';

/** Tiempo transcurrido HH:MM:SS desde un ISO-8601; "00:00:00" si la fecha es inválida (degradación honesta). */
function elapsedSince(iso: string): string {
  const start = new Date(iso).getTime();
  if (Number.isNaN(start)) return '00:00:00';
  const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Sub-línea del tile: "placa · distrito" con lo que haya; cae al id del viaje si no hay ninguno (honesto). */
function subLine(cabin: LiveCabin): string {
  const parts = [cabin.plate, cabin.district].filter((x): x is string => !!x);
  return parts.length > 0 ? parts.join(' · ') : `Viaje ${cabin.tripId.slice(0, 8)}`;
}

/**
 * Tile del muro de cámaras EN VIVO (fiel al frame T/CameraTile): superficie oscura tipo feed con badge "EN
 * VIVO", reloj en curso, ícono de cámara (placeholder — el feed NO se muestra hasta la doble-auth) y barra
 * inferior con conductor / placa·distrito / estado. Es un `<button>`: TODO el tile abre el diálogo de acceso
 * (doble-auth) — se pasa como `trigger` de `LiveAccessDialog` (DialogTrigger asChild). La superficie oscura es
 * intrínseca al diseño del "feed" (no un surface temático) → colores exactos del frame, iguales en claro/oscuro.
 */
export const CameraTile = forwardRef<HTMLButtonElement, { cabin: LiveCabin } & React.ComponentProps<'button'>>(
  function CameraTile({ cabin, ...props }, ref) {
    const [clock, setClock] = useState(() => elapsedSince(cabin.startedAt));
    useEffect(() => {
      setClock(elapsedSince(cabin.startedAt));
      const t = setInterval(() => setClock(elapsedSince(cabin.startedAt)), 1000);
      return () => clearInterval(t);
    }, [cabin.startedAt]);

    const driver = cabin.driverName ?? 'Conductor sin asignar';

    return (
      <button
        ref={ref}
        type="button"
        aria-label={`Abrir cámara del viaje de ${driver}`}
        className="group relative block aspect-[269/176] w-full overflow-hidden rounded-[14px] bg-gradient-to-b from-[#20304A] to-[#0A0B0F] text-left outline-none transition-[transform,box-shadow] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg hover:shadow-lg active:scale-[0.99]"
        {...props}
      >
        {/* Scanlines del feed (y40/80/120/160 sobre 176 → ~23/45/68/91%) */}
        {[22.7, 45.5, 68.2, 90.9].map((top) => (
          <span
            key={top}
            aria-hidden
            className="absolute inset-x-0 h-px bg-white/[0.04]"
            style={{ top: `${top}%` }}
          />
        ))}

        {/* Ícono de cámara (placeholder — sin feed hasta la doble-auth) */}
        <Video
          className="absolute left-1/2 top-1/2 size-11 -translate-x-1/2 -translate-y-1/2 text-white/10"
          aria-hidden
        />

        {/* Badge EN VIVO */}
        <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-[5px] rounded-md bg-[#D11216]/90 px-[9px] py-1">
          <span className="size-1.5 rounded-full bg-white" aria-hidden />
          <span className="text-[10px] font-bold leading-none text-white">EN VIVO</span>
        </span>

        {/* Reloj del viaje (tiempo en curso) */}
        <span className="absolute right-3 top-3 font-mono text-[11px] tabular-nums text-white/70">
          {clock}
        </span>

        {/* Barra inferior: conductor / placa·distrito / estado */}
        <span className="absolute inset-x-0 bottom-0 flex h-[46px] items-center justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent px-3">
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-semibold leading-tight text-white">{driver}</span>
            <span className="truncate font-mono text-[11px] text-white/70">{subLine(cabin)}</span>
          </span>
          <span className="shrink-0 rounded-full bg-[#00C853]/80 px-2 py-[3px] text-[10px] font-semibold leading-none text-white">
            En viaje
          </span>
        </span>
      </button>
    );
  },
);
