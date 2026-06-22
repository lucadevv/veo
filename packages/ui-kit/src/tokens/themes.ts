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
  /** Color de marca (passenger: VEO Cyan · driver: cian). */
  brand: string;
  brandHover: string;
  onBrand: string;
  /** Color de acción/acento (passenger: VEO Cyan · driver: cian). */
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

/* ── Passenger · marca oficial VEO · noche, acento VEO Cyan ───────────────────
 * Dirección visual premium para movilidad alineada al VEO Brand Book. Lienzo NEGRO PURO
 * de marca (#000000), tipografía de alto contraste y un único acento cian de uso
 * DISCIPLINADO (acción primaria, ruta, estados activos, punto de ubicación). El cyan nunca
 * rellena áreas grandes; cuando lo hace (botón primario) el texto encima es NEGRO. Escala de
 * superficies tomada del Brand Book (#0e0e11 sheet · #1c1c22 capa elevada · #17171b/#2a2a30
 * bordes). Contraste AA verificado: ink #F4F6F8 sobre bg #000000 (~19:1), onBrand #000000
 * sobre cyan #00E5FF (~13.6:1), inkMuted #CFD3DA sobre bg (~14:1), onDanger #000000 sobre
 * coral #FF3B5C (~6:1). */
const passengerColors: ThemeColors = {
  bg: '#000000',
  surface: '#0E0E11',
  surfaceElevated: '#1C1C22',
  ink: '#F4F6F8',
  inkMuted: '#CFD3DA',
  inkSubtle: '#8A909C',
  border: '#17171B',
  borderStrong: '#2A2A30',
  brand: '#00E5FF',
  brandHover: '#00B8CC',
  onBrand: '#000000',
  accent: '#00E5FF',
  accentHover: '#33EAFF',
  onAccent: '#000000',
  safe: '#34D399',
  onSafe: '#04160D',
  success: '#34D399',
  onSuccess: '#04160D',
  warn: '#F2AF48',
  onWarn: '#201301',
  danger: '#FF3B5C',
  dangerHover: '#E62E4D',
  onDanger: '#000000',
  focus: '#00E5FF',
  overlay: 'rgba(0,0,0,0.66)',
  skeleton: '#1C1C22',
  skeletonHighlight: '#2A2A30',
};

/* ── Driver · AZUL ELÉCTRICO · noche, acento azul de confianza ─────────────────
 * Dirección visual propia del CONDUCTOR: AZUL ELÉCTRICO (#2D7FF9) — confianza + premium para
 * movilidad segura. El pasajero queda en cyan; el conductor se diferencia por su paleta azul.
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
  safe: '#34D399',
  onSafe: '#04160D',
  success: '#34D399',
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
 * cian de marca VEO sea consistente. La pantalla pasa estos valores a la capa de línea.
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
  routeColor: '#00E5FF',
  routeWidth: 6,
  routeGlowColor: 'rgba(0,229,255,0.35)',
  routeGlowWidth: 14,
  originColor: '#00E5FF',
  destinationColor: '#00E5FF',
  userDotColor: '#00E5FF',
};

/**
 * Tokens de ruta para el CONDUCTOR (variante AZUL ELÉCTRICO). Mismo lenguaje que el pasajero
 * (halo translúcido + línea nítida) pero con el acento azul #2D7FF9 del `driverTheme`, para que
 * la ruta dibujada en MapLibre sea consistente con el resto de la app del conductor.
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
