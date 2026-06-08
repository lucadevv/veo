import React from 'react';
import Svg, { Path } from 'react-native-svg';

/**
 * Set de iconos de la pantalla de PÁNICO ("¿Necesitas ayuda?") dibujados con `react-native-svg`.
 * Portados 1:1 del set `I` del design-handoff canónico (`screens-pass.jsx`), mismo patrón que los
 * íconos del flujo de viaje (`trip/.../icons.tsx`) y de ingreso (`auth/.../icons.tsx`): viewBox
 * 24×24, trazo ~2px, color por prop. Decorativos: el contenedor presionable o el texto adjunto
 * aporta la etiqueta accesible.
 */

export interface GlyphProps {
  /** Color del trazo. */
  color: string;
  /** Tamaño del recuadro (px). */
  size?: number;
}

const STROKE = 2;

/** Escudo (seguridad / alerta de pánico). Espejo de `I.shield`. */
export function IconShield({ color, size = 20 }: GlyphProps): React.JSX.Element {
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

/** Check (alerta enviada / confirmación). Espejo de `I.check`. */
export function IconCheck({ color, size = 16 }: GlyphProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 12l5 5 9-10"
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
