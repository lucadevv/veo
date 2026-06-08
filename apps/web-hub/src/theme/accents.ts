import type { AccentName } from '@/domain/ecosystem';

/**
 * Tokens cromáticos de cada acento, definidos UNA sola vez (SSOT).
 * Los componentes resuelven colores con `accentTokens(app.accent)` en lugar de
 * repartir hex por el árbol. Cambiar un acento se hace acá y se propaga solo.
 */
export interface AccentTokens {
  /** Color principal del acento (barra superior, relleno del CTA sólido). */
  readonly color: string;
  /** Color de texto/íconos legibles SOBRE el acento (para chips sólidos). */
  readonly onColor: string;
  /** Trazo del ícono según su contexto (sólido → onColor; fantasma → tono propio). */
  readonly iconStroke: string;
}

const TOKENS: Record<AccentName, AccentTokens> = {
  lime: { color: '#C8F230', onColor: '#0E1014', iconStroke: '#0E1014' },
  cyan: { color: '#39BCDF', onColor: '#0B111F', iconStroke: '#0B111F' },
  warm: { color: '#1F9BD4', onColor: '#0E1014', iconStroke: '#39BCDF' },
  neutral: { color: '#8A93A4', onColor: '#0E1014', iconStroke: '#CFD6E2' },
};

/** Resuelve los tokens de un acento. */
export function accentTokens(accent: AccentName): AccentTokens {
  return TOKENS[accent];
}
