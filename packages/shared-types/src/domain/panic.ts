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
  resolvedAt?: Date;
  /** Motivo opcional del cierre escrito por el operador (persistido en la entidad para display). */
  resolutionNotes?: string;
  /** Respuesta operativa (acciones laterales sobre una alerta activa; no cambian el status): despacho de
   *  unidad y/o escalación a autoridades — timestamp + operador que actuó (para display + línea de tiempo). */
  dispatchedAt?: Date;
  dispatchedBy?: string;
  escalatedAt?: Date;
  escalatedBy?: string;
}
