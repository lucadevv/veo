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
} from '@veo/api-client';
import { GrpcGateway } from '../infra/grpc.gateway';
import { RestGateway } from '../infra/rest.gateway';
import type { DriverReply } from '../common/grpc-replies';
import { dayWindow, monthWindow, weekDailyWindows, weekWindow } from './earnings.windows';

/** Estado de un payout liquidado (pagado al conductor). El resto se considera pendiente. */
const PAID_STATUS = 'PROCESSED';

@Injectable()
export class EarningsService {
  constructor(
    private readonly grpc: GrpcGateway,
    private readonly rest: RestGateway,
  ) {}

  /** Lista cruda de payouts del conductor autenticado. */
  async listPayouts(identity: AuthenticatedUser): Promise<DriverPayoutView[]> {
    const { identity: signedIdentity, driverId } = await this.resolveDriver(identity);
    return this.rest
      .client('payouts')
      .get<DriverPayoutView[]>('/payouts', { identity: signedIdentity, query: { driverId } });
  }

  /** Resumen agregado de ganancias del conductor autenticado. */
  async summary(identity: AuthenticatedUser): Promise<EarningsSummary> {
    const { identity: signedIdentity, driverId } = await this.resolveDriver(identity);
    const payouts = await this.rest
      .client('payouts')
      .get<DriverPayoutView[]>('/payouts', { identity: signedIdentity, query: { driverId } });

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

    return {
      driverId,
      currency: payouts[0]?.currency ?? 'PEN',
      payoutCount: payouts.length,
      totalGrossCents,
      totalCommissionCents,
      totalNetCents,
      paidNetCents,
      pendingNetCents: totalNetCents - paidNetCents,
      payouts,
    };
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
