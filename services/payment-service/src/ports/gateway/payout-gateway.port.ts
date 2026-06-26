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
  /** Riel money-OUT (YAPE | PLIN; live DIFERIDO). */
  method: PaymentMethod;
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
   * Dispara el desembolso (riel firmado). Idempotente por `dedupKey = payout-disburse:{payoutId}`:
   * reintentos del mismo Payout (`FAILED → PROCESSING`) NO duplican la transferencia. Lanza
   * `ExternalServiceError` (transitorio → reintento del operador) o `PayoutPermanentlyRejectedError`
   * (4xx no-reintentable → `FAILED` terminal).
   */
  disburse(req: DisburseRequest): Promise<DisburseResult>;
}
