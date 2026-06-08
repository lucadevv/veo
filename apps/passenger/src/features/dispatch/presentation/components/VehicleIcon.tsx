import { passengerMapRoute, themes } from '@veo/ui-kit';
import React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import type { NearbyVehicleType } from '../../domain/dispatchRepository';

/**
 * Autito de AMBIENTE visto DESDE ARRIBA (top-down) para el mapa del pasajero "Midnight Motion".
 * Dibujado con `react-native-svg` (mismo patrón que `auth/.../icons.tsx`: Svg/Path, color por prop,
 * tamaño por prop). Dos tonos del DS:
 *   - cuerpo: `passengerMapRoute.routeColor` (lima de la ruta) → consistente con el lenguaje del mapa.
 *   - "vidrios" (parabrisas + luneta): `themes.passenger.colors.bg` (negro del lienzo) insinuados como
 *     un corte oscuro sobre el cuerpo. NUNCA hex inline: ambos salen de tokens.
 *
 * Decisión de forma: cuerpo redondeado (capó/baúl curvos), cintura levemente más angosta (guardabarros
 * insinuados) y una franja de vidrio transversal. Top-down legible a ~28-32px sin detalle ruidoso.
 */

export interface VehicleIconProps {
  /** Tipo de vehículo: `CAR` (auto) o `MOTO` (moto-taxi). Default `CAR`. */
  vehicleType?: NearbyVehicleType;
  /** Lado del recuadro (px). Default 30 (ambiente chico). */
  size?: number;
  /** Color del cuerpo. Default token lima de la ruta del pasajero. */
  bodyColor?: string;
  /** Color de los vidrios. Default fondo del lienzo (corte oscuro). */
  glassColor?: string;
}

/** Auto top-down: cuerpo redondeado + franja de parabrisas/luneta insinuada. */
function CarGlyph({ size, bodyColor, glassColor }: Required<Omit<VehicleIconProps, 'vehicleType'>>) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {/* Cuerpo: cápsula vertical con capó y baúl curvos, cintura apenas marcada. */}
      <Path
        d="M16 3
           C12.4 3 10.4 5.2 10 9
           C9.4 12.4 9.2 16 9.2 19.5
           C9.2 23.4 9.6 26 11 28
           C12 29.4 14 30 16 30
           C18 30 20 29.4 21 28
           C22.4 26 22.8 23.4 22.8 19.5
           C22.8 16 22.6 12.4 22 9
           C21.6 5.2 19.6 3 16 3 Z"
        fill={bodyColor}
      />
      {/* Parabrisas (corte oscuro hacia el capó). */}
      <Path
        d="M11.6 9.4 C13 8.2 19 8.2 20.4 9.4 C19.8 11.2 12.2 11.2 11.6 9.4 Z"
        fill={glassColor}
      />
      {/* Luneta trasera (corte oscuro hacia el baúl). */}
      <Path
        d="M11.8 24.2 C12.6 25.4 19.4 25.4 20.2 24.2 C19.4 22.8 12.6 22.8 11.8 24.2 Z"
        fill={glassColor}
      />
    </Svg>
  );
}

/**
 * Moto-taxi top-down: cuerpo más angosto + un travesaño (manubrio insinuado). Variante BARATA de la
 * misma familia (mismo viewBox, mismos tokens), legible al mismo tamaño que el auto.
 */
function MotoGlyph({ size, bodyColor, glassColor }: Required<Omit<VehicleIconProps, 'vehicleType'>>) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {/* Cuerpo angosto (carrocería de mototaxi). */}
      <Path
        d="M16 3.5
           C13.6 3.5 12.4 5.4 12 8.6
           C11.6 12 11.6 16 11.6 20
           C11.6 24 12 26.6 13 28.2
           C13.8 29.4 14.8 30 16 30
           C17.2 30 18.2 29.4 19 28.2
           C20 26.6 20.4 24 20.4 20
           C20.4 16 20.4 12 20 8.6
           C19.6 5.4 18.4 3.5 16 3.5 Z"
        fill={bodyColor}
      />
      {/* Manubrio insinuado (travesaño oscuro al frente). */}
      <Rect x={10.5} y={9} width={11} height={2.2} rx={1.1} fill={glassColor} />
    </Svg>
  );
}

/**
 * Ícono de vehículo de ambiente. Elige la silueta por `vehicleType`. Decorativo: el contenedor (el
 * MarkerView del mapa) aporta el etiquetado accesible si corresponde — acá no, porque es ambiente.
 */
export function VehicleIcon({
  vehicleType = 'CAR',
  size = 30,
  bodyColor = passengerMapRoute.routeColor,
  glassColor = themes.passenger.colors.bg,
}: VehicleIconProps): React.JSX.Element {
  const props = { size, bodyColor, glassColor };
  return vehicleType === 'MOTO' ? <MotoGlyph {...props} /> : <CarGlyph {...props} />;
}
