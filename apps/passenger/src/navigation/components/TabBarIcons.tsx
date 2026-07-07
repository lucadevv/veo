import {useTheme} from '@veo/ui-kit';
import React from 'react';
import Svg, {Circle, Path, Rect} from 'react-native-svg';

/**
 * Íconos de la barra de pestañas del pasajero (Home / Viajes / Perfil) dibujados con
 * `react-native-svg`. Portados 1:1 del set `I` del design-handoff canónico (`screens-pass.jsx`:
 * `tHome`, `tTrips`, `tUser`), mismo patrón que los íconos de auth/profile/home: viewBox 24×24,
 * trazo 2px, color por prop. A diferencia de los íconos lineales del set, estos se RELLENAN cuando
 * la pestaña está activa (`focused`) — relleno lima (accent) — y quedan en outline tenue cuando no.
 * Decorativos: la etiqueta accesible la aporta el tab navigator.
 */

export interface TabIconProps {
  /** Pestaña activa: rellena el glyph (lima). Inactiva: solo contorno. */
  active?: boolean;
  /** Color del trazo/relleno; el tab navigator lo inyecta (active/inactive tint). */
  color: string;
  /** Tamaño del recuadro (px). */
  size?: number;
}

const STROKE = 2;

/** Casa (pestaña Home). Espejo de `I.tHome`: se rellena al activarse. */
export function IconTabHome({
  active = false,
  color,
  size = 24,
}: TabIconProps): React.JSX.Element {
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

/**
 * Calendario de viajes (pestaña TripHistory). Espejo de `I.tTrips`: el recuadro se rellena al
 * activarse; las líneas internas se invierten al color del fondo del tabBar para seguir leyéndose.
 */
export function IconTabTrips({
  active = false,
  color,
  size = 24,
}: TabIconProps): React.JSX.Element {
  const theme = useTheme();
  // Sobre el recuadro lleno, las líneas necesitan contraste: usan el fondo del tabBar (surface).
  const innerColor = active ? theme.colors.surface : color;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={3}
        y={4}
        width={18}
        height={16}
        rx={2}
        fill={active ? color : 'none'}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M3 9h18"
        stroke={innerColor}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M8 3v3M16 3v3"
        stroke={innerColor}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Perfil / usuario (pestaña Profile). Espejo de `I.tUser`: se rellena al activarse. */
export function IconTabUser({
  active = false,
  color,
  size = 24,
}: TabIconProps): React.JSX.Element {
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

/** Escudo (pestaña Seguridad) — espejo del shield del .pen; se rellena al activarse. */
export function IconTabSecurity({
  active = false,
  color,
  size = 24,
}: TabIconProps): React.JSX.Element {
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

/** Auto de frente (pestaña Viajes) — espejo del car-front del .pen; se rellena al activarse. */
export function IconTabRides({
  active = false,
  color,
  size = 24,
}: TabIconProps): React.JSX.Element {
  const theme = useTheme();
  const innerColor = active ? theme.colors.surface : color;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 11l1.5-4A2 2 0 0 1 8.4 6h7.2a2 2 0 0 1 1.9 1.4L19 11v6a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"
        fill={active ? color : 'none'}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M5 11h14"
        stroke={innerColor}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Circle cx={8} cy={14.5} r={0.9} fill={innerColor} />
      <Circle cx={16} cy={14.5} r={0.9} fill={innerColor} />
    </Svg>
  );
}
