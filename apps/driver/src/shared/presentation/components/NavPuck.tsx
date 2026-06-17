import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { driverMapRoute } from '@veo/ui-kit';

export interface NavPuckProps {
  /** Tamaño del puck en px. */
  size?: number;
}

/**
 * Puck de NAVEGACIÓN (estilo Waze): flecha cian que marca la dirección de viaje del conductor.
 *
 * No rota por sí mismo: la cámara va en modo heading-up (su `bearing` = rumbo del conductor), así que
 * la dirección de viaje queda SIEMPRE "arriba" en pantalla y la flecha apunta arriba. Halo translúcido
 * + borde oscuro para contraste sobre el lienzo nocturno (tokens `driverMapRoute`, sin hex sueltos).
 */
export const NavPuck = ({ size = 38 }: NavPuckProps): React.JSX.Element => (
  <Svg width={size} height={size} viewBox="0 0 38 38">
    {/* Halo de presencia (mismo glow que la ruta). */}
    <Circle cx={19} cy={19} r={18} fill={driverMapRoute.routeGlowColor} />
    {/* Flecha tipo cometa apuntando arriba: tip arriba, alas abajo, muesca central. */}
    <Path
      d="M19 6 L30 30 L19 24 L8 30 Z"
      fill={driverMapRoute.routeColor}
      stroke="#04131A"
      strokeWidth={1.6}
      strokeLinejoin="round"
    />
  </Svg>
);
