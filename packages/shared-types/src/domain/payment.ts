import type { PaymentMethod, PaymentStatus, PayoutStatus } from '../enums/index.js';
export interface Payment {
  id: string;
  tripId: string;
  amountCents: number;
  currency: 'PEN';
  method: PaymentMethod;
  externalRef?: string;
  status: PaymentStatus;
  capturedAt?: Date;
  refundedAt?: Date;
  feeCents: number;
}

/** Liquidación semanal al conductor (BR-P05). */
export interface Payout {
  id: string;
  driverId: string;
  periodStart: Date;
  periodEnd: Date;
  grossCents: number;
  commissionCents: number;
  amountCents: number;
  currency: 'PEN';
  status: PayoutStatus;
  processedAt?: Date;
  heldReason?: string;
}
