import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OFFERINGS, OfferingId, VehicleClass } from '@veo/shared-types';
import { createTripRequest, mobileVehicleType, quoteOption } from '../src/mobile.js';

/**
 * Spec de SYNC api-client ↔ catálogo (ADR 013 §1.1). `@veo/api-client` mantiene su política de
 * ESPEJAR el wire (no gana dep runtime de shared-types): la dep es SOLO de test (devDependency).
 * Si alguien agrega una `VehicleClass` u oferta nueva en el catálogo y olvida el espejo del wire
 * (o viceversa), este test lo grita en CI antes de que la app lo descubra en runtime.
 */
describe('sync api-client ↔ catálogo de offerings (@veo/shared-types)', () => {
  it('mobileVehicleType espeja EXACTAMENTE VehicleClass del catálogo', () => {
    expect([...mobileVehicleType.options].sort()).toEqual(Object.values(VehicleClass).sort());
  });

  /**
   * Los ids del catálogo ≡ los ids que el quote conoce y documenta. Hoy `quoteOption.id` y
   * `createTripRequest.category` son `z.string()` LIBRE (endurecer el schema wire queda para
   * DESPUÉS de P5, cuando las apps en la calle ya consuman el catálogo): el universo documentado
   * del contrato es `Object.keys(OFFERINGS)` — los mismos ids del JSDoc de
   * `createTripRequest.category` (`veo_moto | veo_economico | veo_confort | veo_xl`).
   */
  it('los ids de OFFERINGS son exactamente el universo CODEADO del catálogo (RIDE + verticales ocultas)', () => {
    // B5-4: el catálogo codea las 4 RIDE (visibles) + 4 verticales OCULTAS (defaultEnabled:false). El
    // contrato cubre TODOS los ids codeados (no solo los visibles del quote); la visibilidad la decide
    // `defaultEnabled`/overlay, no la membresía del enum.
    const documentedIds = [
      'veo_moto',
      'veo_economico',
      'veo_confort',
      'veo_xl',
      'veo_economico_ev',
      'veo_ambulance',
      'veo_tow',
      'veo_mechanic',
    ];
    expect(Object.keys(OFFERINGS).sort()).toEqual([...documentedIds].sort());
    expect(Object.values(OfferingId).sort()).toEqual([...documentedIds].sort());
  });

  it('todo id del catálogo es aceptado por el wire actual (quoteOption.id / createTrip.category)', () => {
    for (const id of Object.keys(OFFERINGS)) {
      expect(quoteOption.shape.id.safeParse(id).success).toBe(true);
      expect(createTripRequest.shape.category.safeParse(id).success).toBe(true);
    }
  });

  /**
   * Documenta el estado del wire: `quoteOption.id` sigue siendo string libre. El Lote C agregó los
   * campos additive del quote SIN endurecer `id`/`category` (eso queda para DESPUÉS de P5, con las
   * apps ya migradas al catálogo). Cuando se endurezca (enum de offering ids), este assert se
   * REVISA conscientemente (y el de arriba se vuelve redundante a favor del enum).
   */
  it('quoteOption.id es z.string() libre hoy (endurecerlo queda para después de P5)', () => {
    expect(quoteOption.shape.id).toBeInstanceOf(z.ZodString);
  });

  it('el vehicleClass de cada oferta viaja tal cual por el wire (mobileVehicleType lo parsea)', () => {
    for (const spec of Object.values(OFFERINGS)) {
      expect(mobileVehicleType.safeParse(spec.vehicleClass).success).toBe(true);
    }
  });

  /**
   * Lote C (ADR 013) · los campos ADDITIVE del quote (`mode`/`labelKey`/`icon`) aceptan los valores
   * reales del catálogo y son OPCIONALES: una opción de un server viejo (sin los campos) sigue
   * parseando — apps viejas y nuevas conviven.
   */
  it('options[].mode/labelKey/icon (Lote C) aceptan los valores del catálogo y son opcionales', () => {
    for (const spec of Object.values(OFFERINGS)) {
      expect(quoteOption.shape.labelKey.safeParse(spec.labelKey).success).toBe(true);
      expect(quoteOption.shape.icon.safeParse(spec.icon).success).toBe(true);
      for (const allowedMode of spec.allowedModes) {
        expect(quoteOption.shape.mode.safeParse(allowedMode).success).toBe(true);
      }
    }
    // Server viejo: la opción SIN los campos additive sigue siendo válida (compat hacia atrás).
    const legacyOption = {
      id: 'veo_economico',
      name: 'VEO Económico',
      vehicleType: 'CAR',
      etaSeconds: 600,
      priceCents: 1500,
      currency: 'PEN',
    };
    expect(quoteOption.safeParse(legacyOption).success).toBe(true);
  });
});
