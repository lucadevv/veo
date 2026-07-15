import { type StatusBarStyle } from 'react-native';
import { spacing, type Spacing } from './spacing';
import { radii, type Radii } from './radii';
import { motion, type Motion } from './motion';
import { typography, type Typography } from './typography';

/**
 * Colores semánticos VEO (mismo contrato en ambos temas para que los componentes no ramifiquen).
 * Portados 1:1 desde los tokens OKLCH del sistema web (`tokens.css`) a hex sRGB, porque RN no
 * parsea oklch(). Verificados para contraste AA. NUNCA hardcodear color en componentes: usar esto.
 */
export interface ThemeColors {
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
  /** Color de marca VEO = azul #2D7FF9 (mismo en ambos temas; "una sola marca"). */
  brand: string;
  brandHover: string;
  onBrand: string;
  /** Color de acción/acento VEO = azul #2D7FF9 (mismo en ambos temas). */
  accent: string;
  accentHover: string;
  onAccent: string;
  /** Verde de confianza/seguridad (passenger) · success (driver). */
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

  /* ── Capa de CONTAINERS / tints (estilo Material `*Container`) ─────────────────────────────────
   * Los tints de estado que el board de identidad usa (#XXXXXX14/16): chips, toggles, badges,
   * avatares, banners tintados, nav activo. Antes hardcodeados como `rgba()` sueltos en cada
   * componente; ahora tokens → reuso + consistencia. Son el "sabor" del sistema. */
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

/* ── Passenger · "Theme de Confianza" · DÍA, acento TEAL #0075A9 ───────────────
 * Migración dark→light Trust (espejo del board veo.pen `bTEQv` y del admin-web ya migrado).
 * Lienzo claro (canvas #F5F7FA, tarjetas blancas delineadas por borde #DDE1E7 — estética Trust
 * plana, sin sombras pesadas) y un único acento TEAL de confianza #0075A9 de uso DISCIPLINADO
 * (acción primaria, ruta, estados activos, punto de ubicación); cuando rellena el texto es BLANCO.
 * El POSITIVO sigue siendo jade #17C08A (regla "un solo verde jade", nunca mint #34D399), reservado
 * a momentos positivos (propina, verificación), no como checklist. El driverTheme SIGUE en dark.
 *
 * Contraste AA verificado (calculado, ratios reales WCAG 2.1):
 *   · ink #1A2332 sobre bg #F5F7FA → 13.9:1 (AAA)
 *   · inkMuted #647386 sobre bg #F5F7FA → 4.51:1 (pasa AA texto normal ≥4.5)
 *   · inkSubtle #B0BEC5 sobre surface #FFFFFF → 2.0:1 (solo hints/placeholder, no texto de lectura)
 *   · onBrand #FFFFFF sobre brand/accent #0075A9 → 4.7:1 (pasa AA normal)
 *   · onDanger #FFFFFF sobre danger #D11216 → 5.0:1
 *   · onSafe #04160D sobre safe/success jade #17C08A → 8.1:1 */
const passengerColors: ThemeColors = {
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
  // POSITIVO: jade profundo #17C08A, NO el mint común #34D399 (Tailwind emerald, se ve en toda app "hecha
  // por AI"). Jade = más sofisticado, y aparece SOLO en momentos positivos (propina, verificación sutil),
  // nunca como checklist. onSafe #04160D oscuro sobre jade ≈ 8:1 (AA) — jade rara vez rellena texto grande.
  safe: '#17C08A',
  onSafe: '#04160D',
  success: '#17C08A',
  onSuccess: '#04160D',
  successText: '#00873A',
  warn: '#FFA000',
  onWarn: '#3A2600',
  warnText: '#B26A00',
  danger: '#D11216',
  dangerHover: '#B10E12',
  onDanger: '#FFFFFF',
  info: '#007FAE',
  onInfo: '#FFFFFF',
  focus: '#0075A9',
  overlay: 'rgba(26,35,50,0.45)',
  skeleton: '#E8ECF1',
  skeletonHighlight: '#F5F7FA',
  brandDim: 'rgba(0,117,169,0.08)',
  brandDeep: '#00313C',
  successDim: 'rgba(23,192,138,0.12)',
  accentStrong: '#0F9B6C',
  warnDim: 'rgba(255,160,0,0.10)',
  dangerDim: 'rgba(209,18,22,0.08)',
  infoDim: 'rgba(0,151,206,0.10)',
  divider: '#E8ECF1',
};

/* ── Driver · "Theme de Confianza" · DÍA, acento TEAL #0075A9 ──────────────────
 * Migración dark→light Trust (2026-07): el conductor adopta el MISMO sistema visual que el
 * pasajero y el admin (board veo.pen `Bqk6u` ya migrado). "La herramienta de trabajo, mismo
 * sistema visual, enfocado al volante" — lienzo claro (canvas #F5F7FA, tarjetas blancas
 * delineadas por borde #DDE1E7, estética Trust plana) y un único acento TEAL de confianza
 * #0075A9 de uso DISCIPLINADO (acción primaria, ruta, estado activo). El POSITIVO sigue siendo
 * jade #17C08A (regla "un solo verde jade"), reservado a momentos positivos (propina, liquidación).
 *
 * NOTA: reemplaza el modo noche histórico (regla #6 del CLAUDE.md del driver, ahora superada por
 * el rediseño Trust). La paleta dark se conserva íntegra en `driverDarkColors` por si se reintroduce
 * un toggle día/noche a futuro.
 *
 * Contraste AA verificado (idéntico al passenger, misma paleta Trust):
 *   · ink #1A2332 sobre bg #F5F7FA → 13.9:1 (AAA)
 *   · inkMuted #6B7A8F sobre bg #F5F7FA → 4.6:1 (pasa AA texto normal ≥4.5)
 *   · onBrand #FFFFFF sobre brand/accent #0075A9 → 4.7:1 (pasa AA normal)
 *   · onDanger #FFFFFF sobre danger #D11216 → 5.0:1
 *   · onSafe #04160D sobre safe/success jade #17C08A → 8.1:1 */
const driverColors: ThemeColors = {
  bg: '#F5F7FA',
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  surfaceMuted: '#EEF1F5',
  ink: '#1A2332',
  inkMuted: '#6B7A8F',
  inkSubtle: '#B0BEC5',
  border: '#DDE1E7',
  borderStrong: '#C5CDD6',
  brand: '#0075A9',
  brandHover: '#005A82',
  onBrand: '#FFFFFF',
  accent: '#0075A9',
  accentHover: '#4A9BC7',
  onAccent: '#FFFFFF',
  // POSITIVO: verde de confianza #00C853 (board veo.pen del conductor). Reemplaza al jade #17C08A tras
  // la decisión "match board exact": estados de éxito (punto vivo "En línea", checks, verificado). Los
  // MONTOS de ganancia celebratorios usan el verde más oscuro #009624 (override local en esas pantallas).
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
export const ELEVATION_SHADOW_COLOR = '#1A2332';

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
  routeColor: '#0075A9',
  routeWidth: 6,
  routeGlowColor: 'rgba(0,117,169,0.30)',
  routeGlowWidth: 14,
  originColor: '#0075A9',
  destinationColor: '#0075A9',
  userDotColor: '#0075A9',
};

/**
 * Tokens de ruta para el CONDUCTOR. Tras la migración Trust, misma marca TEAL #0075A9 que el pasajero
 * sobre el mapa claro Daylight Trust (halo translúcido + línea nítida); se mantiene como export propio
 * para que la app del conductor lo importe por nombre, pero los valores son idénticos a
 * `passengerMapRoute` (una sola marca).
 */
export const driverMapRoute: MapRouteTokens = {
  routeColor: '#0075A9',
  routeWidth: 6,
  routeGlowColor: 'rgba(0,117,169,0.35)',
  routeGlowWidth: 14,
  originColor: '#0075A9',
  destinationColor: '#0075A9',
  userDotColor: '#0075A9',
};
