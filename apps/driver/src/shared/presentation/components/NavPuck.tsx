import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { driverMapRoute, useTheme } from '@veo/ui-kit';
import { vehicleClassGlyph } from '../vehicle-class';

/** Radio del badge circular del vehículo (unidades del viewBox 38). */
const BADGE_RADIUS = 12;
/** Centro Y del badge (viewBox 38): apenas bajo el centro para dejar aire a la flecha de rumbo. */
const BADGE_CENTER_Y = 21;
/** Tamaño del glyph del vehículo dentro del badge, en px para `size` = 38 (escala linealmente). */
const GLYPH_SIZE_RATIO = 15 / 38;

export interface NavPuckProps {
  /** Tamaño del puck en px. */
  size?: number;
  /**
   * Clase del vehículo activo (wire string `VehicleClass`): el puck lleva el glyph moto/auto dentro
   * de un badge circular con flecha de rumbo. Sin dato (`null`), cae a la flecha genérica.
   */
  vehicleType?: string | null;
}

/**
 * Puck de NAVEGACIÓN (estilo Waze): marca la dirección de viaje del conductor.
 *
 * No rota por sí mismo: la cámara va en modo heading-up (su `bearing` = rumbo del conductor), así que
 * la dirección de viaje queda SIEMPRE "arriba" en pantalla. Dos variantes:
 *  - CON `vehicleType`: badge circular cian con el glyph del vehículo (moto/auto, mismo registro
 *    exhaustivo `vehicleClassGlyph` del dashboard) + flecha de rumbo asomando arriba.
 *  - SIN dato: la flecha tipo cometa histórica (degradación honesta, cero plumbing extra).
 * Halo translúcido (mismo glow que la ruta) en ambas; tokens `driverMapRoute`, sin hex sueltos.
 */
export const NavPuck = ({ size = 38, vehicleType = null }: NavPuckProps): React.JSX.Element => {
  const theme = useTheme();
  if (!vehicleType) {
    return (
      <Svg width={size} height={size} viewBox="0 0 38 38">
        {/* Halo de presencia (mismo glow que la ruta). */}
        <Circle cx={19} cy={19} r={18} fill={driverMapRoute.routeGlowColor} />
        {/* Flecha tipo cometa apuntando arriba: tip arriba, alas abajo, muesca central. El contorno
            oscuro que la despega del lienzo usa `brandDeep` (teal profundo de la marca). */}
        <Path
          d="M19 6 L30 30 L19 24 L8 30 Z"
          fill={driverMapRoute.routeColor}
          stroke={theme.colors.brandDeep}
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      </Svg>
    );
  }
  const Glyph = vehicleClassGlyph(vehicleType);
  const glyphSize = Math.round(size * GLYPH_SIZE_RATIO);
  // Centro del badge en px reales (el viewBox escala con `size`), para superponer el glyph RN.
  const badgeCenterYPx = (size * BADGE_CENTER_Y) / 38;
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 38 38">
        {/* Halo de presencia (mismo glow que la ruta). */}
        <Circle cx={19} cy={19} r={18} fill={driverMapRoute.routeGlowColor} />
        {/* Flecha de rumbo: asoma sobre el badge apuntando arriba (heading-up ⇒ dirección de viaje). */}
        <Path d="M19 1.5 L25.5 11 L12.5 11 Z" fill={driverMapRoute.routeColor} strokeLinejoin="round" />
        {/* Badge del vehículo: disco cian con aro claro para despegarlo del lienzo light. */}
        <Circle
          cx={19}
          cy={BADGE_CENTER_Y}
          r={BADGE_RADIUS}
          fill={driverMapRoute.routeColor}
          stroke={theme.colors.surfaceElevated}
          strokeWidth={2}
        />
      </Svg>
      {/* Glyph del vehículo superpuesto y centrado en el badge (es un componente RN, no un path). */}
      <View
        pointerEvents="none"
        style={[
          styles.glyph,
          {
            left: size / 2 - glyphSize / 2,
            top: badgeCenterYPx - glyphSize / 2,
          },
        ]}
      >
        <Glyph size={glyphSize} color={theme.colors.onAccent} strokeWidth={2.2} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  glyph: { position: 'absolute' },
});
