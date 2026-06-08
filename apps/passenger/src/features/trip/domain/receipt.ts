import type { TripActiveView, TripResource } from '@veo/api-client';
import {
  formatDistance,
  formatDurationMinutes,
  formatDateTime,
  formatPEN,
} from '../../../shared/utils/format';

/**
 * Recibo de un viaje COMPLETADO: modelo de vista PURO (sin React) derivado de los datos REALES que
 * ya devuelve el viaje (`TripActiveView` fresco del bff) y el snapshot local (`TripResource`, para
 * origen/destino/fecha/surge que el view no trae). Nada se inventa: los campos ausentes se omiten.
 *
 * `fareCents` del view es el TOTAL del viaje (lo que paga el pasajero); la propina (`tipCents`) va
 * 100% al conductor y se suma aparte en el desglose. La tarifa base se deriva como total − propina.
 */
export interface TripReceipt {
  baseFareCents: number;
  tipCents: number;
  totalCents: number;
  /** Multiplicador de surge (>1 si hubo demanda alta), si el snapshot lo conoce. */
  surgeMultiplier?: number;
  paymentMethod: string;
  /** Fecha legible del viaje (ISO → es-PE), si se conoce. */
  date?: string;
  distanceMeters: number;
  durationSeconds: number;
  driverLabel?: string;
  vehicleLabel?: string;
  originLabel?: string;
  destinationLabel?: string;
}

/** Etiqueta legible de un punto geográfico (lat, lon) con 5 decimales. */
function pointLabel(point: { lat: number; lon: number } | null | undefined): string | undefined {
  if (!point) {
    return undefined;
  }
  return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}

/**
 * Construye el recibo a partir del view fresco del viaje y, opcionalmente, el snapshot local.
 * Pura y determinista (testeable). El total es `fareCents`; la base es total − propina.
 */
export function buildReceipt(
  trip: TripActiveView,
  snapshot?: TripResource | null,
): TripReceipt {
  const tipCents = Math.max(0, Math.trunc(trip.tipCents));
  const totalCents = Math.max(0, Math.trunc(trip.fareCents));
  const baseFareCents = Math.max(0, totalCents - tipCents);

  const driverLabel = trip.driver
    ? trip.driver.rating != null
      ? `${trip.driver.rating.toFixed(1)} ★`
      : undefined
    : undefined;

  const vehicleLabel = trip.vehicle
    ? `${trip.vehicle.make} ${trip.vehicle.model} · ${trip.vehicle.plate}`
    : undefined;

  const surgeMultiplier =
    snapshot && snapshot.surgeMultiplier > 1 ? snapshot.surgeMultiplier : undefined;

  return {
    baseFareCents,
    tipCents,
    totalCents,
    ...(surgeMultiplier ? { surgeMultiplier } : {}),
    paymentMethod: trip.paymentMethod,
    ...(snapshot ? { date: formatDateTime(snapshot.completedAt ?? snapshot.requestedAt) } : {}),
    distanceMeters: trip.distanceMeters,
    durationSeconds: trip.durationSeconds,
    ...(driverLabel ? { driverLabel } : {}),
    ...(vehicleLabel ? { vehicleLabel } : {}),
    ...(pointLabel(snapshot?.origin) ? { originLabel: pointLabel(snapshot?.origin) } : {}),
    ...(pointLabel(snapshot?.destination)
      ? { destinationLabel: pointLabel(snapshot?.destination) }
      : {}),
  };
}

/** Etiquetas localizables que la capa de presentación pasa al formateador de texto. */
export interface ReceiptShareLabels {
  title: string;
  baseFare: string;
  surge: (multiplier: number) => string;
  tip: string;
  total: string;
  paymentMethod: string;
  date: string;
  driver: string;
  vehicle: string;
  route: string;
  distance: string;
  duration: string;
  durationMinutes: (minutes: number) => string;
}

/**
 * Texto limpio del recibo para `Share.share` (RN nativo). Pura: la presentación inyecta las
 * etiquetas i18n. Omite con gracia las líneas sin dato (no muestra "undefined").
 */
export function formatReceiptText(receipt: TripReceipt, labels: ReceiptShareLabels): string {
  const lines: string[] = [`🧾 ${labels.title}`, ''];

  if (receipt.date) {
    lines.push(`${labels.date}: ${receipt.date}`);
  }
  if (receipt.driverLabel) {
    lines.push(`${labels.driver}: ${receipt.driverLabel}`);
  }
  if (receipt.vehicleLabel) {
    lines.push(`${labels.vehicle}: ${receipt.vehicleLabel}`);
  }
  if (receipt.originLabel && receipt.destinationLabel) {
    lines.push(`${labels.route}: ${receipt.originLabel} → ${receipt.destinationLabel}`);
  }

  lines.push('');
  lines.push(`${labels.baseFare}: ${formatPEN(receipt.baseFareCents)}`);
  if (receipt.surgeMultiplier) {
    lines.push(labels.surge(receipt.surgeMultiplier));
  }
  if (receipt.tipCents > 0) {
    lines.push(`${labels.tip}: ${formatPEN(receipt.tipCents)}`);
  }
  lines.push(`${labels.total}: ${formatPEN(receipt.totalCents)}`);
  lines.push(`${labels.paymentMethod}: ${receipt.paymentMethod}`);

  lines.push('');
  lines.push(`${labels.distance}: ${formatDistance(receipt.distanceMeters)}`);
  lines.push(
    `${labels.duration}: ${labels.durationMinutes(formatDurationMinutes(receipt.durationSeconds))}`,
  );

  return lines.join('\n');
}
