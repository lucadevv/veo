import { type ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '@veo/ui-kit';

export interface GlassSheetProps {
  children?: ReactNode;
  style?: ViewStyle;
  /**
   * Tarjeta FLOTANTE (frame `C/Dashboard-Offline`): esquinas redondeadas en los 4 lados, inset de los
   * bordes (respeta el slot de `MapShell`) y flotando por encima del tab bar. Por defecto (`false`) es la
   * hoja pegada al borde inferior con sólo las esquinas superiores redondeadas.
   */
  floating?: boolean;
}

/**
 * Hoja "glass" del sistema VEO — el sheet inferior de los frames del conductor (Dashboard, TripIncoming,
 * Puja…). Superficie translúcida CLARA (~96% blanco, Theme de Confianza), esquinas SUPERIORES redondeadas
 * (pegada al borde inferior, sin esquinas abajo), borde sutil del tema, y sombra hacia ARRIBA (flota sobre
 * el mapa Daylight Trust). No hay BlurView en el stack; la opacidad ~96% ya da el frosted sobre el mapa claro.
 *
 * Va dentro del slot inferior de `MapShell` (que aporta left/right/bottom:12): el margen negativo lo
 * lleva FLUSH a los bordes, como en los frames.
 */
export function GlassSheet({ children, style, floating = false }: GlassSheetProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.sheet,
        // Frosted CLARO (~96% blanco) sobre el mapa Daylight Trust; la translucidez exige rgba.
        { backgroundColor: 'rgba(255,255,255,0.96)', borderColor: theme.colors.border },
        floating
          ? { borderRadius: theme.radii['2xl'], borderWidth: 1 }
          : {
              borderTopLeftRadius: theme.radii['2xl'],
              borderTopRightRadius: theme.radii['2xl'],
              borderBottomWidth: 0,
              // Flush a los bordes: cancela el inset de 12px del slot inferior de MapShell.
              marginHorizontal: -12,
              marginBottom: -12,
            },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    // Frosted CLARO sobre el mapa Daylight Trust; color de fondo/borde se inyectan inline desde el tema.
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 24,
    borderWidth: 1,
    shadowColor: '#1A2332',
    shadowOpacity: 0.14,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: -12 },
    elevation: 24,
  },
});
