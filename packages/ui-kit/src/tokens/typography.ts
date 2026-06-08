import { Platform, type TextStyle } from 'react-native';

/**
 * Tipografía VEO para RN · dirección "Midnight Motion".
 *
 * Jerarquía grotesk fuerte: contraste por ESCALA + PESO (display/title bold 700, cuerpo 400,
 * label 600). Tamaños cómodos en móvil; nada de texto diminuto (mínimo efectivo 12pt en labels,
 * 14pt en cuerpo de lectura). `mono` tabular para datos: tarifas (céntimos PEN -> S/), ETAs,
 * timers, placas, IDs.
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
  /** Títulos / héroe: Clash Display Bold. */
  display: 'ClashDisplay-Bold',
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
  title1: {
    fontFamily: fontFamily.display,
    fontSize: fontSize['2xl'],
    lineHeight: 38,
    fontWeight: fontWeight.bold,
    letterSpacing: -0.6,
  },
  title2: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.xl,
    lineHeight: 32,
    fontWeight: fontWeight.bold,
    letterSpacing: -0.4,
  },
  title3: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.lg,
    lineHeight: 28,
    fontWeight: fontWeight.bold,
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
  /** Etiquetas cortas / pills (≤4 palabras). Bold + tracking (estilo grotesk en versalitas). */
  label: {
    fontFamily: fontFamily.textBold,
    fontSize: fontSize.xs,
    lineHeight: 16,
    fontWeight: fontWeight.bold,
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
