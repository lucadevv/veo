import React from 'react';
import Svg, { Path, Rect, Circle } from 'react-native-svg';

export interface CashIconProps {
  /** Tamaño del recuadro (px). */
  size?: number;
  /** Color del trazo/detalle del billete. */
  color: string;
  /** Color de relleno del billete (fondo neutro del DS). */
  fill: string;
}

/**
 * Ícono de EFECTIVO (billetes) propio del design-system. Efectivo no es una marca, así que en lugar de
 * un logo prestado dibujamos un set de billetes apilados con `react-native-svg` (mismo patrón que el
 * resto de íconos de la app: viewBox 24×24, trazo ~1.6px, color por prop). Decorativo: la fila
 * presionable aporta la etiqueta accesible.
 */
export function CashIcon({ size = 28, color, fill }: CashIconProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Billete de atrás (apilado, ligeramente desplazado) */}
      <Rect
        x={3}
        y={8.5}
        width={15}
        height={9}
        rx={1.6}
        fill={fill}
        stroke={color}
        strokeWidth={1.4}
      />
      {/* Billete de adelante */}
      <Rect
        x={6}
        y={6}
        width={15}
        height={9}
        rx={1.6}
        fill={fill}
        stroke={color}
        strokeWidth={1.6}
      />
      {/* Disco central del billete de adelante */}
      <Circle cx={13.5} cy={10.5} r={2.2} stroke={color} strokeWidth={1.6} />
      {/* Marcas de las esquinas (denominación) */}
      <Path
        d="M8.4 8.2h0M18.6 12.8h0"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
      <Circle cx={8.6} cy={8.4} r={0.7} fill={color} />
      <Circle cx={18.4} cy={12.6} r={0.7} fill={color} />
    </Svg>
  );
}
