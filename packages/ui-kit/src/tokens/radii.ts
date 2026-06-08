/**
 * Radios de esquina VEO. Tarjetas/inputs 12-16 (regla del sistema web: nada sobre-redondeado).
 * `pill` solo para botones de acción y tags.
 */
export const radii = {
  none: 0,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 28,
  pill: 999,
  full: 9999,
} as const;

export type Radii = typeof radii;
export type RadiusToken = keyof Radii;
