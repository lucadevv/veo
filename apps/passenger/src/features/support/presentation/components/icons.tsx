import React from 'react';
import Svg, {Circle, Path, Rect} from 'react-native-svg';

/**
 * Íconos del Centro de Ayuda (design/veo.pen P/Help, set lucide del pen: search, car-front,
 * wallet, shield, user). Mismo contrato del resto de sets de la app: viewBox 24×24, trazo 2px,
 * color por prop. Decorativos: la fila/campo contenedor aporta la etiqueta accesible.
 */

export interface GlyphProps {
  color: string;
  size?: number;
}

const STROKE = 2;

/** Lupa del buscador de ayuda (pen `search`). */
export function IconSearch({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={11} cy={11} r={7} stroke={color} strokeWidth={STROKE} />
      <Path
        d="m20 20-3.8-3.8"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Frente de auto (pen `car-front`) — tema "Problemas con un viaje". */
export function IconCarFront({
  color,
  size = 20,
}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="m21 8-2 2-1.5-3.7A2 2 0 0 0 15.646 5H8.4a2 2 0 0 0-1.903 1.257L5 10 3 8"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Rect
        x={3}
        y={10}
        width={18}
        height={8}
        rx={2}
        stroke={color}
        strokeWidth={STROKE}
      />
      <Path
        d="M7 14h.01M17 14h.01M5 18v2M19 18v2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Billetera (pen `wallet`) — tema "Pagos y reembolsos". */
export function IconWallet({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M19 7V5.5A1.5 1.5 0 0 0 17.5 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={16.5} cy={13.5} r={1.2} fill={color} />
    </Svg>
  );
}

/** Escudo (pen `shield`) — tema "Seguridad y pánico". */
export function IconShield({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Persona (pen `user`) — tema "Mi cuenta". */
export function IconUser({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={8} r={4} stroke={color} strokeWidth={STROKE} />
      <Path
        d="M5 21a7 7 0 0 1 14 0"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}
