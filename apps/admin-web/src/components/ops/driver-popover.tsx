'use client';

import Link from 'next/link';
import { Phone, User, X } from 'lucide-react';
import { useDriverDetail } from '@/lib/api/queries';

/**
 * Card flotante del conductor al tocar su marker en el mapa En Vivo (fiel en FORMA al frame bjRvY).
 *
 * HONESTO por seam: el marker vivo solo trae `driverId` (dispatch) y `useDriverDetail` es la vista de
 * identidad/KYC → hay nombre, teléfono y perfil REALES. NO hay vehículo, calificación, "viaje actual" ni
 * tripId para la cámara en vivo en estos seams (requiere enriquecer el payload de live-ops: driver↔vehículo↔
 * viaje-en-curso). No se inventan esos campos: se muestran las acciones que SÍ funcionan (Perfil, Llamar).
 */
export function DriverPopover({ driverId, onClose }: { driverId: string; onClose: () => void }) {
  const query = useDriverDetail(driverId);
  const d = query.data;
  const name = d?.fullName ?? null;
  const phone = d?.phone ?? null;

  return (
    <div className="absolute right-4 top-4 z-10 w-[340px] rounded-[18px] border border-black/[0.05] bg-surface p-[22px] shadow-2xl">
      <div className="flex items-start gap-3">
        <span className="grid size-[46px] shrink-0 place-items-center rounded-full bg-accent/10 text-[15px] font-bold text-accent">
          {initials(name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-base font-bold text-ink">
            {name ?? <span className="font-mono text-sm text-ink-muted">{driverId.slice(0, 8)}</span>}
          </p>
          <p className="text-[13px] text-ink-muted">Conductor</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          className="grid size-7 shrink-0 place-items-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {query.isLoading ? (
        <p className="mt-4 text-[13px] text-ink-subtle">Cargando conductor…</p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <Link
            href={`/ops/drivers/${driverId}`}
            className="flex items-center justify-center gap-2 rounded-[11px] border border-border bg-surface px-3 py-2.5 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2"
          >
            <User className="size-[15px] text-ink-muted" aria-hidden />
            Perfil
          </Link>
          {phone ? (
            <a
              href={`tel:${phone}`}
              className="flex items-center justify-center gap-2 rounded-[11px] border border-border bg-surface px-3 py-2.5 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2"
            >
              <Phone className="size-[15px] text-ink-muted" aria-hidden />
              Llamar
            </a>
          ) : (
            <span
              className="flex cursor-not-allowed items-center justify-center gap-2 rounded-[11px] border border-border bg-surface px-3 py-2.5 text-[13px] font-semibold text-ink-subtle"
              title="Sin teléfono registrado"
            >
              <Phone className="size-[15px]" aria-hidden />
              Llamar
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function initials(name: string | null): string {
  if (!name) return '•';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '•';
}
