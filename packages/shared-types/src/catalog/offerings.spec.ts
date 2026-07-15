import { describe, expect, it } from 'vitest';
import {
  activeOfferings,
  hasRequiredCertifications,
  isEligibleForOffering,
  isVehicleEligibleForOffering,
  OFFERING_LIST,
  OFFERINGS,
  OfferingId,
  operableVehicleClasses,
  OPERABLE_VEHICLE_CLASSES,
  effectiveOfferingMode,
  resolveCatalog,
  VehicleClass,
  type OfferingCatalogOverlay,
  type OfferingSpec,
  type VehicleEligibilityAttrs,
} from './offerings.js';
import { FleetDocumentType, PricingMode, VehicleSegment } from '../enums/index.js';

describe('catálogo efectivo (overlay editable en caliente · B1)', () => {
  it('overlay null (DB vacía/caída) → cada oferta cae a su defaultEnabled (RIDE on, verticales off)', () => {
    const resolved = resolveCatalog(null);
    expect(resolved).toHaveLength(OFFERING_LIST.length);
    // B5-4 + Ola 1 "solo autos": las RIDE de AUTO nacen visibles; la moto (Ola 2B, DIFERIDA) y las
    // verticales especiales + EV nacen OCULTAS (defaultEnabled:false). El admin la habilita por overlay.
    expect(resolved.find((o) => o.id === OfferingId.VEO_ECONOMICO)?.enabled).toBe(true);
    expect(resolved.find((o) => o.id === OfferingId.VEO_MOTO)?.enabled).toBe(false);
    expect(resolved.find((o) => o.id === OfferingId.VEO_AMBULANCE)?.enabled).toBe(false);
    expect(resolved.find((o) => o.id === OfferingId.VEO_TOW)?.enabled).toBe(false);
    expect(resolved.find((o) => o.id === OfferingId.VEO_MECHANIC)?.enabled).toBe(false);
    // F2.3 · premium es una RIDE VISIBLE (defaultEnabled:true).
    expect(resolved.find((o) => o.id === OfferingId.VEO_PREMIUM)?.enabled).toBe(true);
    // Conserva el orden por sortOrder de la base.
    expect(resolved.map((o) => o.id)).toEqual(OFFERING_LIST.map((o) => o.id));
  });

  it('oferta SIN entrada en el overlay → enabled por defecto (no esconder lo shippeado)', () => {
    const overlay: OfferingCatalogOverlay = {
      version: 1,
      overrides: [{ id: OfferingId.VEO_MOTO, enabled: false }],
    };
    const resolved = resolveCatalog(overlay);
    expect(resolved.find((o) => o.id === OfferingId.VEO_MOTO)?.enabled).toBe(false);
    // Económico no está en el overlay → default true.
    expect(resolved.find((o) => o.id === OfferingId.VEO_ECONOMICO)?.enabled).toBe(true);
  });

  it('activeOfferings excluye las deshabilitadas', () => {
    const overlay: OfferingCatalogOverlay = {
      version: 2,
      overrides: [
        { id: OfferingId.VEO_MOTO, enabled: false },
        { id: OfferingId.VEO_XL, enabled: false },
      ],
    };
    const active = activeOfferings(overlay);
    const ids = active.map((o) => o.id);
    expect(ids).not.toContain(OfferingId.VEO_MOTO);
    expect(ids).not.toContain(OfferingId.VEO_XL);
    expect(ids).toContain(OfferingId.VEO_ECONOMICO);
    expect(ids).toContain(OfferingId.VEO_CONFORT);
  });

  it('overlay con un id que ya no existe en código → se IGNORA', () => {
    const overlay: OfferingCatalogOverlay = {
      version: 3,
      // 'veo_fantasma' no está en OFFERINGS → no debe aparecer ni romper.
      overrides: [{ id: 'veo_fantasma' as OfferingId, enabled: true }],
    };
    const resolved = resolveCatalog(overlay);
    expect(resolved).toHaveLength(OFFERING_LIST.length);
    expect(resolved.map((o) => o.id)).not.toContain('veo_fantasma');
  });

  it('admin apaga TODO → activeOfferings vacío (dispara el estado-vacío de la UI · B3)', () => {
    const overlay: OfferingCatalogOverlay = {
      version: 4,
      overrides: OFFERING_LIST.map((o) => ({ id: o.id, enabled: false })),
    };
    expect(activeOfferings(overlay)).toHaveLength(0);
  });

  it('la oferta resuelta conserva la spec base (pricing, clase, modo)', () => {
    const moto = resolveCatalog(null).find((o) => o.id === OfferingId.VEO_MOTO);
    expect(moto?.pricing.multiplier).toBeGreaterThan(0);
    expect(moto?.mode).toBeTruthy();
    expect(moto?.vehicleClass).toBeTruthy();
  });
});

describe('override de precio + modo por oferta (B2)', () => {
  it('multiplier/minFareCents del override pisan el pricing de código (campo a campo)', () => {
    const overlay: OfferingCatalogOverlay = {
      version: 1,
      overrides: [{ id: OfferingId.VEO_ECONOMICO, enabled: true, multiplier: 1.5 }],
    };
    const eco = resolveCatalog(overlay).find((o) => o.id === OfferingId.VEO_ECONOMICO);
    expect(eco?.pricing.multiplier).toBe(1.5); // override
    expect(eco?.pricing.minFareCents).toBe(
      OFFERINGS[OfferingId.VEO_ECONOMICO].pricing.minFareCents,
    ); // code
  });

  it('sin override de precio → pricing de código intacto', () => {
    const eco = resolveCatalog(null).find((o) => o.id === OfferingId.VEO_ECONOMICO);
    expect(eco?.pricing).toEqual(OFFERINGS[OfferingId.VEO_ECONOMICO].pricing);
  });

  it('params override (perKmCents) pisa el de código, campo a campo', () => {
    const overlay: OfferingCatalogOverlay = {
      version: 1,
      overrides: [{ id: OfferingId.VEO_ECONOMICO, enabled: true, perKmCents: 999 }],
    };
    const eco = resolveCatalog(overlay).find((o) => o.id === OfferingId.VEO_ECONOMICO);
    expect(eco?.pricing.perKmCents).toBe(999);
  });

  it('el Mecánico trae perKmCents:0 Y perMinCents:0 (call-out plano · ADR 023)', () => {
    const mech = OFFERINGS[OfferingId.VEO_MECHANIC];
    expect(mech.pricing.perKmCents).toBe(0);
    expect(mech.pricing.perMinCents).toBe(0);
  });

  it('la Grúa trae perMinCents:0 (hook-up + por-km, sin tiempo · ADR 023)', () => {
    expect(OFFERINGS[OfferingId.VEO_TOW].pricing.perMinCents).toBe(0);
  });

  it('mode pineado en una oferta NO lockeada (ride) → el modo efectivo lo refleja (palanca manual)', () => {
    const overlay: OfferingCatalogOverlay = {
      version: 1,
      overrides: [{ id: OfferingId.VEO_ECONOMICO, enabled: true, mode: PricingMode.PUJA }],
    };
    const eco = resolveCatalog(overlay).find((o) => o.id === OfferingId.VEO_ECONOMICO);
    expect(eco?.mode).toBe(PricingMode.PUJA);
  });

  it('mode pineado en una oferta LOCKEADA (ambulancia) → se IGNORA (queda FIXED, no negocia)', () => {
    const overlay: OfferingCatalogOverlay = {
      version: 1,
      overrides: [{ id: OfferingId.VEO_AMBULANCE, enabled: true, mode: PricingMode.PUJA }],
    };
    const amb = resolveCatalog(overlay).find((o) => o.id === OfferingId.VEO_AMBULANCE);
    expect(amb?.mode).toBe(PricingMode.FIXED);
  });

  it('sin pin → el modo efectivo = el de código', () => {
    const eco = resolveCatalog(null).find((o) => o.id === OfferingId.VEO_ECONOMICO);
    expect(eco?.mode).toBe(OFFERINGS[OfferingId.VEO_ECONOMICO].mode);
  });

  it('effectiveOfferingMode: ride no lockeada → el pin del admin GANA', () => {
    expect(effectiveOfferingMode(OFFERINGS[OfferingId.VEO_ECONOMICO], PricingMode.PUJA)).toBe(
      PricingMode.PUJA,
    );
  });

  it('effectiveOfferingMode: sin pin → el modo de código', () => {
    expect(effectiveOfferingMode(OFFERINGS[OfferingId.VEO_ECONOMICO], undefined)).toBe(
      OFFERINGS[OfferingId.VEO_ECONOMICO].mode,
    );
  });

  it('effectiveOfferingMode: vertical LOCKEADA → ignora el pin, siempre su modo (ambulancia FIXED)', () => {
    expect(effectiveOfferingMode(OFFERINGS[OfferingId.VEO_AMBULANCE], PricingMode.PUJA)).toBe(
      PricingMode.FIXED,
    );
  });
});

describe('isVehicleEligibleForOffering (B5-3 · eligibilidad computada)', () => {
  const YEAR = 2026;
  // El consumidor (dispatch) lee `requires` vía el tipo OfferingSpec (opcional), no el literal exacto.
  const reqOf = (id: OfferingId) => (OFFERINGS[id] as OfferingSpec).requires;
  const economyOld: VehicleEligibilityAttrs = {
    seats: 5,
    segment: VehicleSegment.ECONOMY,
    year: 2015,
  };
  const midNew: VehicleEligibilityAttrs = { seats: 5, segment: VehicleSegment.MID, year: 2022 };
  const premiumVan: VehicleEligibilityAttrs = {
    seats: 7,
    segment: VehicleSegment.PREMIUM,
    year: 2023,
  };

  it('sin requires (económico) → cualquier vehículo de la clase es elegible', () => {
    expect(reqOf(OfferingId.VEO_ECONOMICO)).toBeUndefined();
    expect(isVehicleEligibleForOffering(reqOf(OfferingId.VEO_ECONOMICO), economyOld, YEAR)).toBe(
      true,
    );
  });

  it('confort exige segmento ≥ MID: un ECONOMY no califica, MID/PREMIUM sí', () => {
    const confort = reqOf(OfferingId.VEO_CONFORT);
    expect(isVehicleEligibleForOffering(confort, economyOld, YEAR)).toBe(false); // ECONOMY < MID
    expect(isVehicleEligibleForOffering(confort, midNew, YEAR)).toBe(true);
    expect(isVehicleEligibleForOffering(confort, premiumVan, YEAR)).toBe(true); // PREMIUM ≥ MID (inclusiva ↑)
  });

  it('confort exige antigüedad ≤ 8 años: un MID viejo (2015) no califica aunque el segmento alcance', () => {
    const confort = reqOf(OfferingId.VEO_CONFORT);
    expect(
      isVehicleEligibleForOffering(
        confort,
        { seats: 5, segment: VehicleSegment.MID, year: 2015 },
        YEAR,
      ),
    ).toBe(false);
    expect(
      isVehicleEligibleForOffering(
        confort,
        { seats: 5, segment: VehicleSegment.MID, year: 2018 },
        YEAR,
      ),
    ).toBe(true);
  });

  it('xl exige 6+ asientos: un sedán de 5 no califica, una van de 7 sí', () => {
    const xl = reqOf(OfferingId.VEO_XL);
    expect(isVehicleEligibleForOffering(xl, midNew, YEAR)).toBe(false); // 5 < 6
    expect(isVehicleEligibleForOffering(xl, premiumVan, YEAR)).toBe(true); // 7 >= 6
  });

  it('xl NO exige segmento: una van ECONOMY de 6 asientos califica', () => {
    const xl = reqOf(OfferingId.VEO_XL);
    expect(
      isVehicleEligibleForOffering(
        xl,
        { seats: 6, segment: VehicleSegment.ECONOMY, year: 2020 },
        YEAR,
      ),
    ).toBe(true);
  });
});

describe('hasRequiredCertifications (B5-3.2 · certs del conductor, FAIL-CLOSED)', () => {
  const reqOf = (id: OfferingId) => (OFFERINGS[id] as OfferingSpec).requires;

  it('oferta SIN certs requeridas (económico/confort) → siempre true, sin importar las del conductor', () => {
    expect(hasRequiredCertifications(reqOf(OfferingId.VEO_ECONOMICO), [])).toBe(true);
    expect(hasRequiredCertifications(reqOf(OfferingId.VEO_CONFORT), undefined)).toBe(true);
  });

  it('FAIL-CLOSED: ambulancia exige cert y el conductor NO trae lista (undefined) → false', () => {
    expect(hasRequiredCertifications(reqOf(OfferingId.VEO_AMBULANCE), undefined)).toBe(false);
  });

  it('FAIL-CLOSED: ambulancia exige cert y el conductor tiene OTRAS certs (no la de ambulancia) → false', () => {
    expect(
      hasRequiredCertifications(reqOf(OfferingId.VEO_AMBULANCE), [FleetDocumentType.TOW_OPERATOR]),
    ).toBe(false);
  });

  it('conductor con la cert VÁLIDA de ambulancia → true (⊆ se cumple)', () => {
    expect(
      hasRequiredCertifications(reqOf(OfferingId.VEO_AMBULANCE), [
        FleetDocumentType.AMBULANCE_OPERATOR,
        FleetDocumentType.LICENSE_A1,
      ]),
    ).toBe(true);
  });

  it('cada vertical exige SU propia certificación (ambulancia/grúa/mecánico no se mezclan)', () => {
    expect(reqOf(OfferingId.VEO_AMBULANCE)?.certifications).toEqual([
      FleetDocumentType.AMBULANCE_OPERATOR,
    ]);
    expect(reqOf(OfferingId.VEO_TOW)?.certifications).toEqual([FleetDocumentType.TOW_OPERATOR]);
    expect(reqOf(OfferingId.VEO_MECHANIC)?.certifications).toEqual([
      FleetDocumentType.MECHANIC_CERT,
    ]);
    // La grúa NO se cubre con la cert de ambulancia: cruzar credenciales no habilita.
    expect(
      hasRequiredCertifications(reqOf(OfferingId.VEO_TOW), [FleetDocumentType.AMBULANCE_OPERATOR]),
    ).toBe(false);
  });
});

describe('isEligibleForOffering (B5-3.2 · vehículo ∧ conductor)', () => {
  const YEAR = 2026;
  const reqOf = (id: OfferingId) => (OFFERINGS[id] as OfferingSpec).requires;
  const van: VehicleEligibilityAttrs = { seats: 7, segment: VehicleSegment.PREMIUM, year: 2023 };

  it('económico (sin requires) → elegible aunque el conductor no tenga certs', () => {
    expect(isEligibleForOffering(reqOf(OfferingId.VEO_ECONOMICO), van, [], YEAR)).toBe(true);
  });

  it('ambulancia: vehículo OK pero conductor SIN cert → NO elegible (la cert manda, fail-closed)', () => {
    expect(isEligibleForOffering(reqOf(OfferingId.VEO_AMBULANCE), van, [], YEAR)).toBe(false);
  });

  it('ambulancia: conductor CON cert válida + vehículo OK → elegible', () => {
    expect(
      isEligibleForOffering(
        reqOf(OfferingId.VEO_AMBULANCE),
        van,
        [FleetDocumentType.AMBULANCE_OPERATOR],
        YEAR,
      ),
    ).toBe(true);
  });

  it('xl: conductor con cert sobrante pero vehículo de 5 asientos → NO elegible (el attr veta primero)', () => {
    const sedan: VehicleEligibilityAttrs = { seats: 5, segment: VehicleSegment.MID, year: 2022 };
    expect(
      isEligibleForOffering(
        reqOf(OfferingId.VEO_XL),
        sedan,
        [FleetDocumentType.AMBULANCE_OPERATOR],
        YEAR,
      ),
    ).toBe(false);
  });
});

describe('verticales especiales (B5-4 · codeadas pero OCULTAS)', () => {
  const HIDDEN = [OfferingId.VEO_AMBULANCE, OfferingId.VEO_TOW, OfferingId.VEO_MECHANIC];

  it('sin overlay, el quote (activeOfferings) muestra SOLO las 4 RIDE de AUTO, NO moto ni verticales', () => {
    // Ola 1 "solo autos": la moto (Ola 2B) está DIFERIDA (defaultEnabled:false) → fuera del quote por
    // defecto, igual que las verticales. El admin la reactiva por overlay cuando se lance el tier moto.
    // F2.3: premium (sortOrder 3) entra entre confort y xl.
    const active = activeOfferings(null).map((o) => o.id);
    expect(active).toEqual([
      OfferingId.VEO_ECONOMICO,
      OfferingId.VEO_CONFORT,
      OfferingId.VEO_PREMIUM,
      OfferingId.VEO_XL,
    ]);
    expect(active).not.toContain(OfferingId.VEO_MOTO);
    for (const id of HIDDEN) expect(active).not.toContain(id);
  });

  it('el admin PUEDE desbloquear una vertical por overlay (la feature paga)', () => {
    const overlay: OfferingCatalogOverlay = {
      version: 1,
      overrides: [{ id: OfferingId.VEO_AMBULANCE, enabled: true }],
    };
    const active = activeOfferings(overlay).map((o) => o.id);
    expect(active).toContain(OfferingId.VEO_AMBULANCE);
    // Las otras verticales SIGUEN ocultas (solo se habilitó la ambulancia).
    expect(active).not.toContain(OfferingId.VEO_TOW);
  });

  it('la ambulancia NO negocia: mode FIXED + lockeado + flow EMERGENCY', () => {
    const amb = OFFERINGS[OfferingId.VEO_AMBULANCE];
    expect(amb.mode).toBe(PricingMode.FIXED);
    expect(amb.modeLocked).toBe(true);
    expect(amb.flow).toBe('EMERGENCY');
  });

  it('F2.3 · premium es una RIDE VISIBLE que exige segmento PREMIUM + unidad reciente (<=5 años)', () => {
    const premium = OFFERINGS[OfferingId.VEO_PREMIUM];
    expect(premium.defaultEnabled).toBe(true);
    expect(premium.requires).toEqual({
      minSegment: VehicleSegment.PREMIUM,
      maxAgeYears: 5,
    });
    expect(premium.pricing).toEqual({ multiplier: 1.8, minFareCents: 800 });
  });
});

describe('operableVehicleClasses (helper puro · gate de operabilidad overlay-aware)', () => {
  it('una oferta MOTO enabled → MOTO entra en el set operable', () => {
    const classes = operableVehicleClasses([
      { enabled: true, vehicleClass: VehicleClass.CAR },
      { enabled: true, vehicleClass: VehicleClass.MOTO },
    ]);
    expect(classes).toContain(VehicleClass.MOTO);
    expect(classes).toContain(VehicleClass.CAR);
  });

  it('solo CAR enabled (MOTO apagada) → [CAR]', () => {
    const classes = operableVehicleClasses([
      { enabled: true, vehicleClass: VehicleClass.CAR },
      { enabled: false, vehicleClass: VehicleClass.MOTO },
    ]);
    expect(classes).toEqual([VehicleClass.CAR]);
  });

  it('lista vacía → [] (ninguna clase operable)', () => {
    expect(operableVehicleClasses([])).toEqual([]);
  });

  it('ninguna oferta enabled → [] aunque haya ofertas de ambas clases', () => {
    const classes = operableVehicleClasses([
      { enabled: false, vehicleClass: VehicleClass.CAR },
      { enabled: false, vehicleClass: VehicleClass.MOTO },
    ]);
    expect(classes).toEqual([]);
  });

  it('ordena por el enum VehicleClass (CAR antes que MOTO), sin importar el orden de entrada', () => {
    const classes = operableVehicleClasses([
      { enabled: true, vehicleClass: VehicleClass.MOTO },
      { enabled: true, vehicleClass: VehicleClass.CAR },
    ]);
    expect(classes).toEqual([VehicleClass.CAR, VehicleClass.MOTO]);
  });

  it('DRY: el default estático OPERABLE_VEHICLE_CLASSES = operableVehicleClasses(resolveCatalog(null)) = [CAR] hoy', () => {
    // Invariante de no-regresión: refactorizar el IIFE al helper NO cambia el valor (MOTO sigue diferida).
    expect(OPERABLE_VEHICLE_CLASSES).toEqual([VehicleClass.CAR]);
    expect([...OPERABLE_VEHICLE_CLASSES]).toEqual(operableVehicleClasses(resolveCatalog(null)));
  });
});
