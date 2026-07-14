/**
 * Ganancias del conductor. Agrega los payouts REALES del conductor autenticado (payment-service,
 * GET /payouts?driverId=) en un resumen para la pantalla de ingresos. Sin mocks: los totales se
 * calculan sobre los registros de liquidación reales. Montos en céntimos PEN.
 * El driverId se resuelve desde el userId vía identity (GetDriverByUser); el cliente no lo provee.
 */
import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import type {
  DriverDailyEarnings,
  DriverEarningsBreakdown,
  DriverEarningsDailySeries,
  DriverEarningsSummary,
  DriverPayoutView,
  EarningsSummary,
  PaymentView,
} from '@veo/api-client';
import { GrpcGateway } from '../infra/grpc.gateway';
import { RestGateway } from '../infra/rest.gateway';
import type { DriverReply } from '../common/grpc-replies';
import { dayWindow, monthWindow, weekDailyWindows, weekWindow } from './earnings.windows';
import type { SettleDebtDto } from './dto/settle-debt.dto';

/** Estado de un payout liquidado (pagado al conductor). El resto se considera pendiente. */
const PAID_STATUS = 'PROCESSED';

/**
 * Tasa de comisión ON-DEMAND VIGENTE (panel admin, payment-service `commission_config`). El app la usa
 * para el desglose bruto − comisión de TripComplete/TripDetail — nunca un hardcode local.
 */
export interface DriverCommissionRateView {
  /** Tasa en basis points Int (2000 = 20%). */
  onDemandRateBps: number;
  /** Version del CAS del panel (trazabilidad de qué config estaba vigente). */
  version: number;
}

/**
 * TTL del cache in-proc de la tasa de comisión. Corto: un cambio del panel se ve en ≤60 s en el app
 * (payment-service ya cachea server-side con COMMISSION_CACHE_TTL_MS; esto solo evita un round-trip por
 * cada cierre de viaje de cada conductor).
 */
const COMMISSION_RATE_CACHE_TTL_MS = 60_000;

/**
 * Balance pendiente del conductor (payment-service, endpoint mínimo driver-rail
 * GET /internal/finance/driver-balance/pending): devengado digital del período ABIERTO + deuda/crédito
 * PENDING. Es el insumo del `pendingNetCents` honesto del summary.
 */
export interface DriverPendingBalanceView {
  /** Neto digital (gross − commission + tips) devengado después del último período agregado en Payout. */
  openNetCents: number;
  /** Deuda CASH PENDING (comisión de viajes en efectivo cobrados en mano). */
  pendingDebtCents: number;
  /** Crédito PENDING a favor (credit-back de comisión CASH revertida). */
  pendingCreditCents: number;
}

@Injectable()
export class EarningsService {
  /** Cache de UN slot COMPARTIDO entre conductores a propósito: la tasa es config GLOBAL, sin dato per-driver. */
  private commissionRateCache: { value: DriverCommissionRateView; expiresAt: number } | null = null;

  constructor(
    private readonly grpc: GrpcGateway,
    private readonly rest: RestGateway,
  ) {}

  /**
   * Tasa de comisión ON-DEMAND vigente, leída del endpoint mínimo driver-rail de payment-service.
   * NO resuelve driverId (no hace falta: es config global, no un recurso del conductor); la identidad
   * solo viaja firmada para el HMAC interno. `nowMs` parametrizable para tests del TTL.
   */
  async commissionRate(
    identity: AuthenticatedUser,
    nowMs = Date.now(),
  ): Promise<DriverCommissionRateView> {
    if (this.commissionRateCache && this.commissionRateCache.expiresAt > nowMs) {
      return this.commissionRateCache.value;
    }
    const value = await this.rest
      .client('payment')
      .get<DriverCommissionRateView>('/internal/finance/commission/on-demand-rate', { identity });
    this.commissionRateCache = { value, expiresAt: nowMs + COMMISSION_RATE_CACHE_TTL_MS };
    return value;
  }

  /** Lista cruda de payouts del conductor autenticado. */
  async listPayouts(identity: AuthenticatedUser): Promise<DriverPayoutView[]> {
    const { identity: signedIdentity, driverId } = await this.resolveDriver(identity);
    return this.rest
      .client('payouts')
      .get<DriverPayoutView[]>('/payouts', { identity: signedIdentity, query: { driverId } });
  }

  /**
   * Resumen agregado de ganancias del conductor autenticado. "Por liquidar" HONESTO:
   *
   *   pendingNetCents = max(0, openNetCents                      — devengado digital del período ABIERTO
   *                          + Σ amountCents de payouts NO pagados — agregados que aún no salieron (≠ PROCESSED)
   *                          + pendingCreditCents                 — crédito PENDING a favor (se suma al netear)
   *                          − pendingDebtCents)                  — deuda CASH PENDING (se descuenta al netear)
   *
   * Es "la plata que te va a caer". Antes era solo `totalNet − paid` sobre filas Payout, que nacen recién
   * con el cron del lunes → el conductor veía S/0 toda la semana abierta aunque hubiera devengado digital.
   * Sin doble conteo: los payouts ya agregados netearon SU deuda al crearse (esas filas quedaron SETTLED);
   * acá solo se resta la deuda aún PENDING, que el próximo run neteará contra el devengado abierto. Piso 0:
   * si la deuda supera todo, al conductor no se le cobra (carry-forward al próximo período), no debe ver
   * un "por liquidar" negativo.
   */
  async summary(identity: AuthenticatedUser): Promise<EarningsSummary> {
    const { identity: signedIdentity, driverId } = await this.resolveDriver(identity);
    const [payouts, balance] = await Promise.all([
      this.rest
        .client('payouts')
        .get<DriverPayoutView[]>('/payouts', { identity: signedIdentity, query: { driverId } }),
      this.rest
        .client('payment')
        .get<DriverPendingBalanceView>('/internal/finance/driver-balance/pending', {
          identity: signedIdentity,
          query: { driverId },
        }),
    ]);

    let totalGrossCents = 0;
    let totalCommissionCents = 0;
    let totalNetCents = 0;
    let paidNetCents = 0;
    for (const p of payouts) {
      totalGrossCents += p.grossCents;
      totalCommissionCents += p.commissionCents;
      totalNetCents += p.amountCents;
      if (p.status === PAID_STATUS) paidNetCents += p.amountCents;
    }
    // Payouts agregados y aún no pagados (PENDING/PROCESSING/HELD/FAILED): siguen adeudados al conductor.
    const unpaidPayoutNetCents = totalNetCents - paidNetCents;
    const pendingNetCents = Math.max(
      0,
      balance.openNetCents +
        unpaidPayoutNetCents +
        balance.pendingCreditCents -
        balance.pendingDebtCents,
    );

    return {
      driverId,
      currency: payouts[0]?.currency ?? 'PEN',
      payoutCount: payouts.length,
      totalGrossCents,
      totalCommissionCents,
      totalNetCents,
      paidNetCents,
      pendingNetCents,
      openNetCents: balance.openNetCents,
      pendingDebtCents: balance.pendingDebtCents,
      payouts,
    };
  }

  /**
   * ADR-022 §P-A · SALDAR la deuda de comisiones del conductor por sus viajes en EFECTIVO — la ÚNICA forma
   * de desbloquearse tras cruzar el tope. PROXY del riel del conductor hacia payment-service
   * (`POST /internal/finance/driver-debt/settle`): resuelve el driverId del conductor autenticado y lo FIRMA
   * en la identidad interna (HMAC) + lo pone en el body (payment lo revalida contra la identidad firmada →
   * anti-IDOR: un conductor solo salda SU deuda). Devuelve el Payment de LIQUIDACIÓN con el checkout
   * (deepLink/QR/urlPay/CIP) igual que un cobro del pasajero; PENDING hasta que el webhook/poll capture.
   * Idempotente aguas abajo (re-llamar devuelve el mismo Payment). CASH ya lo bloqueó el DTO (400); sin
   * deuda pendiente → 409 desde payment.
   */
  async settleDebt(identity: AuthenticatedUser, dto: SettleDebtDto): Promise<PaymentView> {
    const { identity: signedIdentity, driverId } = await this.resolveDriver(identity);
    return this.rest.client('payment').post<PaymentView>('/internal/finance/driver-debt/settle', {
      identity: signedIdentity,
      body: { driverId, method: dto.method, payerRef: dto.payerRef },
    });
  }

  /**
   * Desglose de ganancias HOY y de la SEMANA del conductor autenticado (BR-P05): bruto, comisión,
   * propinas, neto y nº de viajes. Los montos se agregan en payment-service sobre cobros CAPTURED
   * reales (sin mocks); aquí solo se delega por ventana. `now` parametrizable para tests.
   */
  async breakdown(identity: AuthenticatedUser, now = new Date()): Promise<DriverEarningsSummary> {
    const { identity: signedIdentity, driverId } = await this.resolveDriver(identity);
    const today = dayWindow(now);
    const week = weekWindow(now);
    const month = monthWindow(now);
    const client = this.rest.client('payment');
    const query = (from: Date, to: Date): Promise<DriverEarningsBreakdown> =>
      client.get<DriverEarningsBreakdown>('/payments/earnings', {
        identity: signedIdentity,
        query: { driverId, from: from.toISOString(), to: to.toISOString() },
      });
    const [todayBreakdown, weekBreakdown, monthBreakdown] = await Promise.all([
      query(today.start, today.end),
      query(week.start, week.end),
      query(month.start, month.end),
    ]);
    return {
      driverId,
      currency: 'PEN',
      today: todayBreakdown,
      week: weekBreakdown,
      month: monthBreakdown,
    };
  }

  /**
   * Serie diaria de ganancias de la SEMANA en curso (lunes→domingo, EXACTAMENTE 7 puntos) del
   * conductor autenticado, para el bar chart de la pantalla de ingresos. Una llamada a
   * payment-service por día natural (7 en paralelo); días sin viajes vuelven en cero. `now`
   * parametrizable para tests.
   */
  async daily(identity: AuthenticatedUser, now = new Date()): Promise<DriverEarningsDailySeries> {
    const { identity: signedIdentity, driverId } = await this.resolveDriver(identity);
    const client = this.rest.client('payment');
    const windows = weekDailyWindows(now);
    const days = await Promise.all(
      windows.map(async ({ start, end }): Promise<DriverDailyEarnings> => {
        const breakdown = await client.get<DriverEarningsBreakdown>('/payments/earnings', {
          identity: signedIdentity,
          query: { driverId, from: start.toISOString(), to: end.toISOString() },
        });
        return {
          // YYYY-MM-DD del día de LIMA: start es medianoche Lima = 05:00Z del MISMO día calendario.
          date: start.toISOString().slice(0, 10),
          netCents: breakdown.netCents,
          tripCount: breakdown.tripCount,
        };
      }),
    );
    return { driverId, currency: 'PEN', days };
  }

  /**
   * Resuelve el driverId del usuario autenticado vía identity (GetDriverByUser) y lo adjunta a la
   * identidad propagada. Así el RestGateway lo firma (HMAC) en la identidad interna y los servicios
   * downstream pueden verificar propiedad sin confiar en un driverId arbitrario del query (anti-IDOR).
   */
  private async resolveDriver(
    identity: AuthenticatedUser,
  ): Promise<{ identity: AuthenticatedUser; driverId: string }> {
    const driver = await this.grpc.call<DriverReply>(
      'identity',
      'GetDriverByUser',
      { id: identity.userId },
      identity,
    );
    if (!driver.found)
      throw new NotFoundError('No existe un perfil de conductor para este usuario');
    return { identity: { ...identity, driverId: driver.id }, driverId: driver.id };
  }
}
