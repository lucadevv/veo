import { VehicleClass } from '@veo/shared-types';
import { IconCar, IconMoto } from '../icons';
import {
  FALLBACK_VEHICLE_GLYPH,
  FALLBACK_VEHICLE_LABEL_KEY,
  VEHICLE_CLASS_GLYPHS,
  VEHICLE_CLASS_LABEL_KEYS,
  vehicleClassGlyph,
  vehicleClassLabelKey,
} from '../vehicle-class';

describe('vehicle-class (registro clase→glyph+etiqueta, ADR 013 §1.6)', () => {
  it('cubre TODAS las clases del enum canónico (glyph y etiqueta)', () => {
    for (const vehicleClass of Object.values(VehicleClass)) {
      expect(VEHICLE_CLASS_GLYPHS[vehicleClass]).toBeDefined();
      expect(VEHICLE_CLASS_LABEL_KEYS[vehicleClass]).toBeDefined();
    }
  });

  it('resuelve el glyph de cada clase conocida', () => {
    expect(vehicleClassGlyph(VehicleClass.CAR)).toBe(IconCar);
    expect(vehicleClassGlyph(VehicleClass.MOTO)).toBe(IconMoto);
  });

  it('resuelve la clave i18n de cada clase conocida', () => {
    expect(vehicleClassLabelKey(VehicleClass.CAR)).toBe('shift.vehicleType.car');
    expect(vehicleClassLabelKey(VehicleClass.MOTO)).toBe('shift.vehicleType.moto');
  });

  it('clase desconocida (server más nuevo que la app) → fallback EXPLÍCITO de auto', () => {
    expect(vehicleClassGlyph('AMBULANCE')).toBe(FALLBACK_VEHICLE_GLYPH);
    expect(vehicleClassGlyph('')).toBe(FALLBACK_VEHICLE_GLYPH);
    expect(vehicleClassLabelKey('AMBULANCE')).toBe(FALLBACK_VEHICLE_LABEL_KEY);
    expect(vehicleClassLabelKey('')).toBe(FALLBACK_VEHICLE_LABEL_KEY);
    expect(FALLBACK_VEHICLE_GLYPH).toBe(IconCar);
    expect(FALLBACK_VEHICLE_LABEL_KEY).toBe('shift.vehicleType.car');
  });

  it('keys hostiles del prototype NO devuelven basura (misma convención que findOffering)', () => {
    expect(vehicleClassGlyph('constructor')).toBe(FALLBACK_VEHICLE_GLYPH);
    expect(vehicleClassGlyph('__proto__')).toBe(FALLBACK_VEHICLE_GLYPH);
    expect(vehicleClassLabelKey('constructor')).toBe(FALLBACK_VEHICLE_LABEL_KEY);
    expect(vehicleClassLabelKey('__proto__')).toBe(FALLBACK_VEHICLE_LABEL_KEY);
  });
});
