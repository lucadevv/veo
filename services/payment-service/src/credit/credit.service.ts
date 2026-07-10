/**
 * CreditService — saldo de crédito GASTABLE del usuario (Ola 2A · redención de referidos · Lote A).
 *
 * payment-service es dueño del saldo (microservicios: identity guarda "ganado de por vida" en
 * `User.referralRewardCents`; payment guarda lo "gastable" acá). Este service solo ACREDITA por el evento
 * `referral.rewarded`; el GASTO en el cobro llega en el Lote B (decremento en la MISMA tx ACID del cobro,
 * sin doble-gasto cross-service).
 *
 * Idempotencia financiera (§3 CLAUDE): el ledger `UserCreditEntry.sourceRef` es UNIQUE = el `eventId` del
 * evento. Un `referral.rewarded` re-entregado (mismo eventId) viola el UNIQUE → la tx aborta → NO re-acredita.
 */
import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from '@veo/utils';
import { isUniqueViolation } from '@veo/database';
import { CreditRepository } from './credit.repository';
import { CreditSource } from '../generated/prisma';

/**
 * Tope de reintentos del gasto ante la carrera de saldo (CAS miss). La carrera exige dos cobros del MISMO
 * usuario decrementando en paralelo — prácticamente imposible (un pasajero no liquida dos viajes a la vez);
 * 3 es cinturón-y-tirantes. Agotarlo NO rompe el cobro: degrada a "sin crédito" (saldo intacto).
 */
const MAX_SPEND_ATTEMPTS = 3;

@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(private readonly repo: CreditRepository) {}

  /**
   * Acredita `rewardCents` al saldo gastable de `userId` por un referido. IDEMPOTENTE por `eventId`.
   * Devuelve `true` si acreditó, `false` si el evento ya estaba aplicado (re-entrega) o no hay nada que sumar.
   */
  async creditFromReferral(input: {
    userId: string;
    rewardCents: number;
    eventId: string;
  }): Promise<boolean> {
    const { userId, rewardCents, eventId } = input;
    // Defensivo: el schema garantiza rewardCents int, pero un 0/negativo no es una acreditación.
    if (rewardCents <= 0) return false;

    try {
      await this.repo.runInTransaction(async (tx) => {
        // 1) Asegura el registro de saldo (no-op si ya existe) para que el FK del movimiento se satisfaga.
        await this.repo.ensureCreditRowInTx(tx, userId);
        // 2) GUARD de idempotencia ANTES del increment: el INSERT viola UNIQUE(source_ref) si el evento ya
        //    se procesó → P2002 → la tx ENTERA aborta (el increment de abajo NO ocurre).
        await this.repo.createEntryInTx(tx, {
          id: uuidv7(),
          userId,
          deltaCents: rewardCents,
          source: CreditSource.REFERRAL,
          sourceRef: eventId,
        });
        // 3) Solo si el movimiento era nuevo: aplica el saldo.
        await this.repo.incrementBalanceInTx(tx, userId, rewardCents);
      });
      this.logger.log(
        `Crédito de referido acreditado: user=${userId} +${rewardCents}c (event=${eventId})`,
      );
      return true;
    } catch (err) {
      if (isUniqueViolation(err, 'sourceRef')) {
        this.logger.debug(`referral.rewarded ${eventId} ya acreditado (idempotente); skip`);
        return false;
      }
      throw err; // transitorio → el consumer relanza y Kafka reintenta; sigue siendo idempotente.
    }
  }

  /**
   * Aplica crédito gastable al cobro de un viaje (Lote B). Devuelve los céntimos efectivamente aplicados
   * (0 si no hay saldo). IDEMPOTENTE por `credit:${chargeDedupKey}`: un re-run del MISMO cobro devuelve el
   * MISMO monto sin re-gastar (el cobro corta antes por su dedupKey, pero si gastó y el Payment falló, el
   * retry recupera el monto ya aplicado). Concurrencia (otro cobro del mismo user en paralelo): decremento
   * por CAS (`balance >= applied`) con reintento de saldo fresco; si tras reintentos el saldo no alcanza,
   * NO aplica crédito (no rompe el cobro — el saldo queda intacto para el próximo viaje · degradación honesta).
   */
  async spendForCharge(input: {
    userId: string;
    maxApplicableCents: number;
    chargeDedupKey: string;
  }): Promise<number> {
    const { userId, maxApplicableCents, chargeDedupKey } = input;
    if (maxApplicableCents <= 0) return 0;
    const sourceRef = `credit:${chargeDedupKey}`;

    // Idempotencia: si este cobro ya gastó crédito (re-run / fallo previo tras gastar), devolver el MISMO
    // monto aplicado (el saldo ya se decrementó una vez) para que el cobro recompute idéntico.
    const already = await this.repo.findEntryBySourceRef(sourceRef);
    if (already) return -already.deltaCents;

    // Reintento ACOTADO solo para la carrera de saldo (CAS miss): cada vuelta es UNA llamada al helper, no
    // una query por-item (no es n+1 — no itera una colección, reintenta ≤N una sola operación con saldo fresco).
    for (let attempt = 1; attempt <= MAX_SPEND_ATTEMPTS; attempt += 1) {
      const outcome = await this.attemptSpend(userId, maxApplicableCents, sourceRef);
      if (outcome.settled) return outcome.applied;
      // CAS miss → otra escritura concurrente bajó el saldo; reintentamos con el valor fresco.
    }

    this.logger.warn(
      `spendForCharge: CAS agotó ${MAX_SPEND_ATTEMPTS} intentos (user=${userId}); cobro sin crédito`,
    );
    return 0;
  }

  /**
   * UN intento de gasto (lectura de saldo + CAS atómico). `settled:false` = el CAS no matcheó (carrera de
   * saldo) → el caller reintenta con saldo fresco. Aislado del `for` para que la lectura no sea una query
   * suelta dentro de un loop (no es n+1) y para separar el INTENTO del REINTENTO.
   */
  private async attemptSpend(
    userId: string,
    maxApplicableCents: number,
    sourceRef: string,
  ): Promise<{ settled: boolean; applied: number }> {
    const current = await this.repo.findCreditByUser(userId);
    const balance = current?.balanceCents ?? 0;
    const applied = Math.min(balance, maxApplicableCents);
    if (applied <= 0) return { settled: true, applied: 0 };

    try {
      const ok = await this.repo.runInTransaction(async (tx) => {
        // CAS: decrementa SOLO si el saldo SIGUE alcanzando (un gasto concurrente del mismo user pudo
        // bajarlo entre el read y este write). count=0 → carrera → reintentar con saldo fresco.
        const dec = await this.repo.casDecrementBalanceInTx(tx, userId, applied);
        if (dec.count === 0) return false;
        await this.repo.createEntryInTx(tx, {
          id: uuidv7(),
          userId,
          deltaCents: -applied,
          source: CreditSource.TRIP_REDEMPTION,
          sourceRef,
        });
        return true;
      });
      if (ok) {
        this.logger.log(
          `Crédito aplicado al cobro: user=${userId} -${applied}c (sourceRef=${sourceRef})`,
        );
        return { settled: true, applied };
      }
      return { settled: false, applied: 0 }; // CAS miss → el caller reintenta
    } catch (err) {
      if (isUniqueViolation(err, 'sourceRef')) {
        // Doble-entrega del MISMO cobro en paralelo: el ganador ya gastó; devolver su monto.
        const winner = await this.repo.findEntryBySourceRef(sourceRef);
        return { settled: true, applied: winner ? -winner.deltaCents : 0 };
      }
      throw err;
    }
  }
}
