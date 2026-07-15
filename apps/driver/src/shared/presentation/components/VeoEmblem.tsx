import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from '@veo/ui-kit';
import { IconCar } from '../icons';

/**
 * Emblema de marca VEO Conductores: squircle con gradiente TEAL de confianza (`brand → brandHover`
 * a 135°) + auto blanco centrado y un glow proyectado teal. Espeja el `Emblem` (thUzp) del board
 * `C/Splash` (veo.pen). Componente canónico único de la identidad — reusado en Splash, Onboarding
 * y Login para no copiar el lockup. Escala por `size` (el ícono se dimensiona a 0.54·size, como el pen).
 */
export interface VeoEmblemProps {
  /** Lado del squircle en px. Default 100 (splash). */
  size?: number;
  /** Estilo extra para el contenedor (posición, márgenes). */
  style?: ViewStyle;
}

export function VeoEmblem({ size = 100, style }: VeoEmblemProps): React.JSX.Element {
  const theme = useTheme();
  // Proporciones tomadas del frame del pen: radio 28 y auto 54 sobre un squircle de 100.
  const radius = (size / 100) * 28;
  const iconSize = (size / 100) * 54;

  return (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius: radius,
          // Glow teal proyectado (blur 30, offset y14, spread -4, brand @35%) — como el pen.
          boxShadow: `0px 14px 30px -4px ${theme.colors.brand}59`,
        },
        style,
      ]}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="veoEmblem" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={theme.colors.brand} />
            <Stop offset="1" stopColor={theme.colors.brandHover} />
          </LinearGradient>
        </Defs>
        <Rect width={size} height={size} rx={radius} fill="url(#veoEmblem)" />
      </Svg>
      <IconCar size={iconSize} color={theme.colors.onBrand} strokeWidth={2} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
});
