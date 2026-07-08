import { type ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '@veo/ui-kit';

export interface GlassSheetProps {
  children?: ReactNode;
  style?: ViewStyle;
}

/**
 * Hoja "glass" del sistema VEO — el sheet inferior de los frames del conductor (Dashboard, TripIncoming,
 * Puja…). Superficie translúcida oscura, esquinas SUPERIORES redondeadas (pegada al borde inferior, sin
 * esquinas abajo), hairline highlight blanco arriba + borde sutil, y sombra hacia ARRIBA (flota sobre el
 * mapa). No hay BlurView en el stack; la opacidad ~96% ya da el frosted sobre el mapa, fiel al gradiente
 * #272C38E0→#14161CF2 del diseño.
 *
 * Va dentro del slot inferior de `MapShell` (que aporta left/right/bottom:12): el margen negativo lo
 * lleva FLUSH a los bordes, como en los frames.
 */
export function GlassSheet({ children, style }: GlassSheetProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.sheet,
        { borderTopLeftRadius: theme.radii['2xl'], borderTopRightRadius: theme.radii['2xl'] },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: 'rgba(30,33,42,0.96)', // surfaceElevated #1E212A ~96% → frosted sobre el mapa
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(76,84,104,0.55)',
    borderTopColor: 'rgba(255,255,255,0.16)', // "labio" de vidrio arriba
    shadowColor: '#000000',
    shadowOpacity: 0.6,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: -12 },
    elevation: 24,
    // Flush a los bordes: cancela el inset de 12px del slot inferior de MapShell.
    marginHorizontal: -12,
    marginBottom: -12,
  },
});
