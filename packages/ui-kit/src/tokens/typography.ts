import { Platform, type TextStyle } from 'react-native';

/**
 * Tipografía VEO para RN · dirección "Midnight Motion".
 *
 * Jerarquía grotesk fuerte por ESCALA + PESO, con la gama completa de Clash Display (igual que el
 * admin-web): `display`/números héroe → Clash **Bold 700**; `title1/2/3`/títulos de texto → Clash
 * **Semibold 600**; `label`/eyebrows → Clash **Medium 500**; cuerpo → Outfit 400. Tamaños cómodos
 * en móvil; nada de texto diminuto (mínimo efectivo 12pt en labels, 14pt en cuerpo de lectura).
 * `mono` tabular para datos: tarifas (céntimos PEN -> S/), ETAs, timers, placas, IDs.
 *
 * Fuentes de marca VEO (bundleadas en la app pasajero):
 *   - Títulos / display: **Clash Display Bold** (Fontshare, licencia Fontshare Free).
 *   - Interfaz / cuerpo: **Outfit** (Google Fonts, OFL) en pesos Regular/Medium/SemiBold/Bold.
 *
 * Nombres PostScript REALES (leídos de la tabla `name` de los .otf/.ttf, NO adivinados):
 *   ClashDisplay-Bold · Outfit-Regular · Outfit-Medium · Outfit-SemiBold · Outfit-Bold.
 *
 * Por qué familia POR PESO en lugar de `fontWeight`: con caras estáticas nombradas, iOS resuelve
 * por el nombre PostScript e IGNORA `fontWeight`; Android resuelve por nombre de archivo. Para que
 * cada rol renderice su peso correcto, cada rol apunta a la cara exacta. `fontWeight` se mantiene
 * como fallback semántico (y para el render del sistema antes de que la app bundlee las fuentes).
 *
 * Linking nativo: la app pasajero declara `assets: ['./assets/fonts']` en `react-native.config.js`,
 * copia los .ttf/.otf a iOS (UIAppFonts) y Android (assets/fonts/). Hasta que el dueño RECOMPILE,
 * la fuente no está en el bundle y RN cae a la grotesk del sistema (silencioso en iOS) — esperado.
 */

type FontWeight = NonNullable<TextStyle['fontWeight']>;

/**
 * Familias de marca por rol/peso. Cada entrada es el nombre PostScript (iOS) / nombre de archivo
 * sin extensión (Android) de la cara correspondiente.
 *
 * `display` → Clash Display Bold (títulos héroe). `text*` → Outfit por peso. `mono` → sistema.
 */
export const fontFamily = {
  /** Números / héroe: Clash Display Bold (tarifa total, ETA grande — el peso máximo). */
  display: 'ClashDisplay-Bold',
  /**
   * Títulos de TEXTO: Clash Display Semibold (600). Escalón por debajo del `display` bold — da la
   * misma jerarquía que el admin-web (números/marca bold, títulos de texto semibold). Nombre
   * PostScript verificado con `mdls` (no adivinado): `ClashDisplay-Semibold`. Cara ya bundleada y
   * registrada en UIAppFonts (iOS) / assets/fonts (Android) de passenger y driver.
   */
  displaySemibold: 'ClashDisplay-Semibold',
  /** Clash Display Medium (500): eyebrows/labels cortos en versalitas. PostScript verificado. */
  displayMedium: 'ClashDisplay-Medium',
  /** Clash Display Regular (400): display en tono más liviano si hace falta. PostScript verificado. */
  displayRegular: 'ClashDisplay-Regular',
  /**
   * Display serif editorial: Fraunces 72pt SemiBold (óptico 72pt, OFL).
   * Nombre PostScript REAL leído de la tabla `name` (fc-scan): `Fraunces72pt-SemiBold`.
   * Cara única. Convive con `display` grotesk (NO lo reemplaza): se usa solo en variants
   * `displayEditorial`/`titleEditorial` para títulos héroe de tono editorial.
   */
  displaySerif: 'Fraunces72pt-SemiBold',
  /** Cuerpo (peso 400). Alias histórico de `textRegular`. */
  text: 'Outfit-Regular',
  textRegular: 'Outfit-Regular',
  textMedium: 'Outfit-Medium',
  textSemibold: 'Outfit-SemiBold',
  textBold: 'Outfit-Bold',
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
} as const;

/** Escala de tamaño (alineada a la web: 12 14 16 18 20 24 30 36 48). Base 16. */
export const fontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  md: 18,
  lg: 20,
  xl: 24,
  '2xl': 30,
  '3xl': 36,
  '4xl': 48,
} as const;

export const fontWeight = {
  regular: '400' as FontWeight,
  medium: '500' as FontWeight,
  semibold: '600' as FontWeight,
  bold: '700' as FontWeight,
} as const;

/** Estilo tipográfico componible (subset de TextStyle, aplicable directo a <Text>). */
export interface TextToken {
  fontFamily: string | undefined;
  fontSize: number;
  lineHeight: number;
  fontWeight: FontWeight;
  letterSpacing: number;
}

/**
 * Roles tipográficos (estilo Dynamic Type / Material type roles). Los componentes consumen
 * estos presets en vez de definir tamaños sueltos.
 */
export const textStyles = {
  /** Números/héroe: tarifa total, ETA grande. Peso máximo, tracking negativo (grotesk apretada). */
  display: {
    fontFamily: fontFamily.display,
    fontSize: fontSize['4xl'],
    lineHeight: 52,
    fontWeight: fontWeight.bold,
    letterSpacing: -1,
  },
  /**
   * Display editorial (serif): mismo tamaño/altura/peso que `display`, pero Fraunces serif y
   * tracking más suelto (-0.5 vs -1): las serif piden menos compresión que la grotesk apretada.
   */
  displayEditorial: {
    fontFamily: fontFamily.displaySerif,
    fontSize: fontSize['4xl'],
    lineHeight: 52,
    fontWeight: fontWeight.bold,
    letterSpacing: -0.5,
  },
  title1: {
    fontFamily: fontFamily.displaySemibold,
    fontSize: fontSize['2xl'],
    lineHeight: 38,
    fontWeight: fontWeight.semibold,
    letterSpacing: -0.6,
  },
  /** Título editorial (serif): paralelo a `title1` con Fraunces y tracking más suelto (-0.3). */
  titleEditorial: {
    fontFamily: fontFamily.displaySerif,
    fontSize: fontSize['2xl'],
    lineHeight: 38,
    fontWeight: fontWeight.bold,
    letterSpacing: -0.3,
  },
  title2: {
    fontFamily: fontFamily.displaySemibold,
    fontSize: fontSize.xl,
    lineHeight: 32,
    fontWeight: fontWeight.semibold,
    letterSpacing: -0.4,
  },
  title3: {
    fontFamily: fontFamily.displaySemibold,
    fontSize: fontSize.lg,
    lineHeight: 28,
    fontWeight: fontWeight.semibold,
    letterSpacing: -0.3,
  },
  headline: {
    fontFamily: fontFamily.textSemibold,
    fontSize: fontSize.md,
    lineHeight: 24,
    fontWeight: fontWeight.semibold,
    letterSpacing: -0.2,
  },
  body: {
    fontFamily: fontFamily.text,
    fontSize: fontSize.base,
    lineHeight: 24,
    fontWeight: fontWeight.regular,
    letterSpacing: 0,
  },
  bodyStrong: {
    fontFamily: fontFamily.textSemibold,
    fontSize: fontSize.base,
    lineHeight: 24,
    fontWeight: fontWeight.semibold,
    letterSpacing: -0.1,
  },
  callout: {
    fontFamily: fontFamily.text,
    fontSize: fontSize.sm,
    lineHeight: 22,
    fontWeight: fontWeight.regular,
    letterSpacing: 0,
  },
  subhead: {
    fontFamily: fontFamily.textMedium,
    fontSize: fontSize.sm,
    lineHeight: 20,
    fontWeight: fontWeight.medium,
    letterSpacing: 0,
  },
  footnote: {
    fontFamily: fontFamily.text,
    fontSize: fontSize.sm,
    lineHeight: 20,
    fontWeight: fontWeight.regular,
    letterSpacing: 0,
  },
  caption: {
    fontFamily: fontFamily.textMedium,
    fontSize: fontSize.xs,
    lineHeight: 16,
    fontWeight: fontWeight.medium,
    letterSpacing: 0.2,
  },
  /**
   * Etiquetas cortas / pills / eyebrows (≤4 palabras). Clash Display Medium + tracking — versalitas
   * de marca (mismo criterio que los eyebrows/headers del admin-web). El display da carácter donde
   * Outfit-Bold quedaba genérico; a 12pt con tracking 0.6 la Medium se lee sin pesar.
   */
  label: {
    fontFamily: fontFamily.displayMedium,
    fontSize: fontSize.xs,
    lineHeight: 16,
    fontWeight: fontWeight.medium,
    letterSpacing: 0.6,
  },
} satisfies Record<string, TextToken>;

export type TextStyleToken = keyof typeof textStyles;

export const typography = {
  fontFamily,
  fontSize,
  fontWeight,
  text: textStyles,
} as const;

export type Typography = typeof typography;
