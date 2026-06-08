export interface Vehicle {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  color: string;
  docStatus: 'OK' | 'EXPIRING_SOON' | 'EXPIRED';
  insuranceExpiresAt: Date;
  fleetId: string;
}
