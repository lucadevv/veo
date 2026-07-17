import { trustColors } from '@veo/design-tokens';
import type { AccentName } from '@/domain/ecosystem';

/**
 * Tokens cromáticos del acento de marca. VEO es MONOMARCA: hay un único acento
 * (`brand` = teal de confianza #0075A9), y el valor viene del canon compartido
 * `@veo/design-tokens` — el hub NO declara hex propios. Los componentes resuelven
 * colores con `accentTokens(app.accent)` en vez de repartir hex por el árbol.
 * La diferenciación entre apps NO es cromática: la lleva el ícono, el nombre,
 * la etiqueta y `solid`.
 */
export interface AccentTokens {
  /** Teal de marca (barra superior, relleno del CTA sólido, trazo del ícono fantasma). */
  readonly color: string;
  /** Color legible SOBRE el teal de marca (texto/íconos de chips sólidos). */
  readonly onColor: string;
}

const TOKENS: Record<AccentName, AccentTokens> = {
  brand: { color: trustColors.brand, onColor: trustColors.onBrand },
};

/** Resuelve los tokens del acento de marca. */
export function accentTokens(accent: AccentName): AccentTokens {
  return TOKENS[accent];
}
