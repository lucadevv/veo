/**
 * Adapter SANDBOX del riel de DESEMBOLSO (money-OUT · ADR-015 D2) — ESPEJO del `SandboxPaymentGateway`
 * del money-IN. Red de desembolso determinista en proceso: habilita el e2e money-OUT en dev sin PSP real.
 * NO es un mock de test: es un adapter real, seleccionable por `PAYOUT_GATEWAY_MODE=sandbox`.
 *
 * REGLA DETERMINISTA (sin red, sin azar — reproducible 1:1):
 *  1. RECHAZO PERMANENTE: si `amountCents` es múltiplo del `rejectSeed` (default 13 → montos como 13/26/39…
 *     céntimos), el riel rechaza de forma PERMANENTE → lanza `PayoutPermanentlyRejectedError`. Espeja el
 *     `declineSuffix` del money-IN: permite probar el camino `PROCESSING → FAILED` sin cuentas reales.
 *  2. CONFIRMACIÓN SÍNCRONA: si `confirmSync: true`, el riel captura en línea → `CONFIRMED` (la plata salió).
 *     Camino raro (algunos rieles confirman síncrono); útil para e2e que no quieren simular el webhook.
 *  3. SUBMITTED (default): el desembolso queda ASÍNCRONO → `SUBMITTED`. La confirmación final llega luego
 *     por el webhook/poll del riel (el camino normal Yape/Plin push, espejo de PENDING_EXTERNAL del money-IN).
 *
 * SOBERANÍA (ADR-015 D2): el payload NO porta PII. El `externalRef` se deriva del `payoutId` (idempotencia
 * determinista: re-disparar el mismo payout devuelve el MISMO ref — espejo del `dedupKey = payout-disburse:{payoutId}`).
 */
import { Logger } from '@nestjs/common';
import { PayoutPermanentlyRejectedError } from '@veo/utils';
import type {
  PayoutGateway,
  PayoutStatusQuery,
  PayoutDisbursementQuery,
  PayoutDisbursementStatusDetail,
  DisburseRequest,
  DisburseResult,
} from './payout-gateway.port';

/**
 * Prefijo de la dedupKey financiera del desembolso (ADR-015 §7: `payout-disburse:{payoutId}`). El sandbox lo
 * usa para RECONSTRUIR el payoutId desde la dedupKey cuando reconcilia un PROCESSING huérfano (sin externalRef)
 * — su ref es determinista por payoutId, así que dedupKey y externalRef apuntan a la MISMA transferencia.
 */
const PAYOUT_DEDUP_PREFIX = 'payout-disburse:';

export interface SandboxPayoutGatewayOptions {
  /**
   * Semilla del RECHAZO determinista: un `amountCents` múltiplo de este valor se rechaza permanente.
   * Default 13 (primo poco probable de chocar montos reales redondeados). 0 ⇒ nunca rechaza por monto.
   */
  rejectSeed?: number;
  /**
   * Si true, el desembolso confirma SÍNCRONO (`CONFIRMED`) en vez de quedar `SUBMITTED` (async).
   * Default false (camino normal: async, confirma por webhook/poll).
   */
  confirmSync?: boolean;
}

export class SandboxPayoutGateway implements PayoutGateway, PayoutStatusQuery {
  private readonly logger = new Logger('SandboxPayoutGateway');
  private readonly rejectSeed: number;
  private readonly confirmSync: boolean;
  /**
   * Libro mayor de desembolsos SUBMITTED (externalRef → monto), en proceso. El poll fallback consulta acá: un
   * desembolso async pasa a CONFIRMED en la consulta (espeja el ledger del sandbox money-IN que el `/show`/
   * poll resuelve). Determinista 1:1 sin red ni azar.
   */
  private readonly submitted = new Map<string, { amountCents: number }>();
  /**
   * Índice paralelo payoutId → externalRef de los SUBMITTED. Permite reconciliar un PROCESSING HUÉRFANO (sin
   * externalRef por un crash post-claim) a partir de SOLO su `dedupKey` (`payout-disburse:{payoutId}`): de la
   * dedupKey extraemos el payoutId y de acá su externalRef. Cierra el hueco de orfandad del §4.2.
   */
  private readonly submittedByPayoutId = new Map<string, string>();

  constructor(opts: SandboxPayoutGatewayOptions = {}) {
    this.rejectSeed = opts.rejectSeed ?? 13;
    this.confirmSync = opts.confirmSync ?? false;
  }

  /** Ref determinista por payout (idempotencia: re-disparar el mismo payout no duplica el riel). */
  private refFor(method: string, payoutId: string): string {
    return `sbx_payout_${method.toLowerCase()}_${payoutId}`;
  }

  /**
   * Disponibilidad del riel (ADR-015 §8): el sandbox SIEMPRE puede desembolsar (red determinista en
   * proceso, sin convenio externo). El dominio lo consulta pre-claim; en dev/test nada cambia.
   */
  isAvailable(): boolean {
    return true;
  }

  async disburse(req: DisburseRequest): Promise<DisburseResult> {
    const externalRef = this.refFor(req.method, req.payoutId);

    // 1. Rechazo PERMANENTE determinista por monto (espeja el declineSuffix del money-IN).
    if (this.rejectSeed > 0 && req.amountCents % this.rejectSeed === 0) {
      this.logger.warn(
        `[SANDBOX-PAYOUT ${req.method}] desembolso RECHAZADO permanente (monto de prueba) payout=${req.payoutId}`,
      );
      throw new PayoutPermanentlyRejectedError(
        'Sandbox payout: rechazo permanente determinista (monto múltiplo del rejectSeed)',
        { payoutId: req.payoutId, amountCents: req.amountCents },
      );
    }

    // 2. Confirmación SÍNCRONA (raro): la plata salió en línea.
    if (this.confirmSync) {
      this.logger.log(
        `[SANDBOX-PAYOUT ${req.method}] desembolso CONFIRMADO síncrono ref=${externalRef} monto=${req.amountCents}`,
      );
      return { externalRef, status: 'CONFIRMED' };
    }

    // 3. SUBMITTED (default): async, la confirmación llega por webhook/poll. Lo anotamos en el libro para
    //    que el poll fallback lo resuelva a CONFIRMED (re-disparar el mismo payout reusa el MISMO ref → no
    //    duplica la anotación: idempotencia del riel).
    if (!this.submitted.has(externalRef)) {
      this.submitted.set(externalRef, { amountCents: req.amountCents });
      this.submittedByPayoutId.set(req.payoutId, externalRef);
    }
    this.logger.log(
      `[SANDBOX-PAYOUT ${req.method}] desembolso SUBMITTED (async) ref=${externalRef} monto=${req.amountCents} (espera webhook/poll)`,
    );
    return { externalRef, status: 'SUBMITTED' };
  }

  /**
   * POLL FALLBACK (capacidad `PayoutStatusQuery`): un desembolso SUBMITTED se resuelve a CONFIRMED al
   * consultarlo (la plata "salió" en la red simulada). Determinista, reproducible: cierra el ciclo async
   * money-OUT en dev/e2e sin PSP real, espejo de cómo el poll del money-IN cierra el PENDING_EXTERNAL.
   *
   * Reconcilia por DOS llaves (cierra la orfandad del §4.2): resuelve por `externalRef` si lo tiene; si NO
   * (PROCESSING huérfano por un crash post-claim), por `dedupKey` → extrae el payoutId y recupera el ref
   * anotado. Ambas correlacionan la MISMA transferencia. Un handle no anotado ⇒ `found:false` (reintento luego).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getDisbursementStatus(
    query: PayoutDisbursementQuery,
  ): Promise<PayoutDisbursementStatusDetail> {
    // 1. Por externalRef si está presente y anotado.
    if (query.externalRef && this.submitted.has(query.externalRef)) {
      this.logger.log(
        `[SANDBOX-PAYOUT] consulta ref=${query.externalRef} → CONFIRMED (plata salió, simulado)`,
      );
      return { found: true, status: 'CONFIRMED' };
    }
    // 2. Fallback por dedupKey: el PROCESSING huérfano (sin externalRef) se reconcilia por su dedupKey
    //    determinista. Extraemos el payoutId y buscamos el ref que el disburse anotó para ese payout.
    const payoutId = query.dedupKey.startsWith(PAYOUT_DEDUP_PREFIX)
      ? query.dedupKey.slice(PAYOUT_DEDUP_PREFIX.length)
      : null;
    const refByDedup = payoutId ? this.submittedByPayoutId.get(payoutId) : undefined;
    if (refByDedup && this.submitted.has(refByDedup)) {
      this.logger.log(
        `[SANDBOX-PAYOUT] consulta por dedupKey=${query.dedupKey} (sin externalRef) → CONFIRMED (reconciliado)`,
      );
      return { found: true, status: 'CONFIRMED' };
    }
    return { found: false, status: 'PENDING' };
  }
}
