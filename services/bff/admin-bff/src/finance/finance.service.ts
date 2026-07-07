/**
 * FinanceService — payouts y reembolsos vía payment-service (REST interno firmado). Acciones auditadas.
 * Los payouts se mapean a payoutView de @veo/api-client.
 */
import { Injectable, Inject } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type {
  PayoutView,
  PayoutDetailView,
  CommissionView,
  CostPerKmConfigView,
  CostPerKmListView,
  RefundablePaymentView,
  ReconciliationRunView,
} from '@veo/api-client';
import { REST_PAYMENT, REST_BOOKING } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type {
  RunPayoutsDto,
  RefundDto,
  ReplaceCommissionDto,
  ReplaceCostPerKmDto,
} from './dto/finance.dto';

// Contratos de comisión + costo/km: FUENTE ÚNICA en @veo/api-client (el MISMO zod schema que valida el
// admin-web). Antes re-declarados acá como interfaces (double-source con el contrato — el `pais` local era
// `string`, el canónico es `'PE'|'EC'`) → ahora importados de api-client (arriba) y re-exportados para que
// el finance.controller los siga tomando de este módulo, sin duplicar la forma.
export type { CommissionView, CostPerKmConfigView, CostPerKmListView };

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

/** Fila del DETALLE de un payout (GET /payouts/:id): la fila completa + el desglose del netting que
 *  payment-service abre por FK (credit-back y deuda CASH ligados a este payout). Additive sobre `Payout`. */
interface PayoutDetailRow extends Payout {
  debtAppliedCents: number;
  dedupKey: string | null;
  externalRef: string | null;
  createdAt: string;
  creditBackCents: number;
  debtSettledCents: number;
}

/** Fila cruda del Payment que sirve payment-service (GET /payments/by-trip/:tripId, SIN `select` → fila
 *  completa). Solo declaramos los campos que el mapper consume; la PII de riel (externalRef/payerRef/
 *  externalUid/checkoutUrl/qr/cip) llega pero NUNCA se propaga al admin-web (se recorta en el mapper). */
interface PaymentRow {
  id: string;
  tripId: string;
  driverId: string | null;
  passengerId: string | null;
  method: RefundablePaymentView['method'];
  status: RefundablePaymentView['status'];
  currency: string;
  grossCents: number;
  amountCents: number;
  refundedCents: number;
  discountCents: number;
  creditCents: number;
  tipCents: number;
  capturedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
}

/** Fila cruda de una corrida de conciliación (GET /reconciliation) que sirve payment-service: el model delgado
 *  `ReconciliationRun` con el `details` Json opaco. El aplanado a la view tipada se hace en el mapper. */
interface ReconRow {
  id: string;
  ranAt: string;
  discrepancyPct: number;
  alerted: boolean;
  details: {
    periodStart?: string;
    periodEnd?: string;
    dbTotalCents?: number;
    statementTotalCents?: number;
    dbCount?: number;
    statementCount?: number;
  } | null;
  createdAt: string;
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

  /**
   * El cobro REEMBOLSABLE de un viaje (GET /payments/by-trip/:tripId en payment-service), para que el operador
   * lo INSPECCIONE antes de reembolsar: es EXACTAMENTE el pago que `refund` tocaría. Es lectura de PII (ids de
   * personas + montos) → se AUDITA el acceso (`payment.view_by_trip`, fail-closed) tras el gate FINANCE del
   * controller. El shaping recorta la PII de riel; el admin-web nunca ve externalRef/payerRef/uid/checkout.
   */
  async getPaymentByTrip(
    identity: AuthenticatedUser,
    tripId: string,
  ): Promise<RefundablePaymentView> {
    const row = await this.rest.get<PaymentRow>(`/payments/by-trip/${tripId}`, { identity });
    const view = toRefundablePaymentView(row);
    await this.audit.record(identity, {
      action: 'payment.view_by_trip',
      resourceType: 'payment',
      resourceId: view.paymentId,
      payload: { tripId },
    });
    return view;
  }

  /**
   * Detalle de un payout para el panel FINANCE (breakdown de auditoría: deuda CASH y credit-back neteados por
   * FK, + traza del desembolso). Es lectura de los montos del PROPIO conductor (no PII de un tercero) → gate
   * `@Roles` de clase, SIN step-up y SIN audit — espeja `listPayouts`, NO `getPaymentByTrip` (que audita por la
   * PII de riel del pasajero). El desglose lo abre payment-service por FK; acá solo se mapea.
   */
  async getPayoutDetail(
    identity: AuthenticatedUser,
    payoutId: string,
  ): Promise<PayoutDetailView> {
    const row = await this.rest.get<PayoutDetailRow>(`/payouts/${payoutId}`, { identity });
    return toPayoutDetailView(row);
  }

  /**
   * Historial paginado de corridas de conciliación (BR-P07) para el panel FINANCE. Cierra el hueco #3: el
   * `ReconciliationRun` lo puebla el cron pero no estaba expuesto al admin. Es data AGREGADA del sistema (no
   * PII de una persona) → gate `@Roles` de clase, SIN step-up y SIN audit (espeja listPayouts/getPayoutDetail).
   */
  async getReconciliation(
    identity: AuthenticatedUser,
    query: { cursor?: string; limit?: number },
  ): Promise<Page<ReconciliationRunView>> {
    const page = await this.rest.get<Page<ReconRow>>('/reconciliation', {
      identity,
      query: { cursor: query.cursor, limit: query.limit },
    });
    return { items: page.items.map(toReconciliationRunView), nextCursor: page.nextCursor };
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

// Extiende toPayoutView con el breakdown de auditoría (DRY: reusa el mapeo base). `debtAppliedCents` es el NETO
// firmado ya persistido; `debtSettledCents`/`creditBackCents` son sus componentes abiertos por FK en el servicio.
function toPayoutDetailView(p: PayoutDetailRow): PayoutDetailView {
  return {
    ...toPayoutView(p),
    debtSettledCents: p.debtSettledCents,
    creditBackCents: p.creditBackCents,
    debtAppliedCents: p.debtAppliedCents,
    dedupKey: p.dedupKey,
    externalRef: p.externalRef,
    createdAt: p.createdAt,
  };
}

// Aplana el `details` Json de la corrida a la view tipada. Corridas viejas sin details → period null + 0s
// (degradación honesta: nunca inventamos montos). `discrepancyPct`/`alerted` viven en columnas propias.
function toReconciliationRunView(r: ReconRow): ReconciliationRunView {
  const d = r.details ?? {};
  return {
    id: r.id,
    ranAt: r.ranAt,
    discrepancyPct: r.discrepancyPct,
    alerted: r.alerted,
    periodStart: d.periodStart ?? null,
    periodEnd: d.periodEnd ?? null,
    dbTotalCents: d.dbTotalCents ?? 0,
    statementTotalCents: d.statementTotalCents ?? 0,
    dbCount: d.dbCount ?? 0,
    statementCount: d.statementCount ?? 0,
  };
}

// Recorta a lo que la pantalla de reembolso necesita, DESCARTANDO la PII de riel (externalRef/payerRef/
// externalUid/checkoutUrl/qr/cip nunca viajan al admin-web). `refundableCents` = saldo aún reembolsable
// (amount − ya reembolsado), clamp a 0 por si un dato viejo tuviera refunded > amount (nunca negativo).
function toRefundablePaymentView(p: PaymentRow): RefundablePaymentView {
  return {
    paymentId: p.id,
    tripId: p.tripId,
    driverId: p.driverId,
    passengerId: p.passengerId,
    method: p.method,
    status: p.status,
    currency: p.currency,
    grossCents: p.grossCents,
    amountCents: p.amountCents,
    refundedCents: p.refundedCents,
    refundableCents: Math.max(0, p.amountCents - p.refundedCents),
    discountCents: p.discountCents,
    creditCents: p.creditCents,
    tipCents: p.tipCents,
    capturedAt: p.capturedAt,
    refundedAt: p.refundedAt,
    createdAt: p.createdAt,
  };
}
