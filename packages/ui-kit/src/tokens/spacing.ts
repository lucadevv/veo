/**
 * Escala de espaciado VEO (base 4pt, alineada al sistema web 4/8 y al ritmo 16/24/32/48).
 * Compartida por ambos temas: el espacio es estructura, no marca.
 */
export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 48,
  '6xl': 64,
} as const;

export type Spacing = typeof spacing;
export type SpacingToken = keyof Spacing;

/** Área táctil mínima accesible (Apple HIG 44pt / Material 48dp). */
export const TOUCH_TARGET = 44;
