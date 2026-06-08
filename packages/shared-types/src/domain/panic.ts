import type { GeoPoint } from './user.js';
import type { PanicStatus } from '../enums/index.js';
export interface PanicEvent {
  id: string;
  tripId: string;
  passengerId: string;
  triggeredAt: Date;
  geoPoint: GeoPoint;
  dedupKey: string;
  status: PanicStatus;
  evidenceS3Keys: string[];
  acknowledgedAt?: Date;
  ackBy?: string;
}
