/**
 * Lote C1 · Sweeper de PROPUESTAS de parada vencidas.
 *
 * GAP que cierra: la máquina de estados de la propuesta define el terminal EXPIRED, pero nada lo
 * conduce. Una propuesta PROPOSED que el conductor nunca respondió se quedaría viva para siempre
 * (bloqueando "una sola activa por viaje" y mintiéndole al pasajero con una cuenta regresiva muerta).
 * Este cron barre periódicamente las PROPOSED con `expiresAt` vencido y las lleva a EXPIRED + outbox
 * `trip.waypoint_expired`, espejando el patrón de `trip-watchdog.scheduler.ts`.
 *
 * Cada barrido es IDEMPOTENTE (guard CAS por propuesta en WaypointProposalService.expireProposal) y
 * ACOTADO (lote por tick), por lo que solapamientos de ticks o réplicas no producen doble transición
 * ni doble evento. El TTL es corto (~30s, el viaje está EN CURSO), así que se barre EVERY_10_SECONDS
 * para no dejar al pasajero/conductor mirando una propuesta vencida más de un puñado de segundos.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WaypointProposalService } from './waypoint-proposal.service';

/** Tope de propuestas barridas por tick para acotar la carga (el resto cae en el siguiente tick). */
const MAX_PER_TICK = 200;

@Injectable()
export class WaypointProposalScheduler {
  private readonly logger = new Logger(WaypointProposalScheduler.name);
  /** Evita solapamiento si un tick tarda más de su intervalo. */
  private running = false;

  constructor(private readonly proposals: WaypointProposalService) {}

  /** `now` inyectable solo para tests deterministas; en producción usa el reloj real. */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.proposals.findExpiredCandidates(now, MAX_PER_TICK);
      if (candidates.length === 0) return;

      let expired = 0;
      for (const c of candidates) {
        try {
          if (await this.proposals.expireProposal(c.id, now)) expired++;
        } catch (err) {
          // Un fallo aislado no detiene el barrido; la propuesta se reintenta al siguiente tick.
          this.logger.error(
            { err, proposalId: c.id },
            'waypoint sweeper: no se pudo expirar la propuesta',
          );
        }
      }
      if (expired > 0) this.logger.log(`waypoint sweeper: ${expired} propuesta(s) → EXPIRED`);
    } catch (err) {
      this.logger.error({ err }, 'waypoint sweeper: el barrido de propuestas vencidas falló');
    } finally {
      this.running = false;
    }
  }
}
