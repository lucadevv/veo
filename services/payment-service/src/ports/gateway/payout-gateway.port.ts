/**
 * Puerto propio `PayoutGateway` (money-OUT · ADR-015 §2) — ESPEJO arquitectónico del `PaymentGateway`
 * (money-IN). El riel de desembolso Yape/Plin a la billetera del conductor es el ÚNICO componente
 * externo inevitable; se encapsula tras este puerto. El dominio del payout NUNCA importa el SDK del PSP:
 * depende del símbolo DI `PAYOUT_GATEWAY` y de un fake del mismo contrato en tests. Adapters seleccionables
 * por env `PAYOUT_GATEWAY_MODE`:
 *   - `sandbox` → simulador determinista en proceso (AHORA): confirma o rechaza el desembolso según el
 *                 monto/seed. Habilita el e2e money-OUT en dev sin PSP real. NO es un mock de test.
 *   - `live`    → `YapePlinPayoutGateway` (DIFERIDO): bloqueado por convenio PSP, exactamente como el
 *                 `charge` live del money-IN. El día del convenio se enchufa por DI sin tocar el dominio.
 *
 * SOBERANÍA (FOUNDATION §0.7 · ADR-015 D2): SIN PII en el payload del riel. Solo IDs (payoutId, driverId)
 * + monto + moneda. La billetera destino (walletUid del conductor) la resuelve el adapter server-side
 * desde el driverId (espejo de `resolveActiveWalletUid` del money-IN); el dominio NO la porta.
 *
 * ASIMETRÍA DELIBERADA con el money-IN: el CHARGE lo dispara el sistema (al aprobar un booking / completar
 * un viaje); el DISBURSE lo dispara el OPERADOR (ADR-015 D3). El riel es asíncrono en ambos (push Yape/Plin,
 * captura por webhook/poll): por eso ambos tienen estados intermedios y confirman por evento.
 */
import type { PaymentMethod } from '@veo/shared-types';

export const PAYOUT_GATEWAY = Symbol('PAYOUT_GATEWAY');

/**
 * Métodos del riel money-OUT (ADR-015 sub-lote 2b · estrechado de 2a): SOLO `YAPE | PLIN`. El desembolso a
 * la billetera del conductor NO soporta CASH (bilateral, sin riel digital) ni CARD/PAGOEFECTIVO (rieles de
 * COBRO, no de pago a un tercero). Estrechar el tipo a lo representable hace ILEGAL un desembolso por un
 * método imposible (no se compila, no se testea un camino muerto) — mínimo privilegio en el contrato.
 */
export type PayoutMethod = Extract<PaymentMethod, 'YAPE' | 'PLIN'>;

/**
 * Estado INICIAL que el riel reporta al disparar el desembolso (ADR-015 §2). Estado TIPADO (union, no
 * literales sueltos): agregar un estado obliga a cubrir su rama en el dominio.
 *  - `SUBMITTED` → el desembolso se aceptó y queda ASÍNCRONO; la confirmación final (la plata SALIÓ) llega
 *                  por webhook/poll. Es el camino normal del riel push Yape/Plin (espejo de PENDING_EXTERNAL
 *                  del money-IN).
 *  - `CONFIRMED` → el riel capturó SÍNCRONAMENTE (raro; algunos rieles confirman en línea). La plata salió.
 *  - `REJECTED`  → rechazo PERMANENTE en línea (4xx no-reintentable). Acompañado de
 *                  `PayoutPermanentlyRejectedError` cuando el adapter lo lanza como excepción.
 */
export type PayoutDisbursementStatus = 'SUBMITTED' | 'CONFIRMED' | 'REJECTED';

/**
 * Entrada del DESEMBOLSO. Dinero SIEMPRE Int céntimos PEN. SIN PII: el walletUid destino lo resuelve el
 * adapter server-side desde el driverId (espejo de `resolveActiveWalletUid` del money-IN).
 */
export interface DisburseRequest {
  /** id del Payout de dominio (UUIDv7). Idempotencia: el adapter deriva `dedupKey = payout-disburse:{payoutId}`. */
  payoutId: string;
  /** El adapter resuelve la billetera destino desde esto; el dominio NO la porta. */
  driverId: string;
  /** NETO a desembolsar en céntimos PEN (gross - commission). */
  amountCents: number;
  /** Riel money-OUT (YAPE | PLIN; live DIFERIDO). Estrechado: el riel de desembolso NO habla CASH/CARD/PAGOEFECTIVO. */
  method: PayoutMethod;
  currency: 'PEN';
}

/**
 * Resultado del disparo del desembolso. El desembolso nace ASÍNCRONO (`SUBMITTED` → confirma por
 * webhook/poll · ADR-015 §1 D5): el adapter devuelve el ref externo + el estado inicial; la confirmación
 * final llega por evento, no en línea.
 */
export interface DisburseResult {
  /** Id de la transferencia en el riel (uid externo) — correlaciona el webhook/poll de confirmación. */
  externalRef: string;
  status: PayoutDisbursementStatus;
}

export interface PayoutGateway {
  /**
   * ¿Este adapter puede desembolsar HOY? Capacidad DECLARADA y OBLIGATORIA del contrato base (espejo
   * EXACTO de `PaymentGateway.supports` del money-IN: una capacidad que TODO adapter cumple va en el
   * contrato base, no en un type-guard opcional — si fuera opcional, el dominio necesitaría una rama
   * default silenciosa para los adapters que no la declaran, justo lo prohibido).
   *
   * El dominio la consulta ANTES de reclamar el payout a PROCESSING (pre-claim · ADR-015 §8): si el riel
   * money-OUT no está disponible (adapter live diferido, convenio PSP pendiente) el disparo FALLA-RÁPIDO
   * sin tocar el estado del payout → ningún payout queda PROCESSING colgado; queda PENDING/HELD/FAILED y
   * el operador ve un error claro. El env `PAYOUT_GATEWAY_MODE` lo mira SOLO la factory que elige el
   * adapter; el dominio pregunta al puerto y JAMÁS vuelve a mirar el env.
   *  - `SandboxPayoutGateway` → true (riel determinista en proceso: desembolsa siempre en dev/test).
   *  - `YapePlinPayoutGateway` (live) → false hasta el convenio PSP (NO desembolsa a ciegas).
   */
  isAvailable(): boolean;
  /**
   * Dispara el desembolso (riel firmado). Idempotente por `dedupKey = payout-disburse:{payoutId}`:
   * reintentos del mismo Payout (`FAILED → PROCESSING`) NO duplican la transferencia. Lanza
   * `ExternalServiceError` (transitorio → reintento del operador) o `PayoutPermanentlyRejectedError`
   * (4xx no-reintentable → `FAILED` terminal).
   */
  disburse(req: DisburseRequest): Promise<DisburseResult>;
}

/* ──────────────────────────── Capacidad opcional (ISP) ──────────────────────────── */

/**
 * Estado normalizado de un desembolso consultado al riel por su ref (PULL · espejo de `WebhookStatus`/
 * `PaymentStatusDetail` del money-IN). El desembolso confirma ASÍNCRONO; cuando el webhook no llega (dev sin
 * túnel, o el riel push sin callback), el dominio TIRA del estado y lo aplica por el MISMO camino idempotente
 * que aplicaría el webhook (`applyPayoutDisbursementResult`).
 *  - `CONFIRMED` → la plata SALIÓ (PROCESSING → PROCESSED).
 *  - `REJECTED`  → el riel rechazó/expiró (PROCESSING → FAILED). La plata NO salió.
 *  - `PENDING`   → sigue en curso: nada que aplicar.
 */
export type PayoutDisbursementResolution = 'CONFIRMED' | 'REJECTED' | 'PENDING';

/** Detalle del estado de un desembolso por su ref externo (espejo de `PaymentStatusDetail` del money-IN). */
export interface PayoutDisbursementStatusDetail {
  /** El riel reconoció el ref. Si false, el resto no aplica (reintentar el poll luego). */
  found: boolean;
  status: PayoutDisbursementResolution;
}

/**
 * Handle de correlación para consultar el estado de un desembolso al riel (PULL). DOS llaves, no una:
 *  - `dedupKey` (SIEMPRE presente): es el marcador de claim `payout-disburse:{payoutId}`, persistido en la
 *    MISMA transacción que mueve el payout a PROCESSING (ANTES de invocar el riel). Es la idempotencia
 *    financiera (§7) y, por eso, el ANCLA de reconciliación que NUNCA falta.
 *  - `externalRef` (puede faltar): el uid que el riel devuelve al disparar, persistido en un write POSTERIOR
 *    al claim. Si el proceso muere entre el disburse-OK y ese persist, el payout queda PROCESSING SIN
 *    externalRef — y aun así DEBE reconciliarse. Por eso la consulta NO depende solo de él.
 *
 * El riel resuelve por `externalRef` si lo tiene; si no, por `dedupKey` (ambas correlacionan la MISMA
 * transferencia: ambas derivan del payoutId). Cierra el hueco de orfandad "PROCESSING sin externalRef".
 */
export interface PayoutDisbursementQuery {
  /** Idempotencia financiera `payout-disburse:{payoutId}` — el ancla SIEMPRE presente (claim marker). */
  dedupKey: string;
  /** uid del riel — puede faltar si el proceso murió antes de persistirlo (orfandad que esto reconcilia). */
  externalRef?: string | null;
}

/**
 * Capacidad: el adapter consulta el estado de un desembolso por su correlación (PULL · espejo de
 * `PaymentStatusQuery.getPaymentStatus`). Habilita el POLL FALLBACK que cierra el ciclo async del payout en
 * dev/e2e (donde el webhook del riel no llega): el `PayoutPollService` pregunta y aplica por el camino
 * idempotente de `applyPayoutDisbursementResult`. El sandbox la implementa determinista; el live la
 * implementará contra el endpoint de consulta del PSP el día del convenio.
 *
 * Recibe `PayoutDisbursementQuery` (dedupKey SIEMPRE + externalRef opcional), NO un `string` suelto: un
 * PROCESSING huérfano (sin externalRef por un crash post-claim) se reconcilia por su dedupKey determinista.
 */
export interface PayoutStatusQuery {
  getDisbursementStatus(query: PayoutDisbursementQuery): Promise<PayoutDisbursementStatusDetail>;
}

/** Type-guard: ¿este adapter de payout consulta el estado de un desembolso por ref (poll fallback)? */
export function supportsPayoutStatusQuery(
  g: PayoutGateway,
): g is PayoutGateway & PayoutStatusQuery {
  return typeof (g as Partial<PayoutStatusQuery>).getDisbursementStatus === 'function';
}
