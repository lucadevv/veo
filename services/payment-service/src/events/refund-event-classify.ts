/**
 * Clasificación TIPADA del error que `refundForBookingCancellation` (path Kafka `booking.cancelled`) puede
 * lanzar al consumer. Cierra el HUECO que estancaba la partición (F3c FIX 3 · plata real):
 *
 * CAUSA RAÍZ del loop: el catch de `onBookingCancelled` solo absorbía `isPermanentDataError` (P2023…). Un
 * rechazo SÍNCRONO del gateway sube como `UnprocessableEntityError` (422) — que NO es permanent-data → se
 * RE-LANZABA → kafkajs no commitea el offset → re-entrega el MISMO `booking.cancelled` ∞ (head-of-line block).
 * El consumer NO debe reintentar un REJECTED: lo ABSORBE y deja que el backstop admin (alerta + métrica) lo
 * resuelva a mano. (Se ELIMINÓ el cron re-conductor automático que reintentaba los REJECTED: loopeaba / mataba
 * de hambre. Ahora TODO refund REJECTED persistente converge a marca durable + métrica + alerta → refund admin.)
 *
 * CUATRO clases (cero strings mágicos — se clasifica por TIPO/code, nunca por `err.message`):
 *
 *  1. PERMANENT_DATA  — Prisma P2023/P2009/P2000/P2006 (UUID malformado en columna @db.Uuid, etc.). El payload
 *                       NUNCA va a procesar. → log ERROR + return (NO relanzar). Reusa `isPermanentDataError`.
 *
 *  2. REJECTED_SETTLED — el refund quedó RECHAZADO y PERSISTIDO en estado REJECTED en la DB (el rastro durable que
 *                       el admin VE en el listado de refunds fallidos). El consumer NO debe re-disparar (evita el
 *                       loop Kafka) → métrica backstop{reason="rejected"} + log + return (ABSORBER); el refund admin
 *                       lo resuelve a mano sobre el Payment CAPTURED. Caso típico: gateway REJECTED síncrono →
 *                       `rejectRefundAndCompensate` persiste el Refund REJECTED y LUEGO lanza
 *                       `UnprocessableEntityError`. También `GatewayCapabilityUnavailableError` (rechazo permanente
 *                       de capacidad) por si alguna vez subiera tipado.
 *
 *  3. UNRECOVERABLE_NO_REFUND — error de dominio NO transitorio que abortó ANTES de llamar al riel (p.ej.
 *                       `InvalidStateError`: el gateway activo no soporta reembolsos, o el cobro no tiene railRef).
 *                       `persistUnrecoverableRefundMarker` ya dejó un Refund REJECTED de marca ANTES de lanzar (rastro
 *                       durable). Reintentar por Kafka loopea ∞ (la condición es permanente) → métrica
 *                       backstop{reason="unrecoverable"} + ALERTA FUERTE + return (backstop = refund admin manual).
 *                       NO loop, NO refund-silencioso-perdido: se SURFACEA para resolución manual.
 *
 *  4. TRANSIENT (default) — DB caída, red, timeout, deadlock (P1xxx/P2034), 5xx no-determinista,
 *                       `ExternalServiceError` (502). El medio falló, el evento es válido. → RELANZAR (Kafka
 *                       reintenta; `refundForBookingCancellation` es idempotente por dedupKey UNIQUE). "Fail
 *                       closed hacia el retry": ante la duda, transitorio. AQUÍ TAMBIÉN cae el CAS miss
 *                       (`ConcurrencyConflictError`): el `claimRefundReservationInTx` abortó porque otra
 *                       operación concurrente movió el saldo entre el read y el write (optimistic-lock).
 *                       Es REINTENTABLE (con el estado fresco el reintento tendría éxito) — DISTINTO de
 *                       `InvalidStateError` (violación PERMANENTE de la máquina de estados, irrecuperable):
 *                       clasificarlo como `transient` evita DESCARTAR un reintento que habría funcionado y
 *                       evita la FALSA alerta de backstop sobre una simple carrera optimista.
 */
import { isPermanentDataError } from '@veo/events';
import {
  ConcurrencyConflictError,
  ExternalServiceError,
  GatewayCapabilityUnavailableError,
  InvalidStateError,
  UnprocessableEntityError,
  isDomainError,
} from '@veo/utils';

/** Acción que el consumer debe tomar ante el error. */
export type RefundErrorAction =
  /** Payload veneno (Prisma permanent-data). Log ERROR + return. */
  | 'permanent_data'
  /** Refund REJECTED ya persistido. Backstop admin: métrica + log + return (ABSORBER), NO reintento automático. */
  | 'rejected_settled'
  /** No-transitorio que NO dejó Refund recuperable. ALERTA + return (backstop admin). */
  | 'unrecoverable_no_refund'
  /** Transitorio. Relanzar (Kafka reintenta). */
  | 'transient';

/**
 * Clasifica el error por TIPO/code (jamás por texto). El orden importa: lo más específico primero.
 *
 * NOTA sobre por qué `ExternalServiceError` es TRANSITORIO y `UnprocessableEntityError` NO: ambos son
 * DomainError, pero el 502 (EXTERNAL) es por definición reintentable (upstream degradado momentáneo),
 * mientras que el 422 (UNPROCESSABLE/GATEWAY_CAPABILITY) es un rechazo que reintentar no resuelve.
 */
export function classifyRefundError(err: unknown): RefundErrorAction {
  // 1) Veneno de datos (Prisma) — la guardia que YA existía. Reintentar da siempre el mismo error.
  if (isPermanentDataError(err)) return 'permanent_data';

  // Transitorio EXPLÍCITO aunque sea DomainError: 502 upstream se reintenta (no caer en la rama no-transitoria).
  if (err instanceof ExternalServiceError) return 'transient';

  // 2) Rechazo del refund que YA dejó un Refund REJECTED persistido → backstop admin (métrica + alerta + return).
  //    UnprocessableEntityError: el gateway rechazó síncrono y `rejectRefundAndCompensate` persistió REJECTED
  //    ANTES de lanzar. GatewayCapabilityUnavailableError: rechazo permanente de capacidad (defensa en profundidad).
  if (err instanceof UnprocessableEntityError || err instanceof GatewayCapabilityUnavailableError) {
    return 'rejected_settled';
  }

  // 2.5) CAS miss optimista (ConcurrencyConflictError): otra operación concurrente movió el saldo entre el
  //      read y el write del claim. Es TRANSITORIO — un reintento con el estado fresco tendría éxito.
  //      VA ANTES del InvalidStateError: ambos son 409, pero este es reintentable (no permanente). Sin esta
  //      regla, el CAS miss caería en `unrecoverable_no_refund` → descartaría un retry válido + falsa alerta.
  if (err instanceof ConcurrencyConflictError) return 'transient';

  // 3) No-transitorio que abortó antes de llamar al riel (el gateway no soporta reembolsos / sin railRef).
  //    Reintentar loopea ∞ → backstop manual (el marcador durable REJECTED ya lo dejó persistUnrecoverableRefundMarker).
  if (err instanceof InvalidStateError) return 'unrecoverable_no_refund';

  // Cualquier OTRO DomainError no-transitorio conocido (validación, forbidden, not-found inesperado en este path):
  //    no es algo que Kafka resuelva reintentando → backstop manual, NO loop.
  //    (NotFoundError/ConflictError de idempotencia ya se manejan ANTES como `skipped`/uniqueViolation aguas abajo.)
  if (isDomainError(err)) return 'unrecoverable_no_refund';

  // 4) Default: transitorio (DB caída, red, timeout, deadlock). Relanzar para que Kafka reintente.
  return 'transient';
}
