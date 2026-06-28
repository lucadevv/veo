/**
 * FinanceService — payouts y reembolsos vía payment-service (REST interno firmado). Acciones auditadas.
 * Los payouts se mapean a payoutView de @veo/api-client.
 */
import { Injectable, Inject } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { PayoutView } from '@veo/api-client';
import { REST_PAYMENT, REST_BOOKING } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type {
  RunPayoutsDto,
  RefundDto,
  ReplaceCommissionDto,
  ReplaceCostPerKmDto,
} from './dto/finance.dto';

/** Vista de la comisión por modo (F2.7 · ADR-017 §1.6): tasa ON-DEMAND + service fee CARPOOLING (ambas bps, editables) + version. */
export interface CommissionView {
  /** Comisión ON-DEMAND en basis points Int (0..10000; 2000 = 20%) — descontada al conductor. */
  onDemandRateBps: number;
  /** Service fee CARPOOLING en basis points Int (0..10000) — sumado al pasajero (cost-sharing). */
  carpoolingFeeBps: number;
  version: number;
  updatedAt: string;
}

/** Costo/km de un país (F2.5): el costo de operación que alimenta el tope de cost-sharing + version (CAS). */
export interface CostPerKmConfigView {
  pais: string;
  costPerKmCents: number;
  version: number;
  updatedAt: string;
}

/** GET del costo/km: una fila por país (PE/EC). */
export interface CostPerKmListView {
  configs: CostPerKmConfigView[];
}

const COMMISSION_BASE = '/internal/finance/commission';
const COST_PER_KM_BASE = '/internal/finance/cost-per-km';

/** Shape interno que sirve payment-service (GET /payouts/all). `status` ES el enum Prisma `PayoutStatus`
 *  serializado tal cual (sin transformación intermedia); el contrato `payoutStatus` lo espeja 1:1.
 *  payment-service hace `findMany` SIN `select` → la fila Payout llega COMPLETA (gross/commission/neto/
 *  processedAt/heldReason ya persistidos en el modelo Prisma); el desglose es server-truth, no se recalcula.
 *  `processedAt` viaja como ISO string (Prisma `DateTime` serializado a JSON sobre el REST interno). */
interface Payout {
  id: string;
  driverId: string;
  grossCents: number;
  commissionCents: number;
  amountCents: number;
  status: PayoutView['status'];
  periodStart: string;
  periodEnd: string;
  processedAt: string | null;
  heldReason: string | null;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Resultado del disparo de la liquidación (ADR-015 §5): agrega los PENDING + DESEMBOLSA el período.
 *  `dispatched` = payouts que entraron a PROCESSING (disburse aceptado); `failed` = rechazados en línea. */
export interface RunPayoutsResult {
  periodStart: string;
  periodEnd: string;
  dispatched: number;
  failed: number;
  totalAmountCents: number;
}

/** Resultado de liberar la retención de un conductor (payouts HELD → PROCESSING, entran al desembolso). */
export interface ReleaseHeldPayoutsResult {
  driverId: string;
  released: number;
  totalAmountCents: number;
}

/** Resultado del desembolso de un payout puntual (reintento de un FALLIDO · ADR-015 §5). payment-service
 *  sirve PayoutDisburseSummary SIN periodStart/periodEnd (es por-payout, no por-período). */
export interface PayoutDisburseResult {
  dispatched: number;
  failed: number;
  totalAmountCents: number;
}

@Injectable()
export class FinanceService {
  constructor(
    @Inject(REST_PAYMENT) private readonly rest: InternalRestClient,
    // F2.5 · el costo/km del carpooling vive en booking-service (no en payment): cliente REST propio.
    @Inject(REST_BOOKING) private readonly bookingRest: InternalRestClient,
    private readonly audit: AuditRecorder,
  ) {}

  /** Listado admin de TODOS los payouts (paginado, por estado) → payoutView. payment-service gatea RBAC. */
  async listPayouts(
    identity: AuthenticatedUser,
    query: { status?: string; cursor?: string; limit?: number },
  ): Promise<Page<PayoutView>> {
    const page = await this.rest.get<Page<Payout>>('/payouts/all', {
      identity,
      query: { status: query.status, cursor: query.cursor, limit: query.limit },
    });
    return { items: page.items.map(toPayoutView), nextCursor: page.nextCursor };
  }

  async runPayouts(identity: AuthenticatedUser, dto: RunPayoutsDto): Promise<RunPayoutsResult> {
    const res = await this.rest.post<RunPayoutsResult>('/payouts/run', {
      identity,
      body: { periodStart: dto.periodStart, periodEnd: dto.periodEnd },
    });
    await this.audit.record(identity, {
      action: 'payout.run',
      resourceType: 'payout_batch',
      resourceId: `${res.periodStart}..${res.periodEnd}`,
      payload: {
        dispatched: res.dispatched,
        failed: res.failed,
        totalAmountCents: res.totalAmountCents,
      },
    });
    return res;
  }

  /**
   * Libera los payouts HELD de un conductor y levanta su retención (camino de vuelta de driver.flagged).
   * payment-service hace la transición tipada HELD→PROCESSING + emite payout.processing e invoca el riel de
   * desembolso (ADR-015 §3/§D5: liberar = desembolsar de verdad, no un flag); acá se audita la acción del
   * operador (mismo patrón que payout.run). Idempotente (re-liberar libera 0).
   */
  async releaseDriverPayouts(
    identity: AuthenticatedUser,
    driverId: string,
  ): Promise<ReleaseHeldPayoutsResult> {
    const res = await this.rest.post<ReleaseHeldPayoutsResult>(
      `/payouts/drivers/${driverId}/release`,
      { identity },
    );
    await this.audit.record(identity, {
      action: 'payout.release_held',
      resourceType: 'driver',
      resourceId: driverId,
      payload: { released: res.released, totalAmountCents: res.totalAmountCents },
    });
    return res;
  }

  /**
   * Reintenta un payout FALLIDO (ADR-015 §5): payment-service hace la transición tipada FAILED→PROCESSING y
   * RE-INVOCA el riel de desembolso. Idempotente por dedupKey (el riel NO doble-paga). Acá se audita la
   * acción del operador (mismo patrón que payout.release_held). El backend exige step-up MFA por monto.
   */
  async retryPayout(
    identity: AuthenticatedUser,
    payoutId: string,
  ): Promise<PayoutDisburseResult> {
    const res = await this.rest.post<PayoutDisburseResult>(`/payouts/${payoutId}/retry`, {
      identity,
    });
    await this.audit.record(identity, {
      action: 'payout.retry',
      resourceType: 'payout',
      resourceId: payoutId,
      payload: {
        dispatched: res.dispatched,
        failed: res.failed,
        totalAmountCents: res.totalAmountCents,
      },
    });
    return res;
  }

  /** finance:view — lee la comisión por modo vigente (comisión ON-DEMAND + service fee CARPOOLING). F2.7 */
  getCommission(identity: AuthenticatedUser): Promise<CommissionView> {
    return this.rest.get<CommissionView>(COMMISSION_BASE, { identity });
  }

  /**
   * finance:manage — reemplaza AMBAS tasas (comisión ON-DEMAND + service fee CARPOOLING). payment-service bump-ea
   * version (CAS) y emite el evento. Mutación de config financiera → auditada.
   */
  async replaceCommission(
    identity: AuthenticatedUser,
    dto: ReplaceCommissionDto,
  ): Promise<CommissionView> {
    const res = await this.rest.put<CommissionView>(COMMISSION_BASE, {
      identity,
      body: {
        onDemandRateBps: dto.onDemandRateBps,
        carpoolingFeeBps: dto.carpoolingFeeBps,
        expectedVersion: dto.expectedVersion,
      },
    });
    await this.audit.record(identity, {
      action: 'finance.commission_replace',
      resourceType: 'commission_config',
      resourceId: String(res.version),
      payload: {
        onDemandRateBps: dto.onDemandRateBps,
        carpoolingFeeBps: dto.carpoolingFeeBps,
        version: res.version,
      },
    });
    return res;
  }

  /** finance:view — lee el costo/km vigente por país (PE/EC) desde booking-service. F2.5 */
  getCostPerKm(identity: AuthenticatedUser): Promise<CostPerKmListView> {
    return this.bookingRest.get<CostPerKmListView>(COST_PER_KM_BASE, { identity });
  }

  /**
   * finance:manage — reemplaza el costo/km de UN país. booking-service bump-ea version (CAS) y autoaplica
   * (cache). Mutación de config del escudo legal anti-lucro → auditada (Ley 29733).
   */
  async replaceCostPerKm(
    identity: AuthenticatedUser,
    dto: ReplaceCostPerKmDto,
  ): Promise<CostPerKmConfigView> {
    const res = await this.bookingRest.put<CostPerKmConfigView>(COST_PER_KM_BASE, {
      identity,
      body: { pais: dto.pais, costPerKmCents: dto.costPerKmCents, expectedVersion: dto.expectedVersion },
    });
    await this.audit.record(identity, {
      action: 'finance.cost_per_km_replace',
      resourceType: 'cost_per_km_config',
      resourceId: res.pais,
      payload: { pais: res.pais, costPerKmCents: res.costPerKmCents, version: res.version },
    });
    return res;
  }

  async refund(
    identity: AuthenticatedUser,
    tripId: string,
    dto: RefundDto,
    idempotencyKey?: string,
  ): Promise<{ refundId: string; paymentId: string; status: string }> {
    const res = await this.rest.post<{ refundId: string; paymentId: string; status: string }>(
      `/payments/${tripId}/refund`,
      // El Idempotency-Key del operador se PROPAGA al servicio dueño del dato (no muere acá): un reintento /
      // doble-submit con el mismo key NO doble-reembolsa (UNIQUE parcial en Refund).
      {
        identity,
        body: { amountCents: dto.amountCents, reason: dto.reason, forceNew: dto.forceNew ?? false },
        idempotencyKey,
      },
    );
    await this.audit.record(identity, {
      action: 'payment.refund',
      resourceType: 'payment',
      resourceId: res.paymentId,
      payload: { tripId, amountCents: dto.amountCents, reason: dto.reason, forceNew: dto.forceNew ?? false },
    });
    return res;
  }
}

// Desglose completo al panel FINANCE (ADR-015 D6 / hueco #4): NO se descarta gross/commission/processedAt/
// heldReason que payment-service ya sirve. `amountCents` queda = NETO (paridad con la app del conductor).
function toPayoutView(p: Payout): PayoutView {
  return {
    id: p.id,
    driverId: p.driverId,
    grossCents: p.grossCents,
    commissionCents: p.commissionCents,
    amountCents: p.amountCents,
    status: p.status,
    period: `${p.periodStart}..${p.periodEnd}`,
    processedAt: p.processedAt,
    heldReason: p.heldReason,
  };
}
