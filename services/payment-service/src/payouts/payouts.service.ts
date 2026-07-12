/**
 * PayoutsService — liquidación semanal por conductor (BR-P05).
 * Cron lunes: agrega los cobros capturados de la semana previa, aplica mínimo liquidable y
 * retención (HELD) si el conductor está en review (señal driver.flagged). Publica payout.processed.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { createEnvelope } from '@veo/events';
import {
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  PayoutPermanentlyRejectedError,
  uuidv7,
  withDistributedLock,
  type DistributedLockOutcome,
} from '@veo/utils';
import { PaymentMetrics } from '../metrics/payment.metrics';
import {
  POLICY_READER_PORT,
  STEP_UP_DEFAULT_MAX_AGE_SEC,
  type AuthenticatedUser,
  type PolicyReaderPort,
} from '@veo/auth';
import { PayoutsRepository, type PayoutTx } from './payouts.repository';
import { REDIS } from '../infra/redis';
import {
  aggregatePayouts,
  assertPayoutTransition,
  periodLabel,
  type DriverEarningRow,
} from './payout.policy';
import {
  PAYOUT_GATEWAY,
  type PayoutGateway,
  type PayoutMethod,
} from '../ports/gateway/payout-gateway.port';
import { PayoutStatus, type Payout } from '../generated/prisma';
import type { Env } from '../config/env.schema';

const FLAGGED_DRIVERS_KEY = 'veo:payment:flagged-drivers';
/** Motivo de retención de un payout por conductor en review (driver.flagged). Único valor, sin string mágico. */
const HELD_REASON_REVIEW = 'driver_in_review';
const CRON_LOCK_KEY = 'veo:payment:lock:weekly-payouts';
const CRON_LOCK_TTL_SECONDS = 600;
/** Riel money-OUT por defecto del desembolso (ADR-015 D2: YAPE/PLIN a la billetera del conductor). */
const DEFAULT_PAYOUT_METHOD: PayoutMethod = 'YAPE';

/** `dedupKey` financiera del DESEMBOLSO (ADR-015 §7): derivada del payoutId, distinta del charge. */
function payoutDedupKey(payoutId: string): string {
  return `payout-disburse:${payoutId}`;
}

/** Resumen de un disparo de desembolso (operador): cuántos pasaron a PROCESSING vs fallaron en línea. */
export interface PayoutDisburseSummary {
  /** Payouts que entraron a PROCESSING Y el riel ACEPTÓ en línea (SUBMITTED async o CONFIRMED síncrono). */
  dispatched: number;
  /**
   * Payouts que NO salieron en línea: rechazo PERMANENTE del riel → FAILED, O transitorio (ExternalServiceError)
   * → quedan PROCESSING para el poll/retry. En ambos el operador ve "no salió en línea"; el poll/retry lo cierra.
   */
  failed: number;
  /**
   * Payouts RECLAMADOS fuera de su estado origen (PENDING/HELD/FAILED → PROCESSING): `dispatched + failed`. Es
   * lo que de verdad se MOVIÓ del estado origen (lo usa el release para des-flaguear: el flag se quita cuando el
   * HELD se liberó al carril, independiente de si el riel falló transitorio — el payout ya está PROCESSING).
   */
  released: number;
  totalAmountCents: number;
}

/** Resultado de aplicar la confirmación del riel a un payout (PROCESSING → PROCESSED | FAILED). */
export interface ApplyDisbursementResult {
  applied: boolean;
  status: string;
}

export interface PayoutRunSummary {
  periodStart: string;
  periodEnd: string;
  /** Payouts creados en PENDING (a la espera del disparo del operador). El cron ya NO desembolsa. */
  pending: number;
  held: number;
  totalAmountCents: number;
}

/** Resultado de liberar la retención de un conductor (camino de vuelta de driver.flagged). */
export interface ReleaseHeldPayoutsResult {
  driverId: string;
  /** Payouts HELD→PROCESSING despachados al riel por esta llamada (0 si ya estaban liberados: idempotente). */
  released: number;
  totalAmountCents: number;
}

/** Página con cursor (id uuidv7) para el listado admin de payouts. */
export interface PayoutPage {
  items: Payout[];
  nextCursor: string | null;
}

/** Detalle de un payout = la fila completa + el desglose del netting abierto por FK (credit-back y deuda CASH
 *  ligados a ESTE payout). `debtAppliedCents` (en la fila) es el NETO firmado; estos dos son sus componentes. */
export interface PayoutDetail extends Payout {
  creditBackCents: number;
  debtSettledCents: number;
  /** Bono de incentivo pagado en ESTE payout (suma de IncentiveProgress ligados por paidInPayoutId). NETO. */
  bonusCents: number;
}

/** Una línea de "viajes incluidos" de un payout (reconstrucción por período). `amountCents` = BRUTO del viaje. */
export interface PayoutTrip {
  tripId: string;
  amountCents: number;
  capturedAt: string | null;
  method: string | null;
}

/** Resultado de "viajes incluidos": lista capada (`trips`) + conteo TOTAL del período (`totalCount`). */
export interface PayoutTripsResult {
  trips: PayoutTrip[];
  totalCount: number;
}

/** Cap de la lista de "viajes incluidos" que devuelve el endpoint (el resto se resume en `totalCount`). */
const PAYOUT_TRIPS_CAP = 50;

/**
 * KPIs agregados de payouts para el panel FINANCE (GET /payouts/stats). `totalCents` = volumen total liquidado
 * (suma de `amountCents` de TODOS los estados, Int céntimos); `paidCents`/`heldCents`/`failedCents` abren ese
 * volumen por bucket (PROCESSED/HELD/FAILED) del MISMO groupBy que ya suma `amountCents` por status; el resto son
 * CONTEOS por estado. Un solo `groupBy`, sin materializar filas. Dinero SIEMPRE Int céntimos.
 */
export interface PayoutStats {
  totalCents: number;
  paidCents: number;
  heldCents: number;
  failedCents: number;
  pendingCount: number;
  processingCount: number;
  processedCount: number;
  heldCount: number;
  failedCount: number;
}

/** Mapeo enum→campo de conteo (CERO strings mágicos): cada PayoutStatus va a su contador tipado en PayoutStats. */
const PAYOUT_STATUS_COUNT_FIELD: Record<
  PayoutStatus,
  keyof Pick<
    PayoutStats,
    'pendingCount' | 'processingCount' | 'processedCount' | 'heldCount' | 'failedCount'
  >
> = {
  [PayoutStatus.PENDING]: 'pendingCount',
  [PayoutStatus.PROCESSING]: 'processingCount',
  [PayoutStatus.PROCESSED]: 'processedCount',
  [PayoutStatus.HELD]: 'heldCount',
  [PayoutStatus.FAILED]: 'failedCount',
};

/** Mapeo enum→campo de VOLUMEN por bucket (parcial: solo los estados que exponen su cents). El `_sum.amountCents`
 *  del groupBy se enruta a su bucket tipado sin strings mágicos; los estados sin bucket solo aportan a `totalCents`. */
const PAYOUT_STATUS_CENTS_FIELD: Partial<
  Record<PayoutStatus, keyof Pick<PayoutStats, 'paidCents' | 'heldCents' | 'failedCents'>>
> = {
  [PayoutStatus.PROCESSED]: 'paidCents',
  [PayoutStatus.HELD]: 'heldCents',
  [PayoutStatus.FAILED]: 'failedCents',
};
const PAYOUTS_DEFAULT_LIMIT = 25;
const PAYOUTS_MAX_LIMIT = 100;
function clampPayoutLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return PAYOUTS_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), PAYOUTS_MAX_LIMIT);
}

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);
  private readonly minCents: number;
  private readonly stepUpCents: number;

  constructor(
    private readonly repo: PayoutsRepository,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PAYOUT_GATEWAY) private readonly payoutGateway: PayoutGateway,
    config: ConfigService<Env, true>,
    // Métricas Prometheus del carril money-OUT (CLAUDE §6). @Optional + trailing por la MISMA razón que en
    // PaymentsService: los specs construyen el service a mano con menos args (sin Nest DI). PaymentMetrics es
    // @Global (CoreModule) → SIEMPRE inyectable en runtime; sin él (en tests viejos) el carril no emite métrica.
    @Optional() private readonly metrics?: PaymentMetrics,
    // PBAC (ADR-024 §9): la ventana de frescura del step-up MFA (`auth.stepup.maxAgeSec`) se lee del MISMO
    // reader cacheado que usa el StepUpMfaGuard (PolicyModule global en AppModule) — el cambio del superadmin
    // surte efecto acá también, sin double-source. @Optional + trailing por la MISMA razón que metrics: los
    // specs construyen el service a mano con menos args. Sin reader → default endurecido de @veo/auth.
    @Optional() @Inject(POLICY_READER_PORT) private readonly policy?: PolicyReaderPort,
  ) {
    this.minCents = config.getOrThrow<number>('PAYOUT_MIN_CENTS');
    this.stepUpCents = config.getOrThrow<number>('PAYOUT_STEPUP_CENTS');
  }

  /** Cron semanal: lunes 06:00 (hora del servidor). Liquida la semana previa [lun, lun). */
  @Cron('0 6 * * 1')
  async weeklyCron(): Promise<void> {
    const { start, end } = previousWeek(new Date());
    try {
      // Lock distribuido DENTRO de la liquidación (no acá): si otra réplica/corrida manual lo tiene,
      // el cron skipea en silencio (semántica de siempre); el lock vive donde está la sección crítica.
      const outcome = await this.runPayoutsExclusive(start, end);
      if (!outcome.acquired) return;
      const summary = outcome.result;
      this.logger.log(
        `Payouts semanales agregados: ${summary.pending} PENDING (esperan disparo del operador), ${summary.held} retenidos`,
      );
    } catch (err) {
      this.logger.error({ err }, 'Cron de payouts falló');
    }
  }

  /**
   * Corre la liquidación para un período. Idempotente por conductor+período (UNIQUE).
   * Si el operador la dispara manualmente y el total supera S/5000, exige step-up MFA fresco (BR-S07).
   * Protegida por el MISMO lock distribuido que el cron (fix auditoría: el lock vivía solo en
   * weeklyCron y una corrida manual del operador podía solaparse con el cron). Si otra liquidación
   * está en curso, la manual falla con ConflictError (409 honesto) en vez de competir.
   */
  async runPayouts(
    start: Date,
    end: Date,
    operator?: AuthenticatedUser,
  ): Promise<PayoutRunSummary> {
    const outcome = await this.runPayoutsExclusive(start, end, operator);
    if (!outcome.acquired) {
      throw new ConflictError(
        'Ya hay una liquidación de payouts en curso: reintentá cuando termine',
      );
    }
    return outcome.result;
  }

  /** Adquiere el lock de liquidación y corre; libera al terminar (una manual posterior no espera el TTL). */
  private runPayoutsExclusive(
    start: Date,
    end: Date,
    operator?: AuthenticatedUser,
  ): Promise<DistributedLockOutcome<PayoutRunSummary>> {
    return withDistributedLock(
      this.redis,
      CRON_LOCK_KEY,
      CRON_LOCK_TTL_SECONDS,
      () => this.executePayoutRun(start, end, operator),
      { releaseOnSettle: true },
    );
  }

  /**
   * #25 · Conductores con CRÉDITO pendiente (credit-back de comisión CASH revertida) que NO ganaron este período
   * → se les paga un payout STANDALONE del crédito. Devuelve solo los que su NETO (crédito − deuda PENDIENTE)
   * alcanza el mínimo liquidable; debajo del mínimo se omiten (carry-forward: el crédito PENDING espera a acumular
   * o a que el conductor vuelva a ganar). `excludeDriverIds` = los que ya entran al run por ganancia (su crédito
   * lo aplica el netting normal ahí, no acá). Agrega en la DB (groupBy), sin materializar filas.
   */
  private async collectCreditOnlyDrivers(
    excludeDriverIds: Set<string>,
  ): Promise<{ driverId: string; netCents: number }[]> {
    const creditsByDriver = await this.repo.sumPendingCreditsByDriver();
    const candidates = creditsByDriver.filter((c) => !excludeDriverIds.has(c.driverId));
    if (candidates.length === 0) return [];

    // La deuda CASH PENDIENTE se netea contra el crédito (mismo criterio que applyDebtNetting) antes del umbral.
    const debtsByDriver = await this.repo.sumPendingDebtsByDriver(candidates.map((c) => c.driverId));
    const debtByDriver = new Map(debtsByDriver.map((d) => [d.driverId, d._sum.amountCents ?? 0]));

    return candidates
      .map((c) => ({
        driverId: c.driverId,
        netCents: (c._sum.amountCents ?? 0) - (debtByDriver.get(c.driverId) ?? 0),
      }))
      .filter((c) => c.netCents >= this.minCents) // debajo del mínimo → carry-forward (el crédito sigue PENDING)
      .sort((a, b) => a.driverId.localeCompare(b.driverId));
  }

  /**
   * A2 (ADR-022 §P-A) · Netea la ganancia DIGITAL disponible del conductor contra sus deudas CASH PENDIENTES
   * (comisión de viajes en efectivo que cobró en mano), DENTRO de la tx del payout. FIFO (más viejas primero):
   * cubre deudas ENTERAS mientras alcance; la del BORDE se REDUCE (queda PENDING con el resto → carry-forward al
   * próximo período), sin partir en una fila nueva (respeta el UNIQUE(paymentId)). Devuelve el total aplicado
   * (a descontar del payout). El detalle del monto neteado queda en `Payout.debtAppliedCents` para auditoría.
   */
  private async applyDebtNetting(
    tx: PayoutTx,
    driverId: string,
    availableCents: number,
    payoutId: string,
  ): Promise<number> {
    // Créditos PENDING (comisión CASH revertida · gate MEDIA #4): la plataforma se los DEBE al conductor → se
    // SUMAN al neto (bajan `applied`, que luego se resta del bruto). Se aplican SIEMPRE — no dependen de la
    // ganancia — y agregan margen para netear deudas en la MISMA corrida. Se marcan APPLIED ligados a este payout
    // (auditoría/conciliación). Idempotencia del run: el unique (driverId, período) + el lock distribuido evitan
    // el doble-pago; acá solo se aplican los créditos PENDIENTES una vez (pasan a APPLIED).
    const credits = await this.repo.findPendingCreditsInTx(tx, driverId);
    let applied = 0;
    for (const credit of credits) {
      await this.repo.markCreditAppliedInTx(tx, credit.id, payoutId);
      applied -= credit.amountCents; // crédito (>0) baja `applied` → sube el neto (netAmount = bruto − applied)
    }

    const debts = await this.repo.findPendingDebtsInTx(tx, driverId);
    // Los créditos ya bajaron `applied` (a <=0) → suman margen a la ganancia para netear deudas este período.
    let toApply = availableCents - applied;
    for (const debt of debts) {
      if (toApply <= 0) break;
      if (toApply >= debt.amountCents) {
        // La ganancia cubre la deuda ENTERA → SETTLED, ligada a este payout (auditoría/conciliación). CAS por
        // status+monto (updateMany, no update-by-id): un refund CONCURRENTE (reverseCashDebtInTx) pudo revertir/
        // reducir esta deuda entre el findMany de arriba y este update → si count=0 la SALTAMOS (no la neteamos
        // ni la contamos), evitando el lost-update (netear una deuda ya revertida = doble-beneficio al conductor).
        const settled = await this.repo.settleDebtInTx(tx, debt.id, debt.amountCents, payoutId);
        if (settled.count === 0) continue;
        toApply -= debt.amountCents;
        applied += debt.amountCents;
      } else {
        // Cubre PARCIAL → reduce el monto de la deuda del borde (queda PENDING con el resto); lo aplicado va al
        // payout. El neteo parcial se refleja en Payout.debtAppliedCents (no se parte la fila → sin colisión de
        // UNIQUE(paymentId)). Mismo CAS por status+monto: si un refund concurrente la tocó, count=0 → la saltamos.
        const reduced = await this.repo.reduceDebtInTx(
          tx,
          debt.id,
          debt.amountCents,
          debt.amountCents - toApply,
        );
        if (reduced.count === 0) continue;
        applied += toApply;
        toApply = 0;
      }
    }
    return applied;
  }

  private async executePayoutRun(
    start: Date,
    end: Date,
    operator?: AuthenticatedUser,
  ): Promise<PayoutRunSummary> {
    const { rows, pendingIncentiveIdsByDriver } = await this.collectEarnings(start, end);
    const earners = aggregatePayouts(rows, this.minCents);

    // #25 · credit-only: conductores a los que la plataforma DEBE un DriverCredit (comisión CASH revertida) pero
    // que NO entran al run por ganancia digital. Se les crea un payout STANDALONE del crédito neto, SOLO si
    // alcanza el mínimo liquidable (debajo → carry-forward, el crédito PENDING espera). Sin esto un conductor que
    // dejó de ganar nunca cobraría lo que se le debe. amountCents=0 en el aggregate: el neto lo aporta
    // applyDebtNetting (crédito − deuda) dentro del loop; su `netCents` sí entra al projectedTotal (step-up MFA).
    const creditOnly = await this.collectCreditOnlyDrivers(new Set(earners.map((a) => a.driverId)));
    const aggregated = [
      ...earners,
      ...creditOnly.map((c) => ({
        driverId: c.driverId,
        grossCents: 0,
        commissionCents: 0,
        amountCents: 0,
      })),
    ];
    const projectedTotal =
      earners.reduce((sum, p) => sum + p.amountCents, 0) +
      creditOnly.reduce((sum, c) => sum + c.netCents, 0);

    if (operator && projectedTotal > this.stepUpCents && !this.hasFreshMfa(operator)) {
      throw new ForbiddenError(
        `Liquidación por ${projectedTotal} céntimos supera S/5000: requiere verificación MFA fresca (step-up)`,
      );
    }

    let pending = 0;
    let held = 0;
    let totalAmountCents = 0;

    // Idempotencia SIN N+1: una sola query trae los drivers YA liquidados de este período (antes era un
    // findUnique por driver DENTRO del loop → N queries). El guard DURO sigue intacto: el unique
    // (driverId, periodStart, periodEnd) + la tx de creación + el lock distribuido del run (withDistributedLock)
    // garantizan no-doble-pago aun con carrera; este SELECT solo evita re-trabajar lo ya hecho.
    const alreadyPaidDriverIds = new Set(
      await this.repo.findPaidDriverIdsForPeriod(
        start,
        end,
        aggregated.map((a) => a.driverId),
      ),
    );

    for (const agg of aggregated) {
      if (alreadyPaidDriverIds.has(agg.driverId)) continue; // idempotencia: ya liquidado este período.

      // A2 · aislar el fallo POR-CONDUCTOR: un error de UN driver (netting/tx/redis) NO debe abortar el run entero
      // — los demás conductores tienen que cobrar. El fallido NO queda marcado pagado (no se creó su Payout) → el
      // próximo run lo reintenta (self-healing). Antes, un throw acá dejaba a TODOS los siguientes sin liquidar.
      try {
        const flagged = (await this.redis.sismember(FLAGGED_DRIVERS_KEY, agg.driverId)) === 1;
        // Bonos pendientes que ESTE driver aporta a este Payout. ADR-015 §3/§D5: el cron solo AGREGA — el
        // Payout nace PENDING (o HELD), la plata NO se ha movido. El bono se LIGA al Payout (paidInPayoutId)
        // para saber qué incentivos marcar cuando el riel confirme, pero `paidAt` queda NULL hasta el
        // PROCESSED confirmado (cierra el hueco 5 "bono marcado pagado sin pagar"). El CAS `paidAt:null` en el
        // handler de confirmación garantiza no-doble-marca.
        const pendingIncentiveIds = pendingIncentiveIdsByDriver.get(agg.driverId) ?? [];
        const payoutId = uuidv7();
        const netAmountCents = await this.repo.runInTransaction(async (tx) => {
          // A2 (ADR-022 §P-A) · NETEO de la deuda CASH: el conductor cobró la comisión de sus viajes en efectivo EN
          // MANO → la debe a la plataforma. Se descuenta de su ganancia DIGITAL, DENTRO de la MISMA tx del payout
          // (atomicidad: settle-deuda ⇔ payout). El payout paga el NETO; si la deuda supera el digital, el resto
          // queda PENDING (carry-forward al próximo período). Es el flujo inverso del dinero, explícito.
          const debtAppliedCents = await this.applyDebtNetting(
            tx,
            agg.driverId,
            agg.amountCents,
            payoutId,
          );
          const netAmount = agg.amountCents - debtAppliedCents;
          await this.repo.createPayoutInTx(tx, {
            id: payoutId,
            driverId: agg.driverId,
            periodStart: start,
            periodEnd: end,
            grossCents: agg.grossCents,
            commissionCents: agg.commissionCents,
            amountCents: netAmount,
            debtAppliedCents,
            // ADR-015 §3: el cron ya NO nace PROCESSED. PENDING (a la espera del disparo del operador) o
            // HELD (review en curso). PROCESSED se alcanza SOLO cuando el riel confirma la salida del dinero.
            status: flagged ? 'HELD' : 'PENDING',
            heldReason: flagged ? HELD_REASON_REVIEW : null,
            processedAt: null,
          });
          // Ligamos los bonos al Payout (paidInPayoutId) SIN marcar paidAt: el marcado del bono se mueve al
          // handler de confirmación (PROCESSED), no al create. RC15 · el CAS filtra `paidInPayoutId:null`
          // (además de `paidAt:null`), consistente con el sweep de collectEarnings: un bono ya ligado a otro
          // payout NO se re-liga acá (defensa en profundidad — el sweep ya no lo trae, pero el guard cierra
          // cualquier otra vía de re-link).
          if (pendingIncentiveIds.length > 0) {
            await this.repo.linkIncentivesToPayoutInTx(tx, pendingIncentiveIds, payoutId);
          }
          return netAmount;
        });

        if (flagged) {
          held += 1;
        } else {
          pending += 1;
          totalAmountCents += netAmountCents;
        }
      } catch (err) {
        this.logger.error(
          `Payout del conductor ${agg.driverId} falló en el run — se continúa con el resto: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return {
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      pending,
      held,
      totalAmountCents,
    };
  }

  /* ─────────────────────── Carril de DESEMBOLSO (ADR-015 §3/§D5 · sub-lote 2b) ─────────────────────── */

  /**
   * Disparo del operador (ADR-015 D3/§5 `POST /payouts/run`): desembolsa los Payout PENDING del período.
   * El cron solo AGREGÓ (creó PENDING); acá el OPERADOR mueve la plata. Step-up MFA sobre el umbral
   * (BR-S07), espejo de runPayouts. Cada payout entra al carril `disburseOne` (PENDING → PROCESSING +
   * disburse). El resultado del riel decide: SUBMITTED/CONFIRMED → PROCESSING (espera confirmación async);
   * rechazo permanente → FAILED terminal (sin esperar). Idempotente: un 2º disparo no re-procesa los que ya
   * salieron de PENDING (assertTransition los rechaza → se cuentan como ya despachados, no error).
   */
  async disbursePendingForPeriod(
    start: Date,
    end: Date,
    operator?: AuthenticatedUser,
  ): Promise<PayoutDisburseSummary> {
    const pendingPayouts = await this.repo.findPendingPayoutsForPeriod(start, end);
    // BACKSTOP DEL GATE DE REVIEW (fix crítico · último punto antes del money-out): re-consulta el set FLAGGED en
    // el MOMENTO del desembolso. Aunque holdDriver ya retro-flippea, esto cierra la ventana entre ese flip y el
    // disparo manual del operador (días): un `driver.flagged` que llegó en el ínterin RETIENE el PENDING (→HELD,
    // transición válida) en vez de pagarlo. UN solo smembers + un updateMany batch (no N sismember por payout).
    const flaggedIds = new Set(await this.redis.smembers(FLAGGED_DRIVERS_KEY));
    const toHold = pendingPayouts.filter((p) => flaggedIds.has(p.driverId));
    const toDisburse = pendingPayouts.filter((p) => !flaggedIds.has(p.driverId));
    if (toHold.length > 0) {
      await this.repo.holdPendingPayoutsByIds(
        toHold.map((p) => p.id),
        HELD_REASON_REVIEW,
      );
      this.logger.warn(
        `Retenidos ${toHold.length} payout(s) por review tardío (driver.flagged post-agregación) en ${periodLabel(start, end)} — NO desembolsados`,
      );
    }
    // El step-up MFA se evalúa sobre el total REAL a desembolsar (ya sin los retenidos), no sobre el bruto.
    const projectedTotal = toDisburse.reduce((sum, p) => sum + p.amountCents, 0);
    if (operator && projectedTotal > this.stepUpCents && !this.hasFreshMfa(operator)) {
      throw new ForbiddenError(
        `Desembolsar ${projectedTotal} céntimos supera S/5000: requiere verificación MFA fresca (step-up)`,
      );
    }
    return this.disburseEach(toDisburse);
  }

  /**
   * Reintento del operador de un payout FALLIDO (ADR-015 §5 `POST /payouts/:id/retry` · §8 "el operador
   * reintenta"). FAILED → PROCESSING por el MISMO carril (disburseOne), idempotente por la MISMA `dedupKey`
   * (`payout-disburse:{payoutId}`): el riel NO duplica la transferencia (ADR-015 §7). Step-up MFA sobre el umbral.
   *
   * GUARD DURO DE INVARIANTE PROPIO (fix CRÍTICO doble-transferencia): SOLO un payout FAILED se reintenta. NO
   * nos apoyamos en `assertPayoutTransition` para esto: `canTransitionPayout` cortocircuita `if (from===to)
   * return true`, así que un payout YA en PROCESSING pasaría `assertTransition(PROCESSING, PROCESSING)` y el CAS
   * `where status=PROCESSING` matchearía → re-invocaría el riel (segunda transferencia mientras la primera sigue
   * en curso). El reintento es una acción del operador con su PROPIA precondición (el payout DEBE estar fallido);
   * la validamos explícita acá con un error de dominio tipado (409). PENDING/HELD tienen su propio disparo
   * (run/release), no se "reintentan"; PROCESSING ya está en curso; PROCESSED ya cobró: ninguno se reintenta.
   */
  async retryPayout(
    payoutId: string,
    operator?: AuthenticatedUser,
  ): Promise<PayoutDisburseSummary> {
    const payout = await this.repo.findPayoutById(payoutId);
    if (!payout) throw new NotFoundError(`Payout ${payoutId} no encontrado`);
    if (payout.status !== PayoutStatus.FAILED) {
      throw new ConflictError(
        `Solo un payout FALLIDO puede reintentarse (estado actual: ${payout.status}); ` +
          `PENDING/HELD se disparan con run/release, PROCESSING ya está en curso, PROCESSED ya se pagó`,
      );
    }
    if (operator && payout.amountCents > this.stepUpCents && !this.hasFreshMfa(operator)) {
      throw new ForbiddenError(
        `Reintentar ${payout.amountCents} céntimos supera S/5000: requiere verificación MFA fresca (step-up)`,
      );
    }
    this.metrics?.incPayoutDisbursement('retried');
    return this.disburseEach([payout]);
  }

  /**
   * Corre el carril de desembolso para una lista de payouts y agrega el resultado.
   *
   * RESILIENCIA POR ITEM (fix CRÍTICO batch-abortado): un fallo TRANSITORIO de UN payout (ExternalServiceError
   * del riel, que `disburseOne` PROPAGA) NO debe tumbar el lote entero — antes el `throw` se propagaba y los
   * payouts AÚN no procesados quedaban sin disparar, mientras los ya-reclamados quedaban PROCESSING sin que el
   * operador supiera cuántos salieron. Acá envolvemos CADA item en try/catch: un transitorio se REGISTRA (log +
   * el payout YA quedó PROCESSING con su dedupKey, así que el poll fallback / el reintento del operador lo
   * cierran) y el batch CONTINÚA con los demás. El resumen `{ dispatched, failed }` le dice al operador cuántos
   * entraron al riel y cuántos no — un transitorio cuenta como `failed` (no entró a PROCESSING limpio en línea),
   * igual que el rechazo permanente, pero por una causa distinta (uno es terminal, el otro reintentable).
   */
  private async disburseEach(payouts: Payout[]): Promise<PayoutDisburseSummary> {
    // GATE PRE-CLAIM DE DISPONIBILIDAD DEL RIEL (causa raíz · ADR-015 §8 "el adapter live no está"):
    // si el riel money-OUT NO puede desembolsar HOY (adapter live diferido, convenio PSP pendiente),
    // RECHAZAMOS el disparo ANTES de tocar el estado de cualquier payout. Es el punto común de los TRES
    // carriles (run → disbursePendingForPeriod, release → releaseHeldPayouts, retry → retryPayout), todos
    // pasan por acá. Antes el claim PENDING/HELD/FAILED → PROCESSING se commiteaba PRIMERO y recién después
    // `disburse()` lanzaba (live stub) → el payout quedaba PROCESSING COLGADO (el PollService no lo cierra:
    // el stub no tiene status real). Ahora: ningún payout cambia de estado, todos quedan en su origen y el
    // operador recibe un 502 honesto. Fail-fast, NO silencio, NO atasco. En sandbox isAvailable()=true → el
    // flujo corre idéntico (cero cambios de comportamiento en dev/test).
    if (payouts.length > 0 && !this.payoutGateway.isAvailable()) {
      throw new ExternalServiceError(
        'desembolso no disponible: riel money-OUT pendiente de convenio PSP (ADR-015 §8). ' +
          'Ningún payout cambió de estado; reintentá cuando el riel esté disponible',
      );
    }
    let dispatched = 0;
    let failed = 0;
    let totalAmountCents = 0;
    for (const payout of payouts) {
      let outcome: 'DISPATCHED' | 'FAILED';
      try {
        outcome = await this.disburseOne(payout);
      } catch (err) {
        // Transitorio (ExternalServiceError) u otro error en línea: el payout ya quedó PROCESSING (el claim se
        // commiteó antes de invocar el riel) → el poll/retry lo cierra. NO abortamos el lote: seguimos con los
        // demás y lo contamos como failed para que el operador vea cuántos no salieron en línea.
        const msg = err instanceof Error ? err.message : 'error';
        this.logger.warn(
          `Desembolso del payout ${payout.id} falló transitorio (queda PROCESSING para el poll/retry): ${msg}`,
        );
        failed += 1;
        continue;
      }
      if (outcome === 'DISPATCHED') {
        dispatched += 1;
        totalAmountCents += payout.amountCents;
        this.metrics?.incPayoutDisbursement('dispatched');
      } else {
        // FAILED (rechazo permanente en línea): la métrica `failed` la emite UNA sola vez la transición a FAILED
        // dentro de `applyPayoutDisbursementResult` (punto único de paso a FAILED, sea en línea o por poll/webhook)
        // — NO la dupliquemos acá. Solo agregamos al resumen del operador.
        failed += 1;
      }
    }
    // `released` = todo lo que se reclamó fuera de su estado origen (entró a PROCESSING), salga o no en línea.
    return { dispatched, failed, released: dispatched + failed, totalAmountCents };
  }

  /**
   * Carril de desembolso de UN payout: estado-origen → PROCESSING (atómico con `payout.processing` al
   * outbox), invoca `PayoutGateway.disburse` con la dedupKey financiera, y resuelve el resultado del riel:
   *  - `SUBMITTED` (async) / `CONFIRMED` (síncrono): queda PROCESSING esperando la confirmación
   *    (`applyPayoutDisbursementResult`, espejo de applyWebhookResult). [DISPATCHED]
   *  - `PayoutPermanentlyRejectedError` (4xx no-reintentable): PROCESSING → FAILED terminal (emite
   *    payout.failed). El paidAt del incentivo NO se marca. [FAILED]
   *  - `ExternalServiceError` (502 transitorio): se PROPAGA (no se traga) → el operador reintenta; el payout
   *    QUEDA en PROCESSING (la disburse se invocó). La idempotencia por dedupKey vuelve seguro el reintento.
   *
   * ATOMICIDAD estado↔evento (CLAUDE §3): la transición a PROCESSING y el `payout.processing` van en la
   * MISMA tx, con CAS por status (where status=from) para que un doble-click (2º disparo concurrente) NO
   * re-emita ni re-invoque el riel: el 2º ve count=0 y sale (NO-OP). assertTransition valida la regla.
   */
  private async disburseOne(payout: Payout): Promise<'DISPATCHED' | 'FAILED'> {
    assertPayoutTransition(payout.status, PayoutStatus.PROCESSING);
    const dedupKey = payoutDedupKey(payout.id);
    const label = periodLabel(payout.periodStart, payout.periodEnd);

    // 1. Reclamo transaccional PENDING/HELD/FAILED → PROCESSING + dedupKey + payout.processing (misma tx).
    //    CAS por status: gana UNA sola corrida; el doble-click pierde (count=0) y NO invoca el riel.
    const claimed = await this.repo.runInTransaction(async (tx) => {
      const { count } = await this.repo.casClaimPayoutProcessingInTx(
        tx,
        payout.id,
        payout.status,
        dedupKey,
      );
      if (count === 0) return false; // otra corrida ya lo reclamó (doble-click): NO-OP.
      const envelope = createEnvelope({
        eventType: 'payout.processing',
        producer: 'payment-service',
        payload: {
          payoutId: payout.id,
          driverId: payout.driverId,
          amountCents: payout.amountCents,
          period: label,
        },
      });
      await this.repo.enqueueOutbox(tx, envelope, payout.id);
      return true;
    });
    if (!claimed) return 'DISPATCHED'; // ya estaba en curso por otra corrida: idempotente, no error.

    // 2. Invoca el riel (FUERA de la tx: el desembolso es I/O externo, no debe colgar la transacción).
    try {
      const result = await this.payoutGateway.disburse({
        payoutId: payout.id,
        driverId: payout.driverId,
        amountCents: payout.amountCents,
        method: DEFAULT_PAYOUT_METHOD,
        currency: 'PEN',
      });
      // Persistimos el ref externo (correlaciona el webhook/poll de confirmación). El estado queda
      // PROCESSING: SUBMITTED espera la confirmación async; CONFIRMED síncrono lo cerramos por el MISMO
      // camino idempotente que el webhook (applyPayoutDisbursementResult) — una sola fuente de verdad.
      await this.repo.persistPayoutExternalRef(payout.id, result.externalRef);
      if (result.status === 'CONFIRMED') {
        await this.applyPayoutDisbursementResult({ payoutId: payout.id, resolution: 'CONFIRMED' });
      }
      return 'DISPATCHED';
    } catch (err) {
      if (err instanceof PayoutPermanentlyRejectedError) {
        // Rechazo PERMANENTE en línea: PROCESSING → FAILED terminal por el camino idempotente. La plata NO
        // salió; el paidAt del incentivo NO se marca. El operador puede reintentar (FAILED → PROCESSING).
        await this.applyPayoutDisbursementResult({ payoutId: payout.id, resolution: 'REJECTED' });
        this.logger.warn(`Payout ${payout.id} RECHAZADO permanente por el riel → FAILED`);
        return 'FAILED';
      }
      // Transitorio (ExternalServiceError) u otro: se PROPAGA. El payout queda PROCESSING (disburse se
      // invocó); el operador reintenta — la dedupKey vuelve seguro el reintento (el riel no duplica).
      throw err;
    }
  }

  /**
   * Handler de CONFIRMACIÓN del riel (ADR-015 §4.2 · espejo de PaymentsService.applyWebhookResult). El
   * desembolso es ASÍNCRONO: la confirmación llega por webhook/poll y este handler corre la transición
   * PROCESSING → PROCESSED | FAILED. IDEMPOTENTE:
   *  - CONFIRMED: PROCESSING → PROCESSED (emite payout.processed + marca paidAt del incentivo, todo en UNA
   *    tx atómica). Una redelivery con el payout YA PROCESSED → status-guard no-op (no re-emite, no re-marca).
   *  - REJECTED:  PROCESSING → FAILED (emite payout.failed). El paidAt NO se marca (la plata no salió).
   *  - PENDING:   no-op (el desembolso sigue en curso).
   * El status-guard (la lectura del estado actual + el CAS `where status=PROCESSING`) hace la operación
   * segura ante webhook duplicado y poll+webhook concurrentes — exactamente como applyWebhookResult.
   */
  async applyPayoutDisbursementResult(input: {
    payoutId: string;
    resolution: 'CONFIRMED' | 'REJECTED' | 'PENDING';
  }): Promise<ApplyDisbursementResult> {
    const payout = await this.repo.findPayoutById(input.payoutId);
    if (!payout) {
      this.logger.warn(`Confirmación de desembolso sin match (payoutId=${input.payoutId}); no-op`);
      return { applied: false, status: 'NO_MATCH' };
    }

    if (input.resolution === 'PENDING') return { applied: false, status: payout.status }; // sigue en curso

    if (input.resolution === 'CONFIRMED') {
      // Idempotencia: si ya está PROCESSED, una 2ª confirmación (webhook duplicado) no re-emite ni re-marca.
      if (payout.status === PayoutStatus.PROCESSED) return { applied: false, status: 'PROCESSED' };
      assertPayoutTransition(payout.status, PayoutStatus.PROCESSED);
      const label = periodLabel(payout.periodStart, payout.periodEnd);
      const ok = await this.repo.runInTransaction(async (tx) => {
        // CAS por status: gana UNA corrida; una confirmación concurrente ve count=0 y sale (no re-emite).
        const { count } = await this.repo.casMarkPayoutProcessedInTx(tx, payout.id);
        if (count === 0) return false;
        // El paidAt del incentivo se marca AQUÍ (ADR-015 §3/§D5): recién con el desembolso confirmado. CAS
        // `paidAt:null` para no re-marcar un bono ya pagado (webhook duplicado / poll+webhook).
        await this.repo.markIncentivesPaidInTx(tx, payout.id);
        const envelope = createEnvelope({
          eventType: 'payout.processed',
          producer: 'payment-service',
          payload: {
            payoutId: payout.id,
            driverId: payout.driverId,
            amountCents: payout.amountCents,
            period: label,
          },
        });
        await this.repo.enqueueOutbox(tx, envelope, payout.id);
        return true;
      });
      if (ok) {
        this.metrics?.incPayoutDisbursement('processed'); // la plata SALIÓ (señal money-OUT scrapeable)
        return { applied: true, status: 'PROCESSED' };
      }
      return { applied: false, status: 'PROCESSED' }; // carrera: otra confirmación ya lo cerró.
    }

    // REJECTED: PROCESSING → FAILED (la plata NO salió; el paidAt NO se marca).
    if (payout.status === PayoutStatus.FAILED) return { applied: false, status: 'FAILED' }; // idempotente
    assertPayoutTransition(payout.status, PayoutStatus.FAILED);
    const label = periodLabel(payout.periodStart, payout.periodEnd);
    const ok = await this.repo.runInTransaction(async (tx) => {
      const { count } = await this.repo.casMarkPayoutFailedInTx(tx, payout.id);
      if (count === 0) return false;
      const envelope = createEnvelope({
        eventType: 'payout.failed',
        producer: 'payment-service',
        payload: {
          payoutId: payout.id,
          driverId: payout.driverId,
          amountCents: payout.amountCents,
          period: label,
        },
      });
      await this.repo.enqueueOutbox(tx, envelope, payout.id);
      return true;
    });
    if (ok) {
      this.metrics?.incPayoutDisbursement('failed'); // confirmación REJECTED del riel: la plata NO salió
      return { applied: true, status: 'FAILED' };
    }
    return { applied: false, status: 'FAILED' };
  }

  listByDriver(driverId: string): Promise<unknown[]> {
    return this.repo.findPayoutsByDriver(driverId);
  }

  /**
   * Listado paginado de TODOS los payouts para el operador (admin/finance), filtrable por estado.
   * Paginación cursor por id (uuidv7 ⇒ orden temporal estable). Separado de listByDriver (anti-IDOR
   * del conductor): este lo gatea el controller con RBAC FINANCE/ADMIN, no es por-dueño.
   */
  async listAll(opts: {
    status?: PayoutStatus;
    cursor?: string;
    limit?: number;
  }): Promise<PayoutPage> {
    const limit = clampPayoutLimit(opts.limit);
    const rows = await this.repo.findPayoutsPage({
      status: opts.status,
      cursor: opts.cursor,
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? last.id : null };
  }

  /**
   * Detalle de un payout para el panel FINANCE (breakdown de auditoría). `debtAppliedCents` es el NETO firmado
   * ya persistido (deuda CASH − credit-back); acá lo ABRIMOS en sus dos componentes por las FK dedicadas
   * (`DriverCredit.appliedInPayoutId` / `DriverDebt.settledInPayoutId`) para que el waterfall muestre credit-back
   * y deuda CASH por SEPARADO. Dos `aggregate` acotados por FK (no un scan difuso por driver+período).
   */
  async getPayout(id: string): Promise<PayoutDetail> {
    const payout = await this.repo.findPayoutById(id);
    if (!payout) throw new NotFoundError('Payout no encontrado');
    const [creditBackCents, debtSettledCents, bonusCents] = await Promise.all([
      this.repo.sumAppliedCreditsForPayout(id),
      this.repo.sumSettledDebtsForPayout(id),
      // Bono de incentivo pagado en este payout (ligado por paidInPayoutId · mismo patrón acotado-por-FK).
      this.repo.sumBonusForPayout(id),
    ]);
    return {
      ...payout,
      creditBackCents,
      debtSettledCents,
      bonusCents,
    };
  }

  /**
   * "Viajes incluidos" de un payout (GET /payouts/:id/trips). RECONSTRUCCIÓN POR PERÍODO — el payout NO persiste
   * sus líneas de viaje: se cargan los Payment del conductor capturados en [periodStart, periodEnd) con la MISMA
   * condición que usa el run de liquidación (findCapturedNonCashPayments), para que la lista MATCHEE lo que se
   * agregó. NOTA HONESTA: es reconstrucción, no links persistidos — si el período de este payout se SOLAPA con
   * otro run (períodos manuales que se pisan), la lista podría diferir de lo efectivamente liquidado en esta fila.
   * Cap `PAYOUT_TRIPS_CAP` en la lista + `totalCount` para el "+N más". `amountCents` de cada viaje = su BRUTO.
   */
  async getPayoutTrips(id: string): Promise<PayoutTripsResult> {
    const payout = await this.repo.findPayoutById(id);
    if (!payout) throw new NotFoundError('Payout no encontrado');
    const [rows, totalCount] = await Promise.all([
      this.repo.findDriverCapturedPaymentsForPeriod(
        payout.driverId,
        payout.periodStart,
        payout.periodEnd,
        PAYOUT_TRIPS_CAP,
      ),
      this.repo.countDriverCapturedPaymentsForPeriod(
        payout.driverId,
        payout.periodStart,
        payout.periodEnd,
      ),
    ]);
    const trips: PayoutTrip[] = rows.map((r) => ({
      tripId: r.tripId,
      amountCents: r.grossCents, // BRUTO del viaje (el neto/comisión se agrega a nivel payout, no por línea).
      capturedAt: r.capturedAt ? r.capturedAt.toISOString() : null,
      method: r.method,
    }));
    return { trips, totalCount };
  }

  /**
   * TODAS las filas del filtro admin (sin paginar) para el export CSV server-side (el operador exporta el SET
   * COMPLETO del filtro, no solo la página cargada). Devuelve las filas Payout crudas; el admin-bff resuelve el
   * nombre (gateado por PII), formatea a soles y arma el CSV. RBAC FINANCE/ADMIN lo gatea el controller.
   */
  listAllForExport(status?: PayoutStatus): Promise<Payout[]> {
    return this.repo.findAllPayoutsForExport(status);
  }

  /**
   * KPIs de la pantalla de Liquidaciones (GET /payouts/stats): volumen total liquidado + conteos por estado.
   * UN solo `groupBy` por `status` (agrega en la DB, no materializa filas). El mapeo status→campo usa el enum
   * `PayoutStatus` (PAYOUT_STATUS_COUNT_FIELD), sin strings mágicos. `totalCents` suma el `amountCents` de TODOS
   * los estados (el NETO ya persistido en cada fila). Estados sin payouts no aparecen en el groupBy → quedan en 0.
   */
  async getStats(): Promise<PayoutStats> {
    const grouped = await this.repo.groupPayoutsByStatus();
    const stats: PayoutStats = {
      totalCents: 0,
      paidCents: 0,
      heldCents: 0,
      failedCents: 0,
      pendingCount: 0,
      processingCount: 0,
      processedCount: 0,
      heldCount: 0,
      failedCount: 0,
    };
    for (const g of grouped) {
      const sumCents = g._sum.amountCents ?? 0;
      stats.totalCents += sumCents;
      stats[PAYOUT_STATUS_COUNT_FIELD[g.status]] = g._count._all;
      // Bucket de volumen del estado (si expone uno: PROCESSED/HELD/FAILED). PENDING/PROCESSING solo suman al total.
      const centsField = PAYOUT_STATUS_CENTS_FIELD[g.status];
      if (centsField) stats[centsField] = sumCents;
    }
    return stats;
  }

  /** Retención de payouts del conductor en review (consumido desde driver.flagged). */
  async holdDriver(driverId: string): Promise<void> {
    await this.redis.sadd(FLAGGED_DRIVERS_KEY, driverId);
    // RETRO-HOLD (fix crítico): flippea a HELD los Payout PENDING YA existentes del conductor. Un `driver.flagged`
    // que llega DESPUÉS de la agregación del cron encuentra el Payout ya nacido PENDING; sin este paso, el `sadd`
    // solo evita que los FUTUROS payouts nazcan HELD, pero el PENDING vigente se desembolsaría igual al conductor
    // en review. CAS por-fila `status: PENDING` (transición PENDING→HELD válida · idempotente: no toca PROCESSING/
    // PROCESSED). Se liberan por el camino de vuelta (release) cuando el review se resuelve. El desembolso además
    // re-chequea el set (doble defensa: cierra la ventana entre este flip y el disparo manual del operador).
    await this.repo.holdPendingPayoutsByDriver(driverId, HELD_REASON_REVIEW);
  }

  /**
   * Camino de VUELTA de driver.flagged (review resuelto, acción admin): libera los payouts HELD del
   * conductor metiéndolos al CARRIL DE DESEMBOLSO (ADR-015 §3/§D5: HELD → PROCESSING, NO salta a PROCESSED)
   * y levanta su retención (srem del set de flaggeados, para que las próximas liquidaciones no nazcan HELD).
   *
   *  - Cada HELD entra a `disburseOne` (HELD → PROCESSING + payout.processing en la MISMA tx + invoca el
   *    riel). La plata sale por el MISMO riel que un PENDING disparado; PROCESSED se alcanza recién cuando el
   *    riel confirma (applyPayoutDisbursementResult). El CAS `where status=HELD` hace la liberación
   *    idempotente y concurrencia-segura: una liberación re-entrante reclama 0 y NO re-emite.
   *
   *  INVARIANTE DEL DES-FLAG (fix CRÍTICO conductor-flaggeado-para-siempre): el flag se quita cuando el HELD
   *  se LIBERÓ AL CARRIL (entró a PROCESSING, su plata YA está en el riel/poll), NO cuando el riel confirma.
   *  Antes el `srem` corría DESPUÉS de un `disburseEach` que PODÍA LANZAR ante un transitorio del riel: el
   *  throw saltaba el srem y dejaba al conductor RETENIDO PARA SIEMPRE (su payout ya en PROCESSING, pero el
   *  flag intacto → las próximas liquidaciones seguían naciendo HELD y nadie lo liberaba). Dos correcciones:
   *   1. `disburseEach` ya NO propaga el transitorio (fix per-item): el payout queda PROCESSING y el batch sigue
   *      → el srem SIEMPRE se alcanza. Un transitorio NO deja la liberación a medias.
   *   2. El srem va en su PROPIO try/catch: un hiccup de Redis no revierte una liberación ya hecha (los payouts
   *      ya están PROCESSING); se loguea y el operador puede re-liberar (idempotente, reclama 0, solo re-srem).
   *  Así: ni conductor flaggeado-para-siempre por un transitorio del riel, ni release a medias.
   *
   *  - Plata grande exige step-up MFA fresco, espejo de runPayouts (BR-S07).
   *  - `heldReason` se conserva (historia de POR QUÉ estuvo retenido); el estado vigente pasa a PROCESSING.
   *  - El audit trail del operador lo registra admin-bff (AuditRecorder, action payout.release_held); acá
   *    queda el rastro de dominio (outbox payout.processing + log estructurado).
   */
  async releaseHeldPayouts(
    driverId: string,
    operator?: AuthenticatedUser,
  ): Promise<ReleaseHeldPayoutsResult> {
    const held = await this.repo.findHeldPayoutsByDriver(driverId);
    const projectedTotal = held.reduce((sum, p) => sum + p.amountCents, 0);

    if (operator && projectedTotal > this.stepUpCents && !this.hasFreshMfa(operator)) {
      throw new ForbiddenError(
        `Liberar ${projectedTotal} céntimos retenidos supera S/5000: requiere verificación MFA fresca (step-up)`,
      );
    }

    // HELD → PROCESSING por el carril de desembolso (un payout a la vez). `disburseEach` es resiliente por
    // item: ni el rechazo permanente ni el transitorio de uno abortan la liberación de los demás. `released`
    // = los que se movieron de HELD a PROCESSING (salgan o no en línea: su plata YA está en el riel/poll).
    const { dispatched, failed, released, totalAmountCents } = await this.disburseEach(held);

    // Des-flag: se quita PORQUE los HELD se liberaron al carril (ya PROCESSING), independiente de si el riel
    // falló transitorio. En su PROPIO try/catch: un fallo de Redis NO revierte la liberación ya hecha (los
    // payouts ya están PROCESSING); se loguea y el operador re-libera (idempotente). Idempotente per-se.
    try {
      await this.redis.srem(FLAGGED_DRIVERS_KEY, driverId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'error';
      this.logger.error(
        `Conductor ${driverId}: payouts liberados (${released} HELD→PROCESSING) pero el des-flag (srem) falló: ` +
          `${msg}. Re-liberar es seguro (idempotente). El conductor podría seguir naciendo HELD hasta el srem.`,
      );
    }

    this.logger.log(
      `Retención liberada para el conductor ${driverId}: ${released} payout(s) HELD→PROCESSING ` +
        `(${dispatched} en camino por el riel, ${failed} a cerrar por poll/retry) por ${totalAmountCents} ` +
        `céntimos${operator ? ` (operador ${operator.userId})` : ''}`,
    );
    return { driverId, released, totalAmountCents };
  }

  /**
   * Junta TODO lo que el conductor cobra en el período: cobros capturados, compensación de penalidades
   * y bonos de incentivo pendientes. Devuelve también, por driver, los IncentiveProgress.id que aportan
   * cada bono, para marcarlos pagados en la MISMA tx que crea el Payout (atomicidad del marcado).
   */
  private async collectEarnings(
    start: Date,
    end: Date,
  ): Promise<{ rows: DriverEarningRow[]; pendingIncentiveIdsByDriver: Map<string, string[]> }> {
    // A2 (ADR-022 §P-A) · Cobros DIGITALES liquidados del período (excluye CASH: en un viaje cash el conductor ya
    // cobró su neto EN MANO — pagárselo otra vez por banco sería doble-pago; su comisión adeudada se NETEA aparte).
    // Incluye PARTIALLY_REFUNDED (F4: el conductor prestó el servicio, mantiene su neto). El filtro POSITIVO por
    // método + estado liquidado (que usa el índice [method,status,capturedAt]) vive CRISTALIZADO en el repo.
    const payments = await this.repo.findCapturedNonCashPayments(start, end);
    const earningRows: DriverEarningRow[] = payments
      .filter(
        (
          p,
        ): p is {
          driverId: string;
          grossCents: number;
          commissionCents: number;
          tipCents: number;
        } => p.driverId !== null,
      )
      .map((p) => ({
        driverId: p.driverId,
        grossCents: p.grossCents,
        commissionCents: p.commissionCents,
        tipCents: p.tipCents,
      }));

    // F2.3 · Compensación por penalidades de cancelación SALDADAS en el período: el conductor que esperó
    // cobra su parte del split cuando el pasajero paga. Se acredita NETA (sin comisión, no es bruto de
    // viaje). La ventana es por `collectedAt` (cuándo se saldó), no por la cancelación. driverId not null
    // y comp > 0 (una penalidad sin conductor va entera a la plataforma → no acredita a nadie).
    const penalties = await this.repo.findCollectedPenalties(start, end);
    const compensationRows: DriverEarningRow[] = penalties
      .filter(
        (p): p is { driverId: string; driverCompensationCents: number } =>
          p.driverId !== null && p.driverCompensationCents > 0,
      )
      .map((p) => ({
        driverId: p.driverId,
        grossCents: 0,
        commissionCents: 0,
        tipCents: 0,
        compensationCents: p.driverCompensationCents,
      }));

    // Bonos de incentivo CONCEDIDOS pero aún NO ligados a un Payout. El `incentive.completed` era un
    // evento huérfano: el bono se concedía en IncentiveProgress pero jamás entraba a un Payout. Acá lo
    // barremos. BACK-PAY POR ARRASTRE (decisión intencional): el filtro NO acota por `completedAt ∈
    // [start,end)` sino por `completedAt < end`. Así el primer run post-deploy paga TODOS los bonos
    // históricos completados-no-pagados.
    //
    // RC15 (ADR-022) · el guard DEBE ser `paidInPayoutId:null`, NO solo `paidAt:null`. `paidAt` se marca
    // recién en la CONFIRMACIÓN async del desembolso (applyPayoutDisbursementResult), no al ligar el bono.
    // Entre "bono ligado a Payout_A (PENDING/PROCESSING/HELD)" y "A confirmado", `paidAt` sigue null → con
    // el guard viejo, el run del PERÍODO SIGUIENTE re-barría el MISMO bono y lo metía en un Payout_B → el
    // conductor lo cobraba DOS veces (los guards duros del run son per-período: no ven el arrastre). El link
    // `paidInPayoutId` es el compromiso contable del bono a SU payout (persiste a través de retryPayout, que
    // re-desembolsa el MISMO payout): mientras esté ligado, NO es re-elegible. Un bono ligado a un payout
    // abandonado queda pendiente (sub-pago recuperable con retry), NUNCA re-pagado — el sentido correcto.
    // El guard vive en el repo: findUnpaidCompletedIncentives (lectura) y linkIncentivesToPayoutInTx (CAS de link).
    const pendingIncentives = await this.repo.findUnpaidCompletedIncentives(end);
    const pendingIncentiveIdsByDriver = new Map<string, string[]>();
    const incentiveRows: DriverEarningRow[] = pendingIncentives
      .filter((p) => p.rewardGrantedCents > 0)
      .map((p) => {
        const ids = pendingIncentiveIdsByDriver.get(p.driverId) ?? [];
        ids.push(p.id);
        pendingIncentiveIdsByDriver.set(p.driverId, ids);
        return {
          driverId: p.driverId,
          grossCents: 0,
          commissionCents: 0,
          tipCents: 0,
          incentiveCents: p.rewardGrantedCents,
        };
      });

    return {
      rows: [...earningRows, ...compensationRows, ...incentiveRows],
      pendingIncentiveIdsByDriver,
    };
  }

  private hasFreshMfa(user: AuthenticatedUser): boolean {
    if (!user.mfaVerifiedAt) return false;
    // Ventana VIGENTE de la política `auth.stepup` (cache PBAC) o el default endurecido compartido de
    // @veo/auth si no hay reader registrado — misma resolución que el StepUpMfaGuard (cero drift).
    const maxAgeSec =
      this.policy?.numberSync('auth.stepup', 'maxAgeSec', STEP_UP_DEFAULT_MAX_AGE_SEC) ??
      STEP_UP_DEFAULT_MAX_AGE_SEC;
    const ageSeconds = Math.floor(Date.now() / 1000) - user.mfaVerifiedAt;
    return ageSeconds <= maxAgeSec;
  }
}

/** Semana previa [lunes 00:00, lunes 00:00) respecto a `now` (UTC). */
export function previousWeek(now: Date): { start: Date; end: Date } {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay(); // 0=domingo..6=sábado
  const daysSinceMonday = (dow + 6) % 7;
  const thisMonday = new Date(d);
  thisMonday.setUTCDate(d.getUTCDate() - daysSinceMonday);
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  return { start: lastMonday, end: thisMonday };
}
