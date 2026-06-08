/**
 * Barrido de expiración de ventanas de puja (ADR 010 §3.2). Cada tick recorre los boards OPEN y, para
 * los vencidos sin aceptación, los marca EXPIRED y emite `dispatch.no_offers` (→ trip EXPIRED, NoOffers).
 *
 * Elección de mecanismo: scheduler-tick (@Interval de @nestjs/schedule, ya registrado en AppModule) en
 * vez de Redis keyspace-notifications. Razón (encaja con el codebase): el outbox-relay YA usa un
 * setInterval propio (mismo patrón de poll), keyspace-notifications exige configurar `notify-keyspace-events`
 * en el Redis compartido (no garantizado en dev-stack) y entrega "at-most-once" sin reintento, y el barrido
 * necesita además LEER el board (cuántas ofertas hubo) para distinguir `window_expired` de `all_lapsed` —
 * algo que el evento de expiración de clave no trae. El tick es idempotente: re-marcar EXPIRED es no-op.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OfferBoardService } from './offer-board.service';

@Injectable()
export class OfferBoardScheduler {
  private readonly logger = new Logger(OfferBoardScheduler.name);
  private running = false;

  constructor(private readonly boards: OfferBoardService) {}

  /** Tick de barrido cada 2s. Re-entrante-seguro (no solapa dos barridos). */
  @Interval('offer-board-sweep', 2_000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const closed = await this.boards.sweepExpired();
      if (closed > 0) this.logger.debug(`barrido: ${closed} boards EXPIRED`);
      // N5 — reconciliador del residual hard-crash: re-emite match_found para boards CLOSED_MATCHED que
      // quedaron sin emitir (proceso muerto entre el claim y la commit del outbox). Idempotente (dedupKey).
      const reemitted = await this.boards.reconcileUnemittedMatches();
      if (reemitted > 0) this.logger.warn(`reconciliador N5: ${reemitted} match_found re-emitidos`);
    } catch (err) {
      this.logger.error(`barrido de pujas falló: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
