/**
 * Reconciler de timeout de ofertas del matching SECUENCIAL (D2.3). Reemplaza el `setTimeout` en proceso
 * del matcher legacy por un barrido DURABLE: cada tick reclama las ofertas OFFERED vencidas (CAS atómico
 * a TIMEOUT) y avanza el matching (offerNext). Sin esto, una oferta no respondida dejaba el viaje trabado
 * (el "una oferta a la vez" impide ofertar al siguiente hasta que la actual se resuelve).
 *
 * Mismo patrón que offer-board.scheduler: @Interval de @nestjs/schedule (ya registrado en AppModule) +
 * guard re-entrante. Replica-safe por el CAS por-oferta (no necesita advisory lock): si dos réplicas
 * barren a la vez, solo UNA reclama cada oferta (la otra ve count=0). Idempotente: re-marcar es no-op.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MatchingService } from './matching.service';

@Injectable()
export class DispatchTimeoutReconciler {
  private readonly logger = new Logger(DispatchTimeoutReconciler.name);
  private running = false;

  constructor(private readonly matching: MatchingService) {}

  /** Tick de barrido cada 2s. Re-entrante-seguro (no solapa dos barridos en la misma réplica). */
  @Interval('dispatch-offer-timeout-sweep', 2_000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const advanced = await this.matching.sweepExpiredOffers();
      if (advanced > 0)
        this.logger.debug(`barrido: ${advanced} ofertas vencidas → TIMEOUT + advance`);
    } catch (err) {
      this.logger.error(`barrido de ofertas vencidas falló: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
