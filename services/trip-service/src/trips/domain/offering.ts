/**
 * ADR 013 §2 — Resolución de la OFERTA del viaje desde el input del cliente (lógica pura, sin I/O).
 *
 * Precedencia EXACTA: `category` > `vehicleType` > default económico.
 *  - `category` presente y DESCONOCIDA → 400 `UNKNOWN_OFFERING` (los ids nacen del quote del server:
 *    un id fuera del catálogo no viene de un cliente honesto). NUNCA default silencioso a económico.
 *  - `category` AUSENTE (cliente viejo: el campo es opcional) → se deriva la oferta default por
 *    `vehicleType`: MOTO → veo_moto, CAR/ausente → veo_economico (replica el comportamiento previo,
 *    pero ahora moto obtiene su política REAL de pricing en vez del multiplier efectivo 1.0 del bug).
 *  - `category` y `vehicleType` INCONSISTENTES (ej. veo_moto + CAR) → GANA la oferta
 *    (`offering.vehicleClass` es la fuente del pool de matching); `mismatch: true` para que el caller
 *    loguee warn. NO es 400: apps viejas en la calle mandan ambos y un bug de UI no debe romper el create.
 *
 * La política de pricing NO se copia acá: viene del catálogo de @veo/shared-types (fuente única, eje 2).
 */
import {
  OFFERINGS,
  OfferingId,
  VehicleClass,
  findOffering,
  type OfferingSpec,
  type VehicleType,
} from '@veo/shared-types';
import { UnknownOfferingError } from '../trips.errors';

/** Resultado de resolver la oferta del create: la oferta + si el dto era inconsistente (warn). */
export interface TripOfferingResolution {
  offering: OfferingSpec;
  /** true si `category` y `vehicleType` del dto eran inconsistentes (la oferta ganó; el caller loguea warn). */
  mismatch: boolean;
}

/**
 * Resuelve la oferta del viaje con la precedencia del ADR 013 §2. Lanza `UnknownOfferingError` (400)
 * si la categoría no existe en el catálogo.
 */
export function resolveTripOffering(
  category: string | null | undefined,
  vehicleType: VehicleType | null | undefined,
): TripOfferingResolution {
  if (category !== undefined && category !== null) {
    const offering = findOffering(category);
    if (!offering) {
      throw new UnknownOfferingError(category);
    }
    // Inconsistencia category/vehicleType: la oferta es la autoridad del pool (vehicleClass).
    const mismatch = vehicleType !== undefined && vehicleType !== null && vehicleType !== offering.vehicleClass;
    return { offering, mismatch };
  }
  // Compat cliente viejo (sin category): deriva por vehicleType — MOTO → veo_moto, CAR/ausente → económico.
  const offering =
    vehicleType === VehicleClass.MOTO ? OFFERINGS[OfferingId.VEO_MOTO] : OFFERINGS[OfferingId.VEO_ECONOMICO];
  return { offering, mismatch: false };
}
