import type { TripStatus } from '@veo/api-client';

/** Tono visual asociado a cada estado del viaje (para badges y acentos). */
export type StatusTone = 'neutral' | 'progress' | 'arrived' | 'done' | 'cancelled';

interface StatusPresentation {
  label: string;
  tone: StatusTone;
}

/** Etiqueta humana y tono para cada estado del viaje (copy tranquilizador, sin jerga). */
export function describeStatus(status: TripStatus): StatusPresentation {
  switch (status) {
    case 'REQUESTED':
    case 'MATCHING':
      return { label: 'Buscando conductor', tone: 'neutral' };
    case 'ASSIGNED':
      return { label: 'Conductor asignado', tone: 'progress' };
    case 'ACCEPTED':
      return { label: 'En camino', tone: 'progress' };
    case 'ARRIVING':
      return { label: 'Está llegando', tone: 'progress' };
    case 'ARRIVED':
      return { label: 'Llegó al punto de encuentro', tone: 'arrived' };
    case 'IN_PROGRESS':
      return { label: 'En viaje', tone: 'progress' };
    case 'COMPLETED':
      return { label: 'Viaje finalizado', tone: 'done' };
    case 'CANCELLED':
      return { label: 'Viaje cancelado', tone: 'cancelled' };
    default:
      return { label: 'Estado desconocido', tone: 'neutral' };
  }
}

/** Frase natural en español para la ETA. Null = aún calculando. */
export function describeEta(etaSeconds: number | null): string {
  if (etaSeconds === null || etaSeconds < 0) return 'Calculando tiempo de llegada';
  if (etaSeconds < 60) return 'Llega en menos de un minuto';
  const minutes = Math.round(etaSeconds / 60);
  if (minutes === 1) return 'Llega en un minuto';
  if (minutes < 60) return `Llega en unos ${minutes} minutos`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return hours === 1 ? 'Llega en una hora' : `Llega en unas ${hours} horas`;
  return `Llega en ${hours} h ${rest} min`;
}

/** Versión compacta de la ETA para mostrar sobre el mapa. */
export function formatEtaShort(etaSeconds: number | null): string | null {
  if (etaSeconds === null || etaSeconds < 0) return null;
  if (etaSeconds < 60) return '<1 min';
  const minutes = Math.round(etaSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Formatea el rating del conductor con una cifra decimal. */
export function formatRating(rating: number | null): string | null {
  if (rating === null || Number.isNaN(rating)) return null;
  return rating.toFixed(1);
}

/** Hora local legible (HH:MM) a partir de un ISO-8601. */
export function formatLocalTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('es-PE', { hour: '2-digit', minute: '2-digit' }).format(date);
}
