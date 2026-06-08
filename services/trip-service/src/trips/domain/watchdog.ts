/**
 * Watchdog de estado (sweeper temporal) — reglas de dominio PURAS (sin I/O).
 *
 * Problema: la máquina de estados DEFINE terminales de fallo (EXPIRED/FAILED) pero NADA los conduce.
 * Un viaje estancado en REQUESTED (sin conductor), ASSIGNED/ACCEPTED/ARRIVING/ARRIVED (el conductor
 * no aceptó o nunca recogió) o IN_PROGRESS (app del conductor caída) se queda ahí PARA SIEMPRE.
 *
 * Este módulo decide, dado un estado no-terminal y la antigüedad de su última actividad, a qué
 * terminal de fallo debe llevarse (o ninguno si aún no vence). Es model-agnóstico a propósito: no
 * conoce dispatch ni puja; solo umbrales temporales por familia de estado. La transición real la
 * valida `assertTransition` (que ya permite estos → EXPIRED/FAILED).
 */
import { TripStatus } from '@veo/shared-types';

/** Terminal de fallo al que el watchdog puede llevar un viaje estancado. */
export type StalledTarget = typeof TripStatus.EXPIRED | typeof TripStatus.FAILED;

/** Umbrales del watchdog, en milisegundos (derivados de las env del servicio). */
export interface WatchdogThresholds {
  /** REQUESTED sin conductor: vence a EXPIRED. */
  requestedMs: number;
  /** Pre-recojo ya asignado (ASSIGNED/ACCEPTED/ARRIVING/ARRIVED): vence a EXPIRED. */
  prePickupMs: number;
  /** IN_PROGRESS abandonado: vence a FAILED. */
  inProgressMs: number;
}

/**
 * Estados pre-recojo (ya asignado un conductor pero el viaje aún no inició). Estancarse aquí
 * significa que el conductor no aceptó o nunca llegó al recojo → EXPIRED.
 *
 * REASSIGNING se trata como pre-recojo (robustez #4): tras una cancelación del conductor el viaje re-abre
 * la puja; si NADIE oferta tras la re-apertura, queda atascado igual que un REQUESTED sin match. El
 * watchdog lo barre con el umbral pre-recojo → EXPIRED (el pasajero recibe la notificación y re-puja).
 */
const PRE_PICKUP_ASSIGNED: ReadonlySet<TripStatus> = new Set([
  TripStatus.ASSIGNED,
  TripStatus.ACCEPTED,
  TripStatus.ARRIVING,
  TripStatus.ARRIVED,
  TripStatus.REASSIGNING,
]);

/**
 * Estados NO terminales que el watchdog vigila. El resto (terminales y SCHEDULED) los ignora:
 * SCHEDULED tiene su propio scheduler (activación/expiración por ventana), no estancamiento.
 *
 * REASSIGNING entra acá (robustez #4): un viaje re-abierto que no consigue ofertas tras la re-apertura
 * (p.ej. el board de dispatch ya no existe / el no_offers se perdió) se estancaría para siempre — el
 * sweeper lo rescata como un estancamiento pre-recojo → EXPIRED.
 */
export const WATCHED_STATES: readonly TripStatus[] = [
  TripStatus.REQUESTED,
  TripStatus.ASSIGNED,
  TripStatus.ACCEPTED,
  TripStatus.ARRIVING,
  TripStatus.ARRIVED,
  TripStatus.REASSIGNING,
  TripStatus.IN_PROGRESS,
];

/** Umbral aplicable a un estado vigilado (ms). */
function thresholdFor(status: TripStatus, t: WatchdogThresholds): number | null {
  if (status === TripStatus.REQUESTED) return t.requestedMs;
  if (PRE_PICKUP_ASSIGNED.has(status)) return t.prePickupMs;
  if (status === TripStatus.IN_PROGRESS) return t.inProgressMs;
  return null; // no vigilado
}

/**
 * Decide a qué terminal de fallo debe transicionar un viaje estancado, o `null` si todavía no vence
 * (o el estado no se vigila). Pre-recojo → EXPIRED; en curso → FAILED.
 *
 * @param status    estado actual del viaje.
 * @param lastActivity  última actividad (updatedAt): marca del último cambio del viaje.
 * @param now       reloj.
 * @param t         umbrales.
 */
export function resolveStalledTarget(
  status: TripStatus,
  lastActivity: Date,
  now: Date,
  t: WatchdogThresholds,
): StalledTarget | null {
  const threshold = thresholdFor(status, t);
  if (threshold === null) return null;
  const ageMs = now.getTime() - lastActivity.getTime();
  if (ageMs < threshold) return null; // aún fresco
  return status === TripStatus.IN_PROGRESS ? TripStatus.FAILED : TripStatus.EXPIRED;
}
