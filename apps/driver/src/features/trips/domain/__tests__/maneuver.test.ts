import {
  formatManeuverDistance,
  greatCircleMeters,
  isArrival,
  maneuverGlyph,
  upcomingManeuver,
  type TripManeuver,
} from '../value-objects/maneuver';
import type { TripRouteStep } from '../entities';

const step = (overrides: Partial<TripRouteStep>): TripRouteStep => ({
  instruction: 'Inicia el recorrido',
  distanceMeters: 7000,
  maneuver: 'depart',
  geometryPolyline: 'geom-0',
  ...overrides,
});

describe('maneuver', () => {
  describe('maneuverGlyph', () => {
    it('mapea cada maniobra del contrato a su glifo direccional', () => {
      const cases: Array<[TripManeuver, ReturnType<typeof maneuverGlyph>]> = [
        ['depart', 'depart'],
        ['straight', 'straight'],
        ['turn-left', 'left'],
        ['turn-slight-left', 'slight-left'],
        ['turn-sharp-left', 'sharp-left'],
        ['turn-right', 'right'],
        ['turn-slight-right', 'slight-right'],
        ['turn-sharp-right', 'sharp-right'],
        ['uturn', 'uturn'],
        ['merge', 'merge'],
        ['roundabout', 'roundabout'],
        ['fork', 'fork'],
        ['arrive', 'arrive'],
      ];
      for (const [maneuver, glyph] of cases) {
        expect(maneuverGlyph(maneuver)).toBe(glyph);
      }
    });

    it('cubre los 13 tipos de maniobra (mapeo total, sin huecos)', () => {
      const all: TripManeuver[] = [
        'depart',
        'turn-left',
        'turn-right',
        'turn-slight-left',
        'turn-slight-right',
        'turn-sharp-left',
        'turn-sharp-right',
        'uturn',
        'straight',
        'merge',
        'roundabout',
        'fork',
        'arrive',
      ];
      for (const maneuver of all) {
        expect(maneuverGlyph(maneuver)).toBeDefined();
      }
    });
  });

  describe('isArrival', () => {
    it('solo "arrive" es llegada', () => {
      expect(isArrival('arrive')).toBe(true);
      expect(isArrival('turn-left')).toBe(false);
      expect(isArrival('depart')).toBe(false);
    });
  });

  describe('formatManeuverDistance', () => {
    it('muy cerca (< 10 m) → "Ahora"', () => {
      expect(formatManeuverDistance(0)).toBe('Ahora');
      expect(formatManeuverDistance(9)).toBe('Ahora');
      expect(formatManeuverDistance(-5)).toBe('Ahora');
    });

    it('metros redondeados a la decena bajo 1 km', () => {
      expect(formatManeuverDistance(10)).toBe('En 10 m');
      expect(formatManeuverDistance(154)).toBe('En 150 m');
      expect(formatManeuverDistance(155)).toBe('En 160 m');
      expect(formatManeuverDistance(999)).toBe('En 1000 m');
    });

    it('kilómetros con un decimal desde 1 km', () => {
      expect(formatManeuverDistance(1000)).toBe('En 1.0 km');
      expect(formatManeuverDistance(1240)).toBe('En 1.2 km');
      expect(formatManeuverDistance(12500)).toBe('En 12.5 km');
    });
  });

  describe('upcomingManeuver — banner con distancia VIVA', () => {
    const DRIVER = { lat: -12.05, lon: -77.05 };
    // ~1113 m al este del conductor (0.01° de longitud a esta latitud).
    const MANEUVER_POINT = { lat: -12.05, lon: -77.0398 };
    const decodeEnd = (geometry: string) => (geometry === 'geom-0' ? MANEUVER_POINT : null);

    it('anuncia la maniobra de steps[1] con la distancia GPS→fin del paso actual', () => {
      const steps = [
        step({ maneuver: 'depart', geometryPolyline: 'geom-0', distanceMeters: 7000 }),
        step({ maneuver: 'turn-left', instruction: 'Gira a la izquierda', geometryPolyline: 'geom-1' }),
      ];
      const result = upcomingManeuver(steps, DRIVER, decodeEnd);
      expect(result?.step.maneuver).toBe('turn-left');
      // Distancia VIVA (~1.1 km), NO el largo del tramo entero (7 km).
      expect(result?.distanceMeters).toBeGreaterThan(1000);
      expect(result?.distanceMeters).toBeLessThan(1250);
    });

    it('con UN solo paso (arrive retrimado) anuncia ese paso', () => {
      const steps = [step({ maneuver: 'arrive', instruction: 'Has llegado', geometryPolyline: 'geom-0' })];
      const result = upcomingManeuver(steps, DRIVER, decodeEnd);
      expect(result?.step.maneuver).toBe('arrive');
      expect(result?.distanceMeters).toBeLessThan(1250);
    });

    it('sin GPS degrada honesto a la distancia del contrato (largo del tramo actual)', () => {
      const steps = [
        step({ distanceMeters: 7000 }),
        step({ maneuver: 'turn-right', instruction: 'Gira a la derecha' }),
      ];
      const result = upcomingManeuver(steps, null, decodeEnd);
      expect(result?.step.maneuver).toBe('turn-right');
      expect(result?.distanceMeters).toBe(7000);
    });

    it('sin geometría decodificable degrada a la distancia del contrato', () => {
      const steps = [
        step({ geometryPolyline: 'geom-rota', distanceMeters: 500 }),
        step({ maneuver: 'turn-left' }),
      ];
      const result = upcomingManeuver(steps, DRIVER, decodeEnd);
      expect(result?.distanceMeters).toBe(500);
    });

    it('sin pasos → null (el banner no se pinta)', () => {
      expect(upcomingManeuver([], DRIVER, decodeEnd)).toBeNull();
    });
  });

  describe('greatCircleMeters', () => {
    it('distancia plausible en Lima (~1.1 km por 0.01° de longitud)', () => {
      const d = greatCircleMeters({ lat: -12.05, lon: -77.05 }, { lat: -12.05, lon: -77.04 });
      expect(d).toBeGreaterThan(1000);
      expect(d).toBeLessThan(1150);
    });
  });
});
