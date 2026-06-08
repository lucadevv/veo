import {
  formatManeuverDistance,
  isArrival,
  maneuverGlyph,
  type TripManeuver,
} from '../value-objects/maneuver';

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
});
