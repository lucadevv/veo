import type {TripStatus} from '@veo/api-client';
import {StatusPill, type StatusTone} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';

/** Mapea el estado del viaje a un tono del kit (el color nunca es el único indicador: hay texto). */
const STATUS_TONE: Record<TripStatus, StatusTone> = {
  SCHEDULED: 'brand',
  REQUESTED: 'accent',
  MATCHING: 'accent',
  ASSIGNED: 'brand',
  ACCEPTED: 'brand',
  ARRIVING: 'brand',
  ARRIVED: 'safe',
  IN_PROGRESS: 'accent',
  COMPLETED: 'success',
  CANCELLED: 'danger',
  REASSIGNING: 'accent', // el conductor canceló: sigue buscando otro (en vivo)
  EXPIRED: 'warn', // puja sin ofertas: el pasajero puede re-pujar más alto
  FAILED: 'danger', // viaje abandonado cerrado por el watchdog (terminal)
};

/** Estados "en vivo" cuyo punto pulsa (búsqueda / viaje en curso). */
const LIVE_STATUSES: ReadonlySet<TripStatus> = new Set<TripStatus>([
  'REQUESTED',
  'MATCHING',
  'REASSIGNING',
  'IN_PROGRESS',
]);

/** Pastilla de estado del viaje con etiqueta i18n y tono semántico. */
export function TripStatusPill({
  status,
}: {
  status: TripStatus;
}): React.JSX.Element {
  const {t} = useTranslation();
  return (
    <StatusPill
      label={t(`tripStatus.${status}`)}
      tone={STATUS_TONE[status]}
      live={LIVE_STATUSES.has(status)}
      dot
    />
  );
}
