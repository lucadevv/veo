/**
 * FinanceService — payouts y reembolsos vía payment-service (REST interno firmado). Acciones auditadas.
 * Los payouts se mapean a payoutView de @veo/api-client.
 */
import { Injectable, Inject } from '@nestjs/common';
import { InternalRestClient } from '@veo/rpc';
import type { AuthenticatedUser } from '@veo/auth';
import type { PayoutView } from '@veo/api-client';
import { REST_PAYMENT } from '../infra/tokens';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { RunPayoutsDto, RefundDto } from './dto/finance.dto';

interface Payout {
  id: string;
  driverId: string;
  amountCents: number;
  status: string;
  periodStart: string;
  periodEnd: string;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface RunPayoutsResult {
  periodStart: string;
  periodEnd: string;
  processed: number;
  held: number;
  totalAmountCents: number;
}

@Injectable()
export class FinanceService {
  constructor(
    @Inject(REST_PAYMENT) private readonly rest: InternalRestClient,
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
      payload: { processed: res.processed, held: res.held, totalAmountCents: res.totalAmountCents },
    });
    return res;
  }

  async refund(
    identity: AuthenticatedUser,
    tripId: string,
    dto: RefundDto,
  ): Promise<{ refundId: string; paymentId: string; status: string }> {
    const res = await this.rest.post<{ refundId: string; paymentId: string; status: string }>(
      `/payments/${tripId}/refund`,
      { identity, body: { amountCents: dto.amountCents, reason: dto.reason } },
    );
    await this.audit.record(identity, {
      action: 'payment.refund',
      resourceType: 'payment',
      resourceId: res.paymentId,
      payload: { tripId, amountCents: dto.amountCents, reason: dto.reason },
    });
    return res;
  }
}

function toPayoutView(p: Payout): PayoutView {
  return {
    id: p.id,
    driverId: p.driverId,
    amountCents: p.amountCents,
    status: p.status,
    period: `${p.periodStart}..${p.periodEnd}`,
  };
}
