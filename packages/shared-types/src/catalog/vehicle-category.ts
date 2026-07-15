/**
 * MAPA TIPADO de la categoría vehicular MTC (impresa en la tarjeta de propiedad / TIVe) al `VehicleType`
 * del dominio de flota. La categoría MTC peruana es un código `[LMNO]\d[A-Z]*`:
 *  - `L1..L7`  → vehículos menores (motos, mototaxis)  → `MOTO`.
 *  - `M1`      → automóvil de pasajeros (≤ 8 asientos)  → `CAR`.
 *  - Resto (`N1` furgón, `M2`/`M3` buses, especiales `*SC` ambulancia, etc.) → NO soportado HOY.
 *
 * FUENTE ÚNICA COMPARTIDA: vive en `@veo/shared-types` para que la TARJETA DE PROPIEDAD sea la fuente de
 * verdad del tipo TANTO en el cliente (prellenado del alta) COMO en el backend (derivación server-authoritative
 * en fleet-service: la categoría manda, el `vehicleType` del body es solo un HINT/fallback).
 *
 * DEGRADACIÓN HONESTA: el enum `VehicleType` HOY solo tiene `CAR | MOTO`. Para las categorías que no caen en
 * esos dos tiers NO se inventa un valor de enum → se devuelve `null` y el flujo de alta cae a SELECCIÓN MANUAL.
 * Furgón (`N1`), buses (`M2`/`M3`) y especiales (`*SC` ambulancia, etc.) requieren AMPLIAR el enum `VehicleType`
 * (lote futuro); hasta entonces, `null` es la respuesta correcta.
 */

import { VehicleType } from '../enums/index.js';

/**
 * Clases de categoría MTC (la primera letra del código, D.S. 058-2003-MTC): `L` vehículos menores
 * (motos/mototaxis), `M` transporte de pasajeros, `N` transporte de carga, `O` remolques. Tipadas para
 * NO comparar contra literales sueltos.
 */
const MtcClass = {
  MINOR: 'L',
  PASSENGER: 'M',
  CARGO: 'N',
  TRAILER: 'O',
} as const;

/** Subclase del auto de pasajeros estándar dentro de la clase `M`: `M1` (≤ 8 asientos). */
const PASSENGER_CAR_SUBCLASS = '1';

/** Patrón del código de categoría MTC: una letra de clase `[LMNO]`, un dígito de subclase y sufijos. */
const MTC_CATEGORY_PATTERN = /^([LMNO])(\d)([A-Z]*)$/;

/**
 * Mapea el código de categoría MTC crudo (`M1`, `L3`, `N1`, `M1SC`…) a un `VehicleType` tipado, o `null`
 * si la categoría no tiene un tier soportado hoy (degradación honesta → selección manual en el alta).
 *
 *  - `M1` (auto de pasajeros, sin sufijo especial) → `CAR`.
 *  - `L*`  (vehículos menores: motos/mototaxis)     → `MOTO`.
 *  - `M1SC`/`N*`/`M2`/`M3`/… → `null` (no soportado: ampliar el enum en un lote futuro).
 *
 * Tolera espacios y minúsculas del OCR. Un código que no calza el patrón `[LMNO]\d[A-Z]*` → `null`.
 */
export function mapMtcCategoryToVehicleType(raw: string): VehicleType | null {
  const code = raw.toUpperCase().replace(/\s+/g, '');
  const match = MTC_CATEGORY_PATTERN.exec(code);
  if (!match) {
    return null;
  }
  const [, klass, subclass, suffix] = match;
  // Combinación especial (sufijo `SA`..`SG`: ambulancia, funerario, bomberos…): nunca es un tier de
  // pasajeros, aunque la clase base sea M1. Degradación honesta → manual.
  const isSpecialCombination = (suffix?.length ?? 0) > 0;
  if (isSpecialCombination) {
    return null;
  }
  // Vehículos menores: cualquier clase L (L1..L7) es MOTO.
  if (klass === MtcClass.MINOR) {
    return VehicleType.MOTO;
  }
  // Auto de pasajeros estándar: M1 sin sufijo especial.
  if (klass === MtcClass.PASSENGER && subclass === PASSENGER_CAR_SUBCLASS) {
    return VehicleType.CAR;
  }
  // N1 (furgón), M2/M3 (buses), etc.: aún no hay tier → manual (ampliar enum a futuro).
  return null;
}
