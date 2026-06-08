import {
  clampIntensity,
  intensityLevel,
  intensityToOpacity,
  intensityToRadiusMeters,
} from '../value-objects/heatmap-intensity';

describe('heatmap-intensity', () => {
  describe('clampIntensity', () => {
    it('acota al rango [0,1] y trata NaN como 0', () => {
      expect(clampIntensity(-0.5)).toBe(0);
      expect(clampIntensity(0)).toBe(0);
      expect(clampIntensity(0.5)).toBe(0.5);
      expect(clampIntensity(1)).toBe(1);
      expect(clampIntensity(1.5)).toBe(1);
      expect(clampIntensity(Number.NaN)).toBe(0);
    });
  });

  describe('intensityToOpacity', () => {
    it('mapea [0,1] al rango legible [0.12, 0.6]', () => {
      expect(intensityToOpacity(0)).toBe(0.12);
      expect(intensityToOpacity(1)).toBe(0.6);
      // Punto medio: 0.12 + 0.5*0.48 = 0.36.
      expect(intensityToOpacity(0.5)).toBe(0.36);
    });

    it('es monótona creciente con la intensidad', () => {
      expect(intensityToOpacity(0.2)).toBeLessThan(intensityToOpacity(0.8));
    });

    it('acota intensidades fuera de rango', () => {
      expect(intensityToOpacity(-1)).toBe(0.12);
      expect(intensityToOpacity(2)).toBe(0.6);
    });
  });

  describe('intensityToRadiusMeters', () => {
    it('crece de 180 m a 320 m con la intensidad', () => {
      expect(intensityToRadiusMeters(0)).toBe(180);
      expect(intensityToRadiusMeters(1)).toBe(320);
      expect(intensityToRadiusMeters(0.5)).toBe(250);
    });
  });

  describe('intensityLevel', () => {
    it('clasifica en bajo / medio / alto', () => {
      expect(intensityLevel(0)).toBe('low');
      expect(intensityLevel(0.33)).toBe('low');
      expect(intensityLevel(0.34)).toBe('medium');
      expect(intensityLevel(0.66)).toBe('medium');
      expect(intensityLevel(0.67)).toBe('high');
      expect(intensityLevel(1)).toBe('high');
    });
  });
});
