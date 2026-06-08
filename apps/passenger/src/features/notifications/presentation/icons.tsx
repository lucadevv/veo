import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import type { NotificationKind } from '../domain/entities';

/**
 * Íconos del CENTRO DE AVISOS, portados 1:1 del set `I` del design-handoff (`screens-pass.jsx`):
 * viewBox 24×24, trazo ~2px, color por prop. Cada categoría de aviso mapea a un glyph del set
 * (reloj/escudo/regalo/tarjeta) y un genérico de campana. Decorativos: el contenedor aporta la
 * etiqueta accesible.
 */

export interface GlyphProps {
  color: string;
  size?: number;
}

const STROKE = 2;

/** Reloj (avisos de viaje / programados). Espejo de `I.clock`. */
export function IconClock({ color, size = 18 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={STROKE} />
      <Path d="M12 7v5l3 2" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

/** Escudo (avisos de seguridad). Espejo de `I.shield`. */
export function IconShield({ color, size = 18 }: GlyphProps): React.JSX.Element {
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

/** Regalo (promos / referidos). Espejo de `I.gift`. */
export function IconGift({ color, size = 18 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={3} y={8} width={18} height={13} rx={2} stroke={color} strokeWidth={STROKE} strokeLinejoin="round" />
      <Path d="M3 12h18M12 8v13" stroke={color} strokeWidth={STROKE} strokeLinejoin="round" />
      <Path
        d="M12 8S10 3 7.5 4.5 9 8 12 8s2.5-2 4.5-3.5S12 8 12 8Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Tarjeta (recibos / pagos). Espejo de `I.card`. */
export function IconCard({ color, size = 18 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={2.5} y={5} width={19} height={14} rx={2.5} stroke={color} strokeWidth={STROKE} />
      <Path d="M2.5 9.5h19" stroke={color} strokeWidth={STROKE} />
    </Svg>
  );
}

/** Campana (aviso genérico). Espejo del glyph de campana de la Home del diseño. */
export function IconBell({ color, size = 18 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path d="M13.5 21a2 2 0 0 1-3 0" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

/** Devuelve el glyph correspondiente a la categoría de un aviso. */
export function iconForKind(kind: NotificationKind): (props: GlyphProps) => React.JSX.Element {
  switch (kind) {
    case 'TRIP':
      return IconClock;
    case 'SAFETY':
      return IconShield;
    case 'PROMO':
      return IconGift;
    case 'RECEIPT':
      return IconCard;
    case 'GENERAL':
      return IconBell;
  }
}
