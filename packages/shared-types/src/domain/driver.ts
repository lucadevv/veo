import type { User } from './user.js';
import type { DriverStatus } from '../enums/index.js';
export interface Driver {
  id: string;
  userId: User['id'];
  licenseNumber: string;
  licenseExpiresAt: Date;
  vehicleId: string;
  currentStatus: DriverStatus;
  averageRating: number;
  totalTrips: number;
  backgroundCheckStatus: 'PENDING' | 'CLEARED' | 'FLAGGED' | 'REJECTED';
  hiredAt: Date;
  suspendedAt?: Date;
}
