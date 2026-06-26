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
  DisburseRequest,
  DisburseResult,
} from './payout-gateway.port';

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

export class SandboxPayoutGateway implements PayoutGateway {
  private readonly logger = new Logger('SandboxPayoutGateway');
  private readonly rejectSeed: number;
  private readonly confirmSync: boolean;

  constructor(opts: SandboxPayoutGatewayOptions = {}) {
    this.rejectSeed = opts.rejectSeed ?? 13;
    this.confirmSync = opts.confirmSync ?? false;
  }

  async disburse(req: DisburseRequest): Promise<DisburseResult> {
    // Referencia determinista por payout (idempotencia: re-disparar el mismo payout no duplica el riel).
    const externalRef = `sbx_payout_${req.method.toLowerCase()}_${req.payoutId}`;

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

    // 3. SUBMITTED (default): async, la confirmación llega por webhook/poll.
    this.logger.log(
      `[SANDBOX-PAYOUT ${req.method}] desembolso SUBMITTED (async) ref=${externalRef} monto=${req.amountCents} (espera webhook/poll)`,
    );
    return { externalRef, status: 'SUBMITTED' };
  }
}
