import type { FleetDocumentType, FleetDocumentStatus } from '../enums/index.js';

/** Documento de conductor o vehículo con vencimiento (BR-I04, BR-D04). */
export interface FleetDocument {
  id: string;
  ownerType: 'DRIVER' | 'VEHICLE';
  ownerId: string;
  type: FleetDocumentType;
  documentNumber: string;
  issuedAt?: Date;
  expiresAt?: Date;
  fileS3Key?: string;
  status: FleetDocumentStatus;
  verifiedAt?: Date;
  verifiedBy?: string;
}

/** Inspección técnica trimestral del vehículo (BR-D04). */
export interface Inspection {
  id: string;
  vehicleId: string;
  inspectorId: string;
  inspectedAt: Date;
  passed: boolean;
  notes?: string;
  nextDueAt: Date;
}
