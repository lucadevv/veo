import { describe, expect, it } from 'vitest';
import {
  effectiveOfferingMode,
  findOffering,
  OFFERING_LIST,
  OFFERINGS,
  OfferingId,
  VehicleClass,
} from '../src/catalog/index.js';
import { PricingMode } from '../src/enums/index.js';

describe('OFFERINGS · catálogo (ADR 013)', () => {
  /**
   * SNAPSHOT DE CONTRATO: estos 4 ids viajan en el quote y en `createTrip.category`, y están
   * PERSISTIDOS en `Trip.category`. Son INMUTABLES: cambiar o borrar uno rompe el contrato con las
   * apps en la calle y con los datos ya guardados. Si este test rompe, NO "ajustes el assert":
   * estás rompiendo el contrato. Agregar una oferta nueva = AGREGAR un id acá.
   */
  it('los ids del catálogo son el contrato (5 RIDE visibles + 3 verticales ocultas · B5-4/F2.3)', () => {
    // Las RIDE son INMUTABLES (contrato con apps en la calle + Trip.category persistido). F2.3: se
    // AGREGÓ veo_premium (visible) y se DEPRECÓ veo_economico_ev (el eléctrico es un tipo de energía,
    // no una oferta). Las 3 verticales (ambulancia/grúa/mecánico) siguen codeadas pero ocultas.
    const expected = [
      'veo_moto',
      'veo_economico',
      'veo_confort',
      'veo_xl',
      'veo_premium',
      'veo_ambulance',
      'veo_tow',
      'veo_mechanic',
    ].sort();
    expect(Object.keys(OFFERINGS).sort()).toEqual(expected);
    expect(Object.values(OfferingId).sort()).toEqual(expected);
  });

  it('cada entrada es coherente: la key es el id de su spec', () => {
    for (const [key, spec] of Object.entries(OFFERINGS)) {
      expect(spec.id).toBe(key);
    }
  });

  /**
   * SNAPSHOT DE PRECIOS: el catálogo es la FUENTE ÚNICA de la política de pricing (Lote C
   * consumado) — el preview del public-bff (`maps/fare.ts`) y trip-service (tarifa firme FIXED +
   * re-quote de paradas) consumen ESTOS números. Si este test rompe, no estás refactorizando:
   * estás cambiando el PRECIO que ve y paga el pasajero en todos lados. Cambialo solo con una
   * decisión de pricing explícita.
   */
  it('multiplicadores y mínimas del catálogo (fuente única del pricing por oferta)', () => {
    expect(OFFERINGS[OfferingId.VEO_MOTO].pricing).toEqual({ multiplier: 0.55, minFareCents: 300 });
    expect(OFFERINGS[OfferingId.VEO_ECONOMICO].pricing).toEqual({
      multiplier: 1.0,
      minFareCents: 500,
    });
    expect(OFFERINGS[OfferingId.VEO_CONFORT].pricing).toEqual({
      multiplier: 1.25,
      minFareCents: 500,
    });
    expect(OFFERINGS[OfferingId.VEO_XL].pricing).toEqual({ multiplier: 1.6, minFareCents: 500 });
  });

  it('toda entrada tiene multiplier > 0 y minFareCents > 0 (enteros en céntimos)', () => {
    for (const spec of Object.values(OFFERINGS)) {
      expect(spec.pricing.multiplier).toBeGreaterThan(0);
      expect(spec.pricing.minFareCents).toBeGreaterThan(0);
      expect(Number.isInteger(spec.pricing.minFareCents)).toBe(true);
    }
  });

  it('toda entrada tiene un `mode` conocido y `modeLocked` booleano (ADR 023)', () => {
    const knownModes = Object.values(PricingMode);
    for (const spec of Object.values(OFFERINGS)) {
      expect(knownModes).toContain(spec.mode);
      expect(typeof spec.modeLocked).toBe('boolean');
    }
  });

  it('las verticales especiales van LOCKEADAS en FIXED (no negocian); las rides NO lockeadas', () => {
    for (const id of [OfferingId.VEO_AMBULANCE, OfferingId.VEO_TOW, OfferingId.VEO_MECHANIC]) {
      expect(OFFERINGS[id].modeLocked).toBe(true);
      expect(OFFERINGS[id].mode).toBe(PricingMode.FIXED);
    }
    for (const id of [OfferingId.VEO_ECONOMICO, OfferingId.VEO_CONFORT, OfferingId.VEO_XL]) {
      expect(OFFERINGS[id].modeLocked).toBe(false);
    }
  });

  it('OFFERING_LIST contiene todo el catálogo ordenado por sortOrder (orden del quote)', () => {
    expect(OFFERING_LIST).toHaveLength(Object.keys(OFFERINGS).length);
    expect(OFFERING_LIST.map((o) => o.id)).toEqual([
      OfferingId.VEO_MOTO,
      OfferingId.VEO_ECONOMICO,
      OfferingId.VEO_CONFORT,
      // F2.3 · premium (sortOrder 3) entra ANTES de xl (sortOrder 4): económico → normal → premium → xl.
      OfferingId.VEO_PREMIUM,
      OfferingId.VEO_XL,
      // B5-4 · verticales por sortOrder (ocultas: defaultEnabled:false, no aparecen en el quote).
      OfferingId.VEO_AMBULANCE,
      OfferingId.VEO_TOW,
      OfferingId.VEO_MECHANIC,
    ]);
  });
});

describe('findOffering · lookup tolerante en el borde de input', () => {
  it('resuelve un id válido del catálogo', () => {
    const offering = findOffering('veo_moto');
    expect(offering).toBeDefined();
    expect(offering?.id).toBe(OfferingId.VEO_MOTO);
    expect(offering?.vehicleClass).toBe(VehicleClass.MOTO);
  });

  it('devuelve undefined para un id desconocido', () => {
    expect(findOffering('veo_ambulancia')).toBeUndefined();
    expect(findOffering('')).toBeUndefined();
  });

  it('NO resuelve keys del prototype: __proto__ y constructor → undefined', () => {
    // Hardening (hallazgo del revisor del ADR): un lookup directo sobre el objeto literal con id
    // crudo del cliente devolvería basura del prototype para '__proto__'/'constructor'.
    expect(findOffering('__proto__')).toBeUndefined();
    expect(findOffering('constructor')).toBeUndefined();
    expect(findOffering('hasOwnProperty')).toBeUndefined();
    expect(findOffering('toString')).toBeUndefined();
  });
});

describe('effectiveOfferingMode · palanca manual del admin (ADR 023, sin schedule)', () => {
  it('ride NO lockeada: el pin del admin GANA; sin pin → el modo de código', () => {
    const eco = OFFERINGS[OfferingId.VEO_ECONOMICO]; // modeLocked:false
    expect(effectiveOfferingMode(eco, PricingMode.PUJA)).toBe(PricingMode.PUJA);
    expect(effectiveOfferingMode(eco, PricingMode.FIXED)).toBe(PricingMode.FIXED);
    expect(effectiveOfferingMode(eco, undefined)).toBe(eco.mode);
  });

  it('vertical LOCKEADA (ambulancia): IGNORA el pin, siempre su modo FIXED (no negocia)', () => {
    const amb = OFFERINGS[OfferingId.VEO_AMBULANCE]; // modeLocked:true, mode FIXED
    expect(effectiveOfferingMode(amb, PricingMode.PUJA)).toBe(PricingMode.FIXED);
    expect(effectiveOfferingMode(amb, undefined)).toBe(PricingMode.FIXED);
  });
});
