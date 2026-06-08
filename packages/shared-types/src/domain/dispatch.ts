import type { DispatchOutcome } from '../enums/index.js';

/** Oferta de viaje a un conductor durante el matching (BR-T06). */
export interface DispatchMatch {
  id: string;
  tripId: string;
  driverId: string;
  score: number;
  attempt: number;
  offeredAt: Date;
  respondedAt?: Date;
  outcome: DispatchOutcome;
}
