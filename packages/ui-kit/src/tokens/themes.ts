import { type StatusBarStyle } from 'react-native';
import { trustColors, type SemanticColors } from '@veo/design-tokens';
import { spacing, type Spacing } from './spacing';
import { radii, type Radii } from './radii';
import { motion, type Motion } from './motion';
import { typography, type Typography } from './typography';

/**
 * Colores semánticos VEO (mismo contrato en todos los temas para que los componentes no
 * ramifiquen). La fuente ÚNICA es `@veo/design-tokens` (TASK-016): este alias conserva el
 * nombre histórico del contrato de ui-kit. NUNCA hardcodear color en componentes: usar esto.
 */
export type ThemeColors = SemanticColors;

/** Token de elevación (iOS shadow* + Android elevation). */
export interface ElevationToken {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
}

export interface Elevation {
  /** Sin sombra (superficie plana). */
  level0: ElevationToken;
  /** Tarjetas. */
  level1: ElevationToken;
  /** Elementos flotantes / sheets bajos. */
  level2: ElevationToken;
  /** Modales / bottom sheets. */
  level3: ElevationToken;
}

export interface Theme {
  name: 'passenger' | 'driver';
  scheme: 'light' | 'dark';
  /** Estilo de barra de estado recomendado para este tema. */
  statusBarStyle: StatusBarStyle;
  colors: ThemeColors;
  spacing: Spacing;
  radii: Radii;
  typography: Typography;
  elevation: Elevation;
  motion: Motion;
}

/* ── "Theme de Confianza" · DÍA, acento TEAL #0075A9 — UN SOLO canon (passenger ≡ driver) ──────
 * Desde TASK-016 (2026-07-16) ambos temas light consumen `trustColors` de @veo/design-tokens:
 * este archivo YA NO declara hex para el día. El canon es el passengerColors histórico + las 3
 * correcciones ratificadas por el dueño:
 *   1. success/safe #00C853 en todo el sistema (murió el jade #17C08A del passenger;
 *      montos celebratorios = accentStrong #009624),
 *   2. inkMuted unificado #647386 (murió el drift #6B7A8F del driver),
 *   3. info alineado a la familia #0097CE (el passenger mezclaba info #007FAE con
 *      infoDim rgba(0,151,206,·)).
 * Contraste AA verificado en el propio paquete (ver docstring de `trustColors`).
 * La paleta NOCHE histórica del conductor sigue abajo intacta (`driverDarkColors`). */
const passengerColors: ThemeColors = trustColors;
const driverColors: ThemeColors = trustColors;

/* Paleta NOCHE histórica del conductor (azul eléctrico #2D7FF9 sobre near-black #0A0B0F).
 * Conservada íntegra para un eventual toggle día/noche; hoy el driverTheme usa `driverColors` (light). */
export const driverDarkColors: ThemeColors = {
  bg: '#0A0B0F',
  surface: '#14161C',
  surfaceElevated: '#1E212A',
  surfaceMuted: '#1E212A',
  ink: '#F5F7FA',
  inkMuted: '#C4CBD6',
  inkSubtle: '#8A929E',
  border: '#1C1F27',
  borderStrong: '#2B2F3A',
  brand: '#2D7FF9',
  brandHover: '#1E6AE0',
  onBrand: '#FFFFFF',
  accent: '#2D7FF9',
  accentHover: '#5598FB',
  onAccent: '#FFFFFF',
  safe: '#17C08A',
  onSafe: '#04160D',
  success: '#17C08A',
  onSuccess: '#04160D',
  successText: '#3FD9A3',
  warn: '#F2AF48',
  onWarn: '#201301',
  warnText: '#F2AF48',
  danger: '#FF4D6A',
  dangerHover: '#E63A56',
  onDanger: '#1A0306',
  info: '#2AA9E0',
  onInfo: '#04121A',
  focus: '#2D7FF9',
  overlay: 'rgba(5,7,12,0.7)',
  skeleton: '#14161C',
  skeletonHighlight: '#1E212A',
  brandDim: 'rgba(45,127,249,0.16)',
  brandDeep: '#0A1A2A',
  successDim: 'rgba(23,192,138,0.16)',
  accentStrong: '#12B37A',
  warnDim: 'rgba(242,175,72,0.16)',
  dangerDim: 'rgba(255,77,106,0.16)',
  infoDim: 'rgba(42,169,224,0.16)',
  divider: '#1C1F27',
};

/**
 * Color CANÓNICO de la sombra tintada de la identidad Trust (azul-gris ink): las sombras nunca son
 * negras puras. Exportado para las sombras custom de las apps (tab bars, sheets, chips de mapa) que
 * no pasan por `theme.elevation` — una sola fuente, cero hex sueltos.
 */
export const ELEVATION_SHADOW_COLOR = trustColors.ink;

// Theme de Confianza (día): la elevación se expresa con sombra SUAVE teñida de azul-gris (#1A2332)
// + borde, no sombras negras pesadas. Opacidades bajas para no ensuciar el lienzo claro.
const passengerElevation: Elevation = {
  level0: {
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  level1: {
    shadowColor: ELEVATION_SHADOW_COLOR,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  level2: {
    shadowColor: ELEVATION_SHADOW_COLOR,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 8,
  },
  level3: {
    shadowColor: ELEVATION_SHADOW_COLOR,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.14,
    shadowRadius: 30,
    elevation: 18,
  },
};

// Theme de Confianza (día) para el conductor: misma elevación suave teñida de azul-gris que el
// passenger (sombra + borde, no negras pesadas). Espejo de `passengerElevation`.
const driverElevation: Elevation = {
  level0: {
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  level1: {
    shadowColor: ELEVATION_SHADOW_COLOR,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  level2: {
    shadowColor: ELEVATION_SHADOW_COLOR,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 8,
  },
  level3: {
    shadowColor: ELEVATION_SHADOW_COLOR,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.14,
    shadowRadius: 30,
    elevation: 18,
  },
};

// Elevación NOCHE histórica (sombras negras densas), conservada junto a `driverDarkColors`.
export const driverDarkElevation: Elevation = {
  level0: {
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  level1: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 2,
  },
  level2: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
  },
  level3: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.6,
    shadowRadius: 28,
    elevation: 18,
  },
};

export const passengerTheme: Theme = {
  name: 'passenger',
  scheme: 'light',
  statusBarStyle: 'dark-content',
  colors: passengerColors,
  spacing,
  radii,
  typography,
  elevation: passengerElevation,
  motion,
};

export const driverTheme: Theme = {
  name: 'driver',
  scheme: 'light',
  statusBarStyle: 'dark-content',
  colors: driverColors,
  spacing,
  radii,
  typography,
  elevation: driverElevation,
  motion,
};

/** Mapa de temas por nombre, para selección dinámica. */
export const themes = {
  passenger: passengerTheme,
  driver: driverTheme,
} as const;

export type ThemeName = keyof typeof themes;

/**
 * Tokens para dibujar la ruta y los markers en el lienzo del mapa (MapLibre/react-native-maps).
 * El ui-kit no monta el mapa (lo inyecta la app), pero centraliza el estilo para que la ruta
 * azul de marca VEO sea consistente. La pantalla pasa estos valores a la capa de línea.
 */
export interface MapRouteTokens {
  /** Color de la polyline de ruta activa. */
  routeColor: string;
  /** Anchura recomendada de la polyline (px). */
  routeWidth: number;
  /** Color del "glow" (halo) bajo la ruta, con alpha. */
  routeGlowColor: string;
  /** Anchura del glow (debe ser > routeWidth). */
  routeGlowWidth: number;
  /** Color del marker/punto de origen. */
  originColor: string;
  /** Color del marker/punto de destino. */
  destinationColor: string;
  /** Color del punto de ubicación del usuario ("location dot"). */
  userDotColor: string;
}

export const passengerMapRoute: MapRouteTokens = {
  routeColor: trustColors.brand,
  routeWidth: 6,
  // Glow = brand #0075A9 al 30% (rgba literal: MapLibre recibe el string tal cual).
  routeGlowColor: 'rgba(0,117,169,0.30)',
  routeGlowWidth: 14,
  originColor: trustColors.brand,
  destinationColor: trustColors.brand,
  userDotColor: trustColors.brand,
};

/**
 * Tokens de ruta para el CONDUCTOR. Tras la migración Trust, misma marca TEAL #0075A9 que el pasajero
 * sobre el mapa claro Daylight Trust (halo translúcido + línea nítida); se mantiene como export propio
 * para que la app del conductor lo importe por nombre, pero los valores son idénticos a
 * `passengerMapRoute` (una sola marca).
 */
export const driverMapRoute: MapRouteTokens = {
  routeColor: trustColors.brand,
  routeWidth: 6,
  // Glow = brand #0075A9 al 35% (rgba literal: MapLibre recibe el string tal cual).
  routeGlowColor: 'rgba(0,117,169,0.35)',
  routeGlowWidth: 14,
  originColor: trustColors.brand,
  destinationColor: trustColors.brand,
  userDotColor: trustColors.brand,
};
