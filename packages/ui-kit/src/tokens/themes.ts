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
  warn: string;
  onWarn: string;
  danger: string;
  dangerHover: string;
  onDanger: string;
  /** Anillo de foco accesible. */
  focus: string;
  /** Scrim de modales/sheets (40-60% para aislar el foreground). */
  overlay: string;
  /** Base y brillo del shimmer/skeleton. */
  skeleton: string;
  skeletonHighlight: string;
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

/* ── Passenger · marca oficial VEO · noche, acento AZUL #2D7FF9 ────────────────
 * "Una sola marca" (VEO_BRIEF_DISENO): el pasajero comparte EXACTAMENTE la paleta de marca
 * del conductor — azul #2D7FF9 sobre lienzo near-black AZULADO (#0A0B0F). El passenger puede
 * diferenciarse en USO/componentes, NUNCA en el color de marca. Un único acento azul de uso
 * DISCIPLINADO (acción primaria, ruta, estados activos, punto de ubicación); cuando rellena
 * (botón primario) el texto encima es BLANCO. Neutrales tintados hacia azul/frío, nunca
 * #000/#fff planos.
 *
 * Contraste AA verificado (calculado, ratios reales WCAG 2.1 — idénticos al driverTheme):
 *   · ink #F5F7FA sobre bg #0A0B0F → 18.33:1 (AAA holgado)
 *   · inkMuted #C4CBD6 sobre bg #0A0B0F → 12.05:1 (pasa AA texto normal ≥4.5)
 *   · inkSubtle #8A929E sobre bg #0A0B0F → 6.26:1 (terciario/placeholder, igual pasa AA)
 *   · onAccent/onBrand #FFFFFF sobre brand/accent #2D7FF9 → 3.81:1 (pasa AA-large 3:1; el texto
 *     de botón es semibold/grande, así que NO hace falta oscurecer el azul)
 *   · onDanger #1A0306 sobre danger #FF4D6A → 6.15:1
 *   · onSafe #04160D sobre safe/success #34D399 → 9.70:1
 *   · onWarn #201301 sobre warn #F2AF48 → 9.52:1 */
const passengerColors: ThemeColors = {
  bg: '#0A0B0F',
  surface: '#14161C',
  surfaceElevated: '#1E212A',
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
  // POSITIVO: jade profundo #17C08A, NO el mint común #34D399 (Tailwind emerald, se ve en toda app "hecha
  // por AI"). Jade = más sofisticado, combina con el azul acento, y aparece SOLO en momentos positivos
  // (propina, verificación sutil), nunca como checklist. onSafe #04160D oscuro sobre jade ≈ 8:1 (AA).
  safe: '#17C08A',
  onSafe: '#04160D',
  success: '#17C08A',
  onSuccess: '#04160D',
  warn: '#F2AF48',
  onWarn: '#201301',
  danger: '#FF4D6A',
  dangerHover: '#E63A56',
  onDanger: '#1A0306',
  focus: '#2D7FF9',
  overlay: 'rgba(5,7,12,0.7)',
  skeleton: '#14161C',
  skeletonHighlight: '#1E212A',
};

/* ── Driver · AZUL ELÉCTRICO · noche, acento azul de confianza ─────────────────
 * Marca VEO global: AZUL ELÉCTRICO (#2D7FF9) — confianza + premium para movilidad segura.
 * Pasajero y conductor comparten ESTA paleta (una sola marca); el driverTheme es la fuente.
 * Lienzo near-black AZULADO (#0A0B0F, NO negro plano — tinta levemente el neutral hacia el azul,
 * ideal OLED para turnos largos) y un único acento azul de uso DISCIPLINADO (acción primaria,
 * estado activo, ruta). El azul nunca rellena áreas grandes; cuando lo hace (botón primario) el
 * texto encima es BLANCO. Neutrales tintados hacia azul/frío, nunca #000/#fff planos.
 *
 * Contraste AA verificado (calculado, ratios reales WCAG 2.1):
 *   · ink #F5F7FA sobre bg #0A0B0F → 18.33:1 (AAA holgado)
 *   · inkMuted #C4CBD6 sobre bg #0A0B0F → 12.05:1 (pasa AA texto normal ≥4.5)
 *   · inkSubtle #8A929E sobre bg #0A0B0F → 6.26:1 (terciario/placeholder, igual pasa AA)
 *   · onAccent/onBrand #FFFFFF sobre brand/accent #2D7FF9 → 3.81:1 (pasa AA-large 3:1; el texto
 *     de botón es semibold/grande, así que NO hace falta oscurecer el azul)
 *   · onDanger #1A0306 sobre danger #FF4D6A → 6.15:1 (texto oscuro sobre rojo brillante)
 *   · onSafe #04160D sobre safe/success #34D399 → 9.70:1
 *   · onWarn #201301 sobre warn #F2AF48 → 9.52:1 */
const driverColors: ThemeColors = {
  bg: '#0A0B0F',
  surface: '#14161C',
  surfaceElevated: '#1E212A',
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
  // POSITIVO: jade profundo #17C08A, NO el mint común #34D399 (Tailwind emerald, se ve en toda app "hecha
  // por AI"). Jade = más sofisticado, combina con el azul acento, y aparece SOLO en momentos positivos
  // (propina, verificación sutil), nunca como checklist. onSafe #04160D oscuro sobre jade ≈ 8:1 (AA).
  safe: '#17C08A',
  onSafe: '#04160D',
  success: '#17C08A',
  onSuccess: '#04160D',
  warn: '#F2AF48',
  onWarn: '#201301',
  danger: '#FF4D6A',
  dangerHover: '#E63A56',
  onDanger: '#1A0306',
  focus: '#2D7FF9',
  overlay: 'rgba(5,7,12,0.7)',
  skeleton: '#14161C',
  skeletonHighlight: '#1E212A',
};

// Marca VEO: la elevación se expresa con superficie + sombras tenues (modo noche),
// igual que el tema driver. Las sombras negras dan profundidad sin lavar el lienzo negro.
const passengerElevation: Elevation = {
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
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 14,
    elevation: 8,
  },
  level3: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.6,
    shadowRadius: 30,
    elevation: 18,
  },
};

// En modo noche la elevación se expresa con la superficie; las sombras son tenues.
const driverElevation: Elevation = {
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
  scheme: 'dark',
  statusBarStyle: 'light-content',
  colors: passengerColors,
  spacing,
  radii,
  typography,
  elevation: passengerElevation,
  motion,
};

export const driverTheme: Theme = {
  name: 'driver',
  scheme: 'dark',
  statusBarStyle: 'light-content',
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
  routeColor: '#2D7FF9',
  routeWidth: 6,
  routeGlowColor: 'rgba(45,127,249,0.35)',
  routeGlowWidth: 14,
  originColor: '#2D7FF9',
  destinationColor: '#2D7FF9',
  userDotColor: '#2D7FF9',
};

/**
 * Tokens de ruta para el CONDUCTOR. Misma marca azul #2D7FF9 que el pasajero (halo translúcido
 * + línea nítida); se mantiene como export propio para que la app del conductor lo importe por
 * nombre, pero los valores son idénticos a `passengerMapRoute` (una sola marca).
 */
export const driverMapRoute: MapRouteTokens = {
  routeColor: '#2D7FF9',
  routeWidth: 6,
  routeGlowColor: 'rgba(45,127,249,0.35)',
  routeGlowWidth: 14,
  originColor: '#2D7FF9',
  destinationColor: '#2D7FF9',
  userDotColor: '#2D7FF9',
};
