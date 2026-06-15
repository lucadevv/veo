/**
 * Radios de esquina VEO. Refresh 2025 ("piel" más redondeada, alineada a la dirección visual de
 * referencia): tarjetas/inputs 16-20, sheets 24-32. Sigue siendo redondeo CONTROLADO (no cápsulas
 * salvo `pill`), premium sin caer en lo infantil. `pill` solo para botones de acción, chips y tags.
 */
export const radii = {
  none: 0,
  sm: 10,
  md: 16,
  lg: 20,
  xl: 24,
  '2xl': 32,
  pill: 999,
  full: 9999,
} as const;

export type Radii = typeof radii;
export type RadiusToken = keyof Radii;
