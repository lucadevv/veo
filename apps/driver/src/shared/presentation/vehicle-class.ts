/**
 * Registro clase de vehículo → glyph + clave i18n (ADR 013 §1.6 · P5-2).
 *
 * Mata los ternarios `=== 'MOTO'` de la UI: las pantallas renderizan desde estos Records
 * EXHAUSTIVOS (compile-time: agregar una `VehicleClass` nueva sin entrada acá NO compila).
 * El valor puede llegar del wire como string crudo (server más nuevo que la app): los lookups
 * `vehicleClassGlyph`/`vehicleClassLabelKey` degradan al fallback EXPLÍCITO de auto, nunca a
 * un ternario implícito. Lookup con `Object.hasOwn` (misma convención que `findOffering` del
 * catálogo): keys hostiles del prototype (`constructor`, `__proto__`) no devuelven basura.
 */
import {VehicleClass} from '@veo/shared-types';
import {IconCar, IconMoto} from './icons';

/** Glyph de una clase: componente de ícono propio (mismo contrato `IconProps`). */
export type VehicleGlyph = typeof IconCar;

/** Registro EXHAUSTIVO clase→glyph (una clase nueva exige su entrada o no compila). */
export const VEHICLE_CLASS_GLYPHS: Record<VehicleClass, VehicleGlyph> = {
  [VehicleClass.CAR]: IconCar,
  [VehicleClass.MOTO]: IconMoto,
};

/** Fallback EXPLÍCITO para clases desconocidas: glyph genérico de auto (ADR 013 §1.6). */
export const FALLBACK_VEHICLE_GLYPH: VehicleGlyph = IconCar;

/** Registro EXHAUSTIVO clase→clave i18n (las claves viven en `shift.vehicleType.*`). */
export const VEHICLE_CLASS_LABEL_KEYS: Record<VehicleClass, string> = {
  [VehicleClass.CAR]: 'shift.vehicleType.car',
  [VehicleClass.MOTO]: 'shift.vehicleType.moto',
};

/** Fallback EXPLÍCITO de etiqueta para clases desconocidas: la de auto. */
export const FALLBACK_VEHICLE_LABEL_KEY: string = VEHICLE_CLASS_LABEL_KEYS[VehicleClass.CAR];

/** Resuelve el glyph de una clase que llega del wire como string crudo (tolerante). */
export function vehicleClassGlyph(vehicleClass: string): VehicleGlyph {
  if (!Object.hasOwn(VEHICLE_CLASS_GLYPHS, vehicleClass)) {
    return FALLBACK_VEHICLE_GLYPH;
  }
  return VEHICLE_CLASS_GLYPHS[vehicleClass as VehicleClass];
}

/** Resuelve la clave i18n de la etiqueta de una clase que llega del wire como string crudo. */
export function vehicleClassLabelKey(vehicleClass: string): string {
  if (!Object.hasOwn(VEHICLE_CLASS_LABEL_KEYS, vehicleClass)) {
    return FALLBACK_VEHICLE_LABEL_KEY;
  }
  return VEHICLE_CLASS_LABEL_KEYS[vehicleClass as VehicleClass];
}
