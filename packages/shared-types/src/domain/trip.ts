import type { GeoPoint } from './user.js';
import type { TripStatus, PaymentMethod } from '../enums/index.js';
export interface Trip {
  id: string;
  passengerId: string;
  driverId?: string;
  vehicleId?: string;
  origin: GeoPoint;
  destination: GeoPoint;
  requestedAt: Date;
  assignedAt?: Date;
  acceptedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  fareCents: number;
  currency: 'PEN';
  paymentMethod: PaymentMethod;
  status: TripStatus;
  routePolyline?: string;
  childMode: boolean;
  childCodeHash?: string;
}
