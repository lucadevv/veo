import type { AccentName } from '@/domain/ecosystem';

/**
 * Tokens cromáticos del acento de marca, definidos UNA sola vez (SSOT).
 * VEO es MONOMARCA: hay un único acento (`brand` = azul #2D7FF9). Los componentes
 * resuelven colores con `accentTokens(app.accent)` en vez de repartir hex por el
 * árbol — el color de marca vive acá y se propaga solo. La diferenciación entre
 * apps NO es cromática: la lleva el ícono, el nombre, la etiqueta y `solid`.
 */
export interface AccentTokens {
  /** Azul de marca (barra superior, relleno del CTA sólido, trazo del ícono fantasma). */
  readonly color: string;
  /** Color legible SOBRE el azul de marca (texto/íconos de chips sólidos). */
  readonly onColor: string;
}

const TOKENS: Record<AccentName, AccentTokens> = {
  brand: { color: '#2D7FF9', onColor: '#FFFFFF' },
};

/** Resuelve los tokens del acento de marca. */
export function accentTokens(accent: AccentName): AccentTokens {
  return TOKENS[accent];
}
