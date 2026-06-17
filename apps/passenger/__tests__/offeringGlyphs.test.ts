import { OfferingIcon, VehicleClass } from '@veo/shared-types';
import {
  FALLBACK_OFFERING_GLYPH,
  OFFERING_GLYPHS,
  VEHICLE_CLASS_ICON,
  offeringDisplayName,
  offeringGlyph,
} from '../src/shared/presentation/components/offeringGlyphs';

/**
 * Registro token→glyph de la app (ADR 013 §1.6 · P5-1). El contrato que protege:
 *  - token CONOCIDO del quote → SU entrada del registro (data-driven, sin ternarios);
 *  - token DESCONOCIDO (server más nuevo que la app) → fallback EXPLÍCITO al glyph de auto;
 *  - datos SIN `icon` (historial viejo, nearby) → clase de vehículo vía mapeo exhaustivo;
 *  - `labelKey` conocido → nombre del i18n de la app; desconocido/ausente → `name` del server.
 */
describe('OFFERING_GLYPHS · registro token→glyph (ADR 013 §1.6)', () => {
  it('token conocido del quote resuelve SU entrada del registro', () => {
    expect(offeringGlyph({ icon: OfferingIcon.MOTO })).toBe(OFFERING_GLYPHS[OfferingIcon.MOTO]);
    expect(offeringGlyph({ icon: OfferingIcon.CAR })).toBe(OFFERING_GLYPHS[OfferingIcon.CAR]);
  });

  it('el icon del quote MANDA sobre la clase (data-driven: el server elige el glyph)', () => {
    expect(offeringGlyph({ icon: OfferingIcon.MOTO, vehicleType: VehicleClass.CAR })).toBe(
      OFFERING_GLYPHS[OfferingIcon.MOTO],
    );
  });

  it('token DESCONOCIDO (server nuevo + app vieja) cae al fallback EXPLÍCITO de auto', () => {
    // B5-4: 'ambulance' YA es un token conocido (vertical agregada). Usamos uno genuinamente futuro
    // que esta app aún no tiene en su registro para probar la degradación al fallback.
    expect(offeringGlyph({ icon: 'helicopter' })).toBe(FALLBACK_OFFERING_GLYPH);
    expect(FALLBACK_OFFERING_GLYPH).toBe(OFFERING_GLYPHS[OfferingIcon.CAR]);
  });

  it('un token hostil tipo __proto__ NO devuelve basura del prototype: fallback', () => {
    expect(offeringGlyph({ icon: '__proto__' })).toBe(FALLBACK_OFFERING_GLYPH);
    expect(offeringGlyph({ icon: 'constructor' })).toBe(FALLBACK_OFFERING_GLYPH);
  });

  it('sin `icon` (historial viejo, nearby) resuelve por clase de vehículo', () => {
    expect(offeringGlyph({ vehicleType: VehicleClass.MOTO })).toBe(
      OFFERING_GLYPHS[OfferingIcon.MOTO],
    );
    expect(offeringGlyph({ vehicleType: VehicleClass.CAR })).toBe(
      OFFERING_GLYPHS[OfferingIcon.CAR],
    );
  });

  it('sin dato alguno (ambiente sin tipo) cae al fallback de auto — el default histórico del mapa', () => {
    expect(offeringGlyph({})).toBe(FALLBACK_OFFERING_GLYPH);
  });

  it('el mapeo clase→token cubre TODAS las VehicleClass (exhaustividad runtime + compile-time)', () => {
    for (const vehicleClass of Object.values(VehicleClass)) {
      expect(VEHICLE_CLASS_ICON[vehicleClass]).toBeDefined();
      expect(OFFERING_GLYPHS[VEHICLE_CLASS_ICON[vehicleClass]]).toBeDefined();
    }
  });

  it('el render de HOY queda idéntico: moto 🏍️ en lima, auto 🚗 en tinta, labels actuales', () => {
    expect(OFFERING_GLYPHS[OfferingIcon.MOTO]).toMatchObject({
      emoji: '🏍️',
      tone: 'brand',
      vehicleLabelKey: 'quote.vehicle.moto',
    });
    expect(OFFERING_GLYPHS[OfferingIcon.CAR]).toMatchObject({
      emoji: '🚗',
      tone: 'ink',
      vehicleLabelKey: 'quote.vehicle.car',
    });
  });
});

describe('offeringDisplayName · labelKey del quote → i18n de la app (fallback name del server)', () => {
  it('labelKey conocido resuelve en el i18n de la app', () => {
    expect(offeringDisplayName({ labelKey: 'offering.veo_moto.name', name: 'lo que diga el server' }))
      .toBe('VEO Moto');
    expect(offeringDisplayName({ labelKey: 'offering.veo_xl.name', name: 'x' })).toBe('VEO XL');
  });

  it('labelKey DESCONOCIDO (oferta más nueva que la app) cae al name resuelto server-side', () => {
    expect(
      offeringDisplayName({ labelKey: 'offering.veo_futura.name', name: 'VEO Futura' }),
    ).toBe('VEO Futura');
  });

  it('B5-vert · las verticales (ocultas) resuelven su nombre NATIVO en el i18n de la app', () => {
    expect(offeringDisplayName({ labelKey: 'offering.veo_ambulance.name', name: 'x' })).toBe('VEO Ambulancia');
    expect(offeringDisplayName({ labelKey: 'offering.veo_tow.name', name: 'x' })).toBe('VEO Grúa');
    expect(offeringDisplayName({ labelKey: 'offering.veo_mechanic.name', name: 'x' })).toBe('VEO Mecánico');
    expect(offeringDisplayName({ labelKey: 'offering.veo_economico_ev.name', name: 'x' })).toBe('VEO Económico Eléctrico');
  });

  it('sin labelKey (server viejo) usa el name del quote — compat intacta', () => {
    expect(offeringDisplayName({ name: 'VEO Económico' })).toBe('VEO Económico');
  });
});
