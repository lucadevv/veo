/**
 * MAPA TIPADO de la categoría vehicular MTC (impresa en la tarjeta de propiedad / TIVe) al `VehicleType`
 * del dominio de flota. La categoría MTC peruana es un código `[LMNO]\d[A-Z]*`:
 *  - `L1..L7`  → vehículos menores (motos, mototaxis)  → `MOTO`.
 *  - `M1`      → automóvil de pasajeros (≤ 8 asientos)  → `CAR`.
 *  - Resto (`N1` furgón, `M2`/`M3` buses, especiales `*SC` ambulancia, etc.) → NO soportado HOY.
 *
 * DEGRADACIÓN HONESTA: el enum `VehicleType` de `@veo/shared-types` HOY solo tiene `CAR | MOTO`. Para las
 * categorías que no caen en esos dos tiers NO se inventa un valor de enum → se devuelve `null` y el flujo
 * de alta cae a SELECCIÓN MANUAL. Furgón (`N1`), buses (`M2`/`M3`) y especiales (`*SC` ambulancia, etc.)
 * requieren AMPLIAR el enum `VehicleType` (lote futuro); hasta entonces, `null` es la respuesta correcta.
 */

import { VehicleType } from '@veo/shared-types';

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
  // Vehículos menores: cualquier clase L (L1..L7) es MOTO.
  if (klass === 'L') {
    return VehicleType.MOTO;
  }
  // Auto de pasajeros estándar: M1 SIN sufijo especial (M1SC = especial → no soportado).
  if (klass === 'M' && subclass === '1' && (suffix === undefined || suffix.length === 0)) {
    return VehicleType.CAR;
  }
  // N1 (furgón), M2/M3 (buses), especiales (*SC), etc.: aún no hay tier → manual (ampliar enum a futuro).
  return null;
}
