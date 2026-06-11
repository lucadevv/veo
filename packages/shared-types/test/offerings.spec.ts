import { describe, expect, it } from 'vitest';
import {
  findOffering,
  OFFERING_LIST,
  OFFERINGS,
  OfferingFlow,
  OfferingIcon,
  OfferingId,
  resolveOfferingMode,
  VehicleClass,
  type OfferingSpec,
} from '../src/catalog/index.js';
import { PricingMode } from '../src/enums/index.js';

describe('OFFERINGS · catálogo (ADR 013)', () => {
  /**
   * SNAPSHOT DE CONTRATO: estos 4 ids viajan en el quote y en `createTrip.category`, y están
   * PERSISTIDOS en `Trip.category`. Son INMUTABLES: cambiar o borrar uno rompe el contrato con las
   * apps en la calle y con los datos ya guardados. Si este test rompe, NO "ajustes el assert":
   * estás rompiendo el contrato. Agregar una oferta nueva = AGREGAR un id acá.
   */
  it('los ids del catálogo son exactamente los 4 del contrato (inmutables)', () => {
    expect(Object.keys(OFFERINGS).sort()).toEqual(
      ['veo_confort', 'veo_economico', 'veo_moto', 'veo_xl'].sort(),
    );
    expect(Object.values(OfferingId).sort()).toEqual(
      ['veo_confort', 'veo_economico', 'veo_moto', 'veo_xl'].sort(),
    );
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

  it('toda entrada tiene allowedModes NO vacío y solo con modos conocidos', () => {
    const knownModes = Object.values(PricingMode);
    for (const spec of Object.values(OFFERINGS)) {
      expect(spec.allowedModes.length).toBeGreaterThan(0);
      for (const mode of spec.allowedModes) {
        expect(knownModes).toContain(mode);
      }
    }
  });

  it('OFFERING_LIST contiene todo el catálogo ordenado por sortOrder (orden del quote)', () => {
    expect(OFFERING_LIST).toHaveLength(Object.keys(OFFERINGS).length);
    expect(OFFERING_LIST.map((o) => o.id)).toEqual([
      OfferingId.VEO_MOTO,
      OfferingId.VEO_ECONOMICO,
      OfferingId.VEO_CONFORT,
      OfferingId.VEO_XL,
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

describe('resolveOfferingMode · oferta ∩ schedule (ADR 013 §1.3)', () => {
  /** Oferta restringida de prueba (estilo ambulancia): SOLO permite FIXED. */
  const fixedOnly: OfferingSpec = {
    id: OfferingId.VEO_ECONOMICO,
    labelKey: 'offering.veo_economico.name',
    icon: OfferingIcon.CAR,
    vehicleClass: VehicleClass.CAR,
    pricing: { multiplier: 1.0, minFareCents: 500 },
    allowedModes: [PricingMode.FIXED],
    flow: OfferingFlow.STANDARD,
    sortOrder: 1,
  };

  it('schedule ∈ allowedModes → gana el schedule, sin override', () => {
    const offering = OFFERINGS[OfferingId.VEO_ECONOMICO]; // permite [PUJA, FIXED]
    expect(resolveOfferingMode(offering, PricingMode.PUJA)).toEqual({
      mode: PricingMode.PUJA,
      overridden: false,
    });
    expect(resolveOfferingMode(offering, PricingMode.FIXED)).toEqual({
      mode: PricingMode.FIXED,
      overridden: false,
    });
  });

  it('schedule ∉ allowedModes → gana la oferta con su modo PREFERIDO (allowedModes[0]) + override', () => {
    expect(resolveOfferingMode(fixedOnly, PricingMode.PUJA)).toEqual({
      mode: PricingMode.FIXED,
      overridden: true,
    });
  });

  it('oferta de UN solo modo: lo devuelve siempre (con o sin conflicto)', () => {
    // Sin conflicto: el schedule pide el único modo permitido.
    expect(resolveOfferingMode(fixedOnly, PricingMode.FIXED)).toEqual({
      mode: PricingMode.FIXED,
      overridden: false,
    });
    // Con conflicto: cae al único modo, marcado como override.
    expect(resolveOfferingMode(fixedOnly, PricingMode.PUJA)).toEqual({
      mode: PricingMode.FIXED,
      overridden: true,
    });
  });
});
