/**
 * Lógica pura para traducir la intensidad de demanda (0..1) de una celda del mapa de calor a estilo
 * visual (opacidad del relleno cian y nivel discreto para la leyenda). Vive en el dominio para poder
 * probarse sin renderizar el mapa y mantener la pantalla declarativa.
 */

/** Nivel discreto de demanda para la leyenda (de menor a mayor). */
export type DemandLevel = 'low' | 'medium' | 'high';

/** Acota un número al rango [0, 1] (defensa ante datos fuera de contrato). */
export function clampIntensity(intensity: number): number {
  if (Number.isNaN(intensity)) {
    return 0;
  }
  return Math.min(1, Math.max(0, intensity));
}

/**
 * Opacidad del relleno de la celda según intensidad. Mapea [0,1] a un rango legible en modo noche:
 * incluso la celda más fría es perceptible (piso 0.12) y la más caliente no satura (techo 0.6),
 * para que el mapa subyacente siga leyéndose. Redondeada a 2 decimales (estable para snapshots/tests).
 */
export function intensityToOpacity(intensity: number): number {
  const FLOOR = 0.12;
  const CEIL = 0.6;
  const value = FLOOR + clampIntensity(intensity) * (CEIL - FLOOR);
  return Math.round(value * 100) / 100;
}

/**
 * Radio (en metros) del círculo de la celda según intensidad: las celdas más calientes se dibujan
 * un poco más grandes para captar la atención. Base 180 m → hasta 320 m en la más caliente.
 */
export function intensityToRadiusMeters(intensity: number): number {
  const BASE = 180;
  const MAX_EXTRA = 140;
  return Math.round(BASE + clampIntensity(intensity) * MAX_EXTRA);
}

/** Nivel discreto para la leyenda: <0.34 bajo, <0.67 medio, resto alto. */
export function intensityLevel(intensity: number): DemandLevel {
  const value = clampIntensity(intensity);
  if (value < 0.34) {
    return 'low';
  }
  if (value < 0.67) {
    return 'medium';
  }
  return 'high';
}
