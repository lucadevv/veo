/**
 * DeletionSweeper — aplica el tombstone a las cuentas cuya gracia de borrado (BR-S06) ya venció.
 * Corre a diario. Anula la PII (incluida la BIOMÉTRICA: faceEmbedding de User/Driver y los intentos
 * de BiometricCheck) conservando el id para integridad referencial. La data sujeta a obligación
 * legal (panic events) vive en otros servicios; este sweeper emite `user.deleted` para que ellos
 * purguen su propia PII (fan-out cross-service, lote posterior). Todo dentro de UNA transacción.
 * Idempotente: las cuentas ya tombstoneadas (deletedAt != null) quedan fuera del barrido.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { deletedPlaceholder, enqueueOutbox } from '@veo/database';
import { createEnvelope } from '@veo/events';
import { RedisRefreshTokenStore } from '@veo/auth';
import { PrismaService } from '../infra/prisma.service';
import type { Env } from '../config/env.schema';

@Injectable()
export class DeletionSweeper {
  private readonly logger = new Logger(DeletionSweeper.name);
  private readonly graceDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    // Singleton global (CoreModule): la misma instancia que usa auth.service. Se usa para revocar TODAS
    // las sesiones de la cuenta borrada (revokeAllForUser) al aplicar el tombstone.
    private readonly sessions: RedisRefreshTokenStore,
  ) {
    this.graceDays = config.getOrThrow<number>('DELETION_GRACE_DAYS');
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async run(): Promise<void> {
    const applied = await this.sweep();
    if (applied > 0) this.logger.log(`Tombstone aplicado a ${applied} cuenta(s)`);
  }

  /** Devuelve cuántas cuentas se anonimizaron. Público para testeo/operación manual. */
  async sweep(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.graceDays * 24 * 60 * 60 * 1000);
    const due = await this.prisma.read.user.findMany({
      where: { deletedAt: null, deletionRequestedAt: { lte: cutoff } },
      select: { id: true, driver: { select: { id: true } } },
    });

    for (const { id, driver } of due) {
      await this.tombstoneUser(id, driver?.id, now);
    }
    return due.length;
  }

  /**
   * Anonimiza una cuenta y todo su rastro biométrico, y encola la señal de cascada — todo en la
   * MISMA transacción para que el tombstone y el evento sean atómicos (outbox-in-tx, FOUNDATION §6).
   */
  private async tombstoneUser(
    userId: string,
    driverId: string | undefined,
    now: Date,
  ): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      // User: PII de contacto + biométrica (faceEmbedding de referencia del pasajero verificado).
      await tx.user.update({
        where: { id: userId },
        data: {
          deletedAt: now,
          phone: deletedPlaceholder(userId, 'phone'),
          email: null,
          dniHash: null,
          photoUrl: null,
          faceEmbedding: [],
        },
      });

      // Driver: embedding facial de enrolamiento (BR-I02). Solo si el usuario es conductor. Al vaciar el
      // embedding (material cotejado) RESETEAMOS también el binding DNI↔selfie en la MISMA escritura: el
      // binding es evidencia FRESCA contra ESE embedding (invariante de frescura), así que mutar/vaciar el
      // embedding lo invalida — mismo patrón que enrollFace()/resubmit(). Doblemente correcto en el tombstone:
      // no dejamos evidencia biométrica stale de una cuenta borrada (PII Ley 29733).
      if (driverId) {
        await tx.driver.update({
          where: { id: driverId },
          data: {
            faceEmbedding: [],
            dniFaceMatched: null,
            dniFaceMatchScore: null,
            dniFaceMatchedAt: null,
          },
        });
      }

      // BiometricCheck: anonimiza cada intento (score/geo/captureRef) conservando el id por
      // integridad referencial — tombstone, no hard-delete. Idempotente (re-correr deja igual).
      await tx.biometricCheck.updateMany({
        where: { userId },
        data: { score: 0, geoLat: null, geoLon: null, captureRef: null },
      });

      // Señal de cascada: borrado EFECTIVO. Los consumidores downstream purgan su PII del usuario.
      const envelope = createEnvelope({
        eventType: 'user.deleted',
        producer: 'identity-service',
        payload: { userId, driverId, at: now.toISOString() },
      });
      await enqueueOutbox(tx, envelope, userId);
    });

    // Revoca TODAS las sesiones de la cuenta borrada (ADR-012 §2: revoke en borrado de cuenta).
    // POST-COMMIT y best-effort a propósito:
    //  - Redis NO es transaccional con Postgres: hacerlo DENTRO de la tx interactiva la mantendría abierta
    //    durante el RTT a Redis (riesgo de timeout) y, si la tx luego revierte, habríamos revocado sesiones
    //    de una cuenta cuyo tombstone no se aplicó.
    //  - `revokeAllForUser` sella el denylist epoch `revoked:before:{userId}` → mata los access tokens vivos
    //    al instante (no solo el refresh). Es lo que da valor por encima de `deletedAt`, que ya bloquea el
    //    refresh en `reissueUserAccess` (rechaza `user.deletedAt`).
    //  - fail-OPEN: si Redis no responde, NO revertimos el tombstone (la anonimización de PII, lo legalmente
    //    crítico de BR-S06, ya se commiteó). Logueamos a ERROR. Residual acotado: los access tokens vivos
    //    expiran en ≤ ACCESS_TTL (15m) y el refresh ya quedó bloqueado por `deletedAt`. El camino DURABLE
    //    (consumer de `user.deleted` → `resealRevokedBefore`, el backstop diseñado para esto) se difiere:
    //    exige cablear un consumer y el residual de 15m es aceptable para una cuenta ya anonimizada.
    try {
      await this.sessions.revokeAllForUser(userId);
    } catch (err) {
      this.logger.error(
        `revoke best-effort de sesiones falló para la cuenta tombstoneada ${userId} (Redis caído?): ` +
          `los access tokens vivos expiran en ≤15m; el refresh ya está bloqueado por deletedAt`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
