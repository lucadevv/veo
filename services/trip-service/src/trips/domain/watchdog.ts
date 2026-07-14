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
 * valida `assertTransition` — y la máquina NO permite EXPIRED desde los post-accept
 * (ACCEPTED/ARRIVING/ARRIVED: su único terminal de fallo es FAILED), así que cada target de este
 * módulo DEBE ser una transición válida o el sweeper lanzaría y el viaje quedaría estancado para
 * siempre (el spec de dominio lo asegura con canTransition sobre la máquina real).
 */
import { TripStatus } from '@veo/shared-types';

/** Terminal de fallo al que el watchdog puede llevar un viaje estancado. */
export type StalledTarget = typeof TripStatus.EXPIRED | typeof TripStatus.FAILED;

/** Umbrales del watchdog, en milisegundos (derivados de las env del servicio). */
export interface WatchdogThresholds {
  /** REQUESTED sin conductor: vence a EXPIRED. */
  requestedMs: number;
  /** Pre-recojo (ASSIGNED/REASSIGNING → EXPIRED; ACCEPTED/ARRIVING/ARRIVED → FAILED). */
  prePickupMs: number;
  /** IN_PROGRESS abandonado: vence a FAILED. */
  inProgressMs: number;
}

/**
 * Pre-recojo SIN compromiso del conductor: ASSIGNED (oferta enviada, nadie aceptó) y REASSIGNING
 * (re-puja abierta sin ofertas, robustez #4 — igual que un REQUESTED sin match). Estancarse aquí es
 * "expiró sin aceptación" → EXPIRED (la máquina solo permite EXPIRED desde estos dos pre-recojo; el
 * pasajero recibe la notificación y puede re-pujar).
 */
const PRE_PICKUP_UNACCEPTED: ReadonlySet<TripStatus> = new Set([
  TripStatus.ASSIGNED,
  TripStatus.REASSIGNING,
]);

/**
 * Pre-recojo CON conductor comprometido (ya aceptó): ACCEPTED/ARRIVING/ARRIVED. Estancarse aquí NO es
 * "expiró sin oferta" — hubo un conductor comprometido que nunca concretó el recojo → FAILED. Además
 * la máquina de estados NO permite EXPIRED desde estos tres (su único terminal de fallo es FAILED):
 * proponer EXPIRED hacía que assertTransition lanzara en cada barrido y el viaje quedara estancado
 * para siempre.
 */
const PRE_PICKUP_COMMITTED: ReadonlySet<TripStatus> = new Set([
  TripStatus.ACCEPTED,
  TripStatus.ARRIVING,
  TripStatus.ARRIVED,
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
  if (PRE_PICKUP_UNACCEPTED.has(status) || PRE_PICKUP_COMMITTED.has(status)) return t.prePickupMs;
  if (status === TripStatus.IN_PROGRESS) return t.inProgressMs;
  return null; // no vigilado
}

/**
 * Decide a qué terminal de fallo debe transicionar un viaje estancado, o `null` si todavía no vence
 * (o el estado no se vigila). Sin conductor comprometido (REQUESTED/ASSIGNED/REASSIGNING) → EXPIRED;
 * con conductor comprometido (ACCEPTED/ARRIVING/ARRIVED) o en curso → FAILED.
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
  return status === TripStatus.IN_PROGRESS || PRE_PICKUP_COMMITTED.has(status)
    ? TripStatus.FAILED
    : TripStatus.EXPIRED;
}
