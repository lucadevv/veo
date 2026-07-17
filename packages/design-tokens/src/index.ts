/**
 * @veo/design-tokens · Identidad "Trust" de VEO — la ÚNICA fuente de color del sistema.
 *
 * TS puro y platform-agnostic (cero imports de RN/DOM/Node): lo consumen
 *   · `@veo/ui-kit` (React Native: passenger + driver) — `themes.ts` arma sus temas desde acá, y
 *   · `scripts/generate-css.mjs` — regenera `packages/shared-config/tailwind/tokens.css` (web).
 *
 * Canon = el `passengerColors` histórico de ui-kit ("Theme de Confianza" DÍA, acento teal #0075A9)
 * + 3 correcciones ratificadas por el dueño (2026-07-16), que dejan passenger ≡ driver:
 *   1. success/safe = #00C853 en TODO el sistema (muere el jade #17C08A del passenger);
 *      los montos celebratorios usan `accentStrong` #009624.
 *   2. `inkMuted` unificado en #647386 (muere el drift #6B7A8F del driver).
 *   3. `info` alineado a la familia #0097CE como el driver (el passenger mezclaba
 *      info #007FAE con infoDim rgba(0,151,206,·) — familias distintas en el mismo rol).
 *
 * Contraste WCAG 2.1 verificado (ratios reales):
 *   · ink #1A2332 sobre bg #F5F7FA → 13.9:1 (AAA)
 *   · inkMuted #647386 sobre bg #F5F7FA → 4.51:1 (pasa AA texto normal ≥4.5)
 *   · onBrand #FFFFFF sobre brand/accent #0075A9 → 4.7:1 (AA normal)
 *   · onDanger #FFFFFF sobre danger #D11216 → 5.0:1
 *   · onSafe #04160D sobre safe/success #00C853 → 7.7:1
 *   · onInfo #FFFFFF sobre info #0097CE → 3.3:1 (solo AA-large: info rellena badges/íconos,
 *     no texto de lectura; el texto informativo sobre blanco usa la tinta normal)
 *
 * NUNCA hardcodear hex en componentes ni en CSS de apps: consumir estos tokens
 * (en RN vía `theme.colors.*`, en web vía las vars CSS generadas).
 */

/**
 * Contrato de color semántico del sistema (mismo shape en todos los temas para que los
 * componentes no ramifiquen). `@veo/ui-kit` lo re-exporta como `ThemeColors`.
 */
export interface SemanticColors {
  /** Fondo de pantalla. */
  bg: string;
  /** Superficie de tarjetas/sheets. */
  surface: string;
  /** Capa elevada (sheets sobre tarjetas, inputs). */
  surfaceElevated: string;
  /** Superficie recesada/atenuada (gris sutil): discos de icono, tracks, rellenos hundidos sobre
   * tarjetas blancas. Resuelve la colisión surfaceElevated===surface===#FFFFFF en el tema claro. */
  surfaceMuted: string;
  /** Texto primario. */
  ink: string;
  /** Texto secundario. */
  inkMuted: string;
  /** Texto terciario / placeholders. */
  inkSubtle: string;
  /** Bordes y divisores. */
  border: string;
  /** Borde reforzado (foco de campo, énfasis). */
  borderStrong: string;
  /** Color de marca VEO = teal de confianza #0075A9 (mismo en todos los productos; "una sola marca"). */
  brand: string;
  brandHover: string;
  onBrand: string;
  /** Color de acción/acento = el mismo teal de marca (uso DISCIPLINADO: acción primaria, ruta, activos). */
  accent: string;
  accentHover: string;
  onAccent: string;
  /** Verde de confianza/seguridad (passenger) · success (driver). Mismo valor que `success`. */
  safe: string;
  onSafe: string;
  success: string;
  onSuccess: string;
  /** Texto de estado "éxito" legible sobre blanco (más oscuro que el punto brillante `success`). */
  successText: string;
  warn: string;
  onWarn: string;
  /** Texto de estado "aviso" legible sobre blanco (más oscuro que el punto brillante `warn`). */
  warnText: string;
  danger: string;
  dangerHover: string;
  onDanger: string;
  /** Info / informativo-neutro (trust-info #0097CE del board de identidad visual). */
  info: string;
  onInfo: string;
  /** Anillo de foco accesible. */
  focus: string;
  /** Scrim de modales/sheets (40-60% para aislar el foreground). */
  overlay: string;
  /** Base y brillo del shimmer/skeleton. */
  skeleton: string;
  skeletonHighlight: string;

  /* ── Capa de CONTAINERS / tints (estilo Material `*Container`) ───────────────────────────────
   * Los tints de estado que el board de identidad usa (#XXXXXX14/16): chips, toggles, badges,
   * avatares, banners tintados, nav activo. Son el "sabor" del sistema. */
  /** Container del primary (teal ~8%): chips, toggles, badges, avatar, item de nav activo. */
  brandDim: string;
  /** Primary PROFUNDO (teal oscuro #00313C): héroes, énfasis máximo, superficies de marca. */
  brandDeep: string;
  /** Container del verde de acción/success (~10%): badge de éxito, "verificado", check. */
  successDim: string;
  /** Verde de acción PROFUNDO: montos de ganancia celebratorios (neto de viaje, liquidación). */
  accentStrong: string;
  /** Container ámbar (warn ~10%): pill "vence en…", avisos leves. */
  warnDim: string;
  /** Container rojo (danger ~8%): "cerrar sesión", finalizar, estados críticos tintados. */
  dangerDim: string;
  /** Container cian informativo (info ~10%): banners info, badges neutros de dato. */
  infoDim: string;
  /** Divisor sutil (#E8ECF1, más claro que `border`): separadores de filas dentro de cards. */
  divider: string;
}

export type SemanticColorToken = keyof SemanticColors;

/**
 * Canon "Theme de Confianza" · DÍA (Trust light). Lienzo claro (canvas #F5F7FA, tarjetas blancas
 * delineadas por borde #DDE1E7 — estética Trust plana, sin sombras pesadas) y un único acento
 * TEAL de confianza #0075A9 de uso DISCIPLINADO; cuando rellena, el texto es BLANCO.
 * El POSITIVO es el verde de confianza #00C853 (board veo.pen), reservado a momentos positivos.
 */
export const trustColors: SemanticColors = {
  bg: '#F5F7FA',
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  surfaceMuted: '#EEF1F5',
  ink: '#1A2332',
  inkMuted: '#647386',
  inkSubtle: '#B0BEC5',
  border: '#DDE1E7',
  borderStrong: '#C5CDD6',
  brand: '#0075A9',
  brandHover: '#005A82',
  onBrand: '#FFFFFF',
  accent: '#0075A9',
  accentHover: '#4A9BC7',
  onAccent: '#FFFFFF',
  safe: '#00C853',
  onSafe: '#04160D',
  success: '#00C853',
  onSuccess: '#04160D',
  successText: '#00873A',
  warn: '#FFA000',
  onWarn: '#3A2600',
  warnText: '#B26A00',
  danger: '#D11216',
  dangerHover: '#B10E12',
  onDanger: '#FFFFFF',
  info: '#0097CE',
  onInfo: '#FFFFFF',
  focus: '#0075A9',
  overlay: 'rgba(26,35,50,0.45)',
  skeleton: '#E8ECF1',
  skeletonHighlight: '#F5F7FA',
  brandDim: 'rgba(0,117,169,0.08)',
  brandDeep: '#00313C',
  successDim: 'rgba(0,200,83,0.10)',
  accentStrong: '#009624',
  warnDim: 'rgba(255,160,0,0.10)',
  dangerDim: 'rgba(209,18,22,0.08)',
  infoDim: 'rgba(0,151,206,0.10)',
  divider: '#E8ECF1',
};
