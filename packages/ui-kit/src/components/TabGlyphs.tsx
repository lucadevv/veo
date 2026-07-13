import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from '../theme/ThemeProvider';

/**
 * Glifos de TAB BAR compartidos por passenger + driver — MISMA identidad, mismo carácter en ambas apps
 * (fuente única, cero copy-paste). Todos siguen el mismo lenguaje: viewBox 24×24, trazo 2px, y el patrón
 * de estado del pen `C/TabBar`: **outline tenue cuando la pestaña está INACTIVA, glifo RELLENO (en el
 * color de marca) cuando está ACTIVA**. Los detalles internos (ventana del auto, ruedas) se punzonan con
 * el color de la superficie del pill para leerse como recorte sobre el relleno.
 *
 * Los conceptos que las dos apps comparten (Inicio=casa · Viajes=auto · Cuenta=persona) usan EXACTAMENTE
 * el mismo glifo; los propios del conductor (Compartir=dos personas · Ganancias=barras) siguen el mismo
 * patrón de relleno. Decorativos: la etiqueta accesible la aporta el tab navigator.
 */
export interface TabGlyphProps {
  /** Pestaña activa: rellena el glifo (color de marca). Inactiva: solo contorno. */
  active?: boolean;
  /** Color del trazo/relleno; lo inyecta el tab bar (tint activo/inactivo). */
  color: string;
  /** Tamaño del recuadro (px). */
  size?: number;
}

const STROKE = 2;

/** Casa (Inicio). El vano de la puerta queda en negativo dentro del path → se lee relleno o no. */
export function TabGlyphHome({ active = false, color, size = 24 }: TabGlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"
        fill={active ? color : 'none'}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Auto de frente (Viajes). Al activarse el cuerpo se rellena; línea y ruedas van en el color del pill. */
export function TabGlyphTrips({ active = false, color, size = 24 }: TabGlyphProps): React.JSX.Element {
  const theme = useTheme();
  const inner = active ? theme.colors.surface : color;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 11l1.5-4A2 2 0 0 1 8.4 6h7.2a2 2 0 0 1 1.9 1.4L19 11v6a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"
        fill={active ? color : 'none'}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path d="M5 11h14" stroke={inner} strokeWidth={STROKE} strokeLinecap="round" />
      <Circle cx={8} cy={14.5} r={0.9} fill={inner} />
      <Circle cx={16} cy={14.5} r={0.9} fill={inner} />
    </Svg>
  );
}

/** Persona (Cuenta). Cabeza y hombros se rellenan al activarse. */
export function TabGlyphAccount({ active = false, color, size = 24 }: TabGlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle
        cx={12}
        cy={8}
        r={4}
        fill={active ? color : 'none'}
        stroke={color}
        strokeWidth={STROKE}
      />
      <Path
        d="M4 21a8 8 0 0 1 16 0z"
        fill={active ? color : 'none'}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Escudo (Seguridad). Se rellena al activarse. */
export function TabGlyphSecurity({ active = false, color, size = 24 }: TabGlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"
        fill={active ? color : 'none'}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * Dos personas (Compartir / Carpooling del conductor). La figura de adelante se RELLENA al activarse; la
 * de atrás queda en contorno para dar profundidad (mismo lenguaje que los demás, sin volverse una mancha).
 */
export function TabGlyphCarpool({ active = false, color, size = 24 }: TabGlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Figura de atrás: siempre contorno (profundidad). */}
      <Circle cx={16} cy={7.5} r={3} stroke={color} strokeWidth={STROKE} />
      <Path
        d="M15 14.4a4.5 4.5 0 0 1 5.5 4.4v0.7"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Figura de adelante: se rellena al activarse. */}
      <Circle
        cx={9}
        cy={8}
        r={3.6}
        fill={active ? color : 'none'}
        stroke={color}
        strokeWidth={STROKE}
      />
      <Path
        d="M2.5 19.5v-1A4.5 4.5 0 0 1 7 14h4a4.5 4.5 0 0 1 4.5 4.5v1z"
        fill={active ? color : 'none'}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Barras ascendentes (Ganancias). Rects redondeados que se rellenan al activarse. */
export function TabGlyphEarnings({ active = false, color, size = 24 }: TabGlyphProps): React.JSX.Element {
  const fill = active ? color : 'none';
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={4} y={13} width={3.6} height={7} rx={1.2} fill={fill} stroke={color} strokeWidth={STROKE} />
      <Rect x={10.2} y={8} width={3.6} height={12} rx={1.2} fill={fill} stroke={color} strokeWidth={STROKE} />
      <Rect x={16.4} y={10.5} width={3.6} height={9.5} rx={1.2} fill={fill} stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}
