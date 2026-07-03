import React from 'react';
import Svg, {Circle, Path, Rect} from 'react-native-svg';

/**
 * Íconos de "Invita y gana" (design/veo.pen AqN7Q, set lucide del pen: gift, copy, share-2).
 * Contrato estándar de los sets de la app: viewBox 24×24, trazo 2px, color por prop.
 * Decorativos: el contenedor (hero/botón/fila) aporta la etiqueta accesible.
 */

export interface GlyphProps {
  color: string;
  size?: number;
}

const STROKE = 2;

/** Regalo (pen `gift`) — héroe y fila "Canjear un código". */
export function IconGift({color, size = 20}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={3}
        y={8}
        width={18}
        height={13}
        rx={2}
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M3 12h18M12 8v13"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path
        d="M12 8S10 3 7.5 4.5 9 8 12 8s2.5-2 4.5-3.5S12 8 12 8Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Copiar (pen `copy`) — botón pill dentro de la card del código. */
export function IconCopy({color, size = 16}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={9}
        y={9}
        width={12}
        height={12}
        rx={2}
        stroke={color}
        strokeWidth={STROKE}
      />
      <Path
        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Compartir (pen `share-2`) — CTA primario "Compartir mi código". */
export function IconShare2({color, size = 18}: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={18} cy={5} r={3} stroke={color} strokeWidth={STROKE} />
      <Circle cx={6} cy={12} r={3} stroke={color} strokeWidth={STROKE} />
      <Circle cx={18} cy={19} r={3} stroke={color} strokeWidth={STROKE} />
      <Path
        d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}
