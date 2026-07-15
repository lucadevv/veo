import { type ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { ELEVATION_SHADOW_COLOR, useTheme } from '@veo/ui-kit';

export interface GlassSheetProps {
  children?: ReactNode;
  style?: ViewStyle;
  /**
   * Tarjeta FLOTANTE (frame `C/Dashboard-Offline`): esquinas redondeadas en los 4 lados, inset de los
   * bordes (respeta el slot de `MapShell`) y flotando por encima del tab bar. Por defecto (`false`) es la
   * hoja pegada al borde inferior con sólo las esquinas superiores redondeadas.
   */
  floating?: boolean;
  /**
   * Renderiza la hoja como `ScrollView` (frame `C/TripActive`: el panel del pasajero + estado + acciones
   * de la FSM puede desbordar y necesita scroll). Por defecto (`false`) es un `View` estático. En modo
   * scroll la hoja es HERMANA del mapa (NO vive en el slot de `MapShell`): por eso NO lleva la sombra ni
   * los márgenes negativos de slot, y el padding lo aporta el call site vía `contentContainerStyle`.
   */
  scrollable?: boolean;
  /** Sólo en modo `scrollable`: estilo del contenedor de contenido del `ScrollView` (padding, gap…). */
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Sólo en modo `scrollable`: mostrar la barra de scroll vertical. Por defecto `false`. */
  showsVerticalScrollIndicator?: boolean;
}

/**
 * Hoja del sistema VEO — el sheet inferior de los frames del conductor (Dashboard, TripIncoming, Puja,
 * TripActive…). Superficie SÓLIDA clara (`surfaceElevated`, Theme de Confianza), esquinas SUPERIORES
 * redondeadas (pegada al borde inferior, sin esquinas abajo), borde sutil del tema, y sombra hacia ARRIBA
 * (flota sobre el mapa Daylight Trust). Antes era frosted ~96%; se unificó a sólido con el sheet del
 * passenger (superficie de contenido = confianza y legibilidad; el frost queda para el pill del tab bar).
 *
 * Va dentro del slot inferior de `MapShell` (que aporta left/right/bottom:12): el margen negativo lo
 * lleva FLUSH a los bordes, como en los frames. La variante `scrollable` es la excepción: es hermana del
 * mapa, sin slot, sin sombra ni márgenes negativos.
 */
export function GlassSheet({
  children,
  style,
  floating = false,
  scrollable = false,
  contentContainerStyle,
  showsVerticalScrollIndicator = false,
}: GlassSheetProps): React.JSX.Element {
  const theme = useTheme();

  // Superficie SÓLIDA común a todas las variantes: `surfaceElevated` (blanco en el Theme de Confianza,
  // theme-aware) + borde sutil del tema. Antes era frosted (~96% blanco): se pasó a sólido para que los
  // sheets de CONTENIDO sean superficies de confianza legibles sobre el mapa — el frost queda reservado
  // para el pill chico del tab bar. MISMO criterio que el sheet del passenger (DraggableSheet, sólido).
  const surface: ViewStyle = {
    backgroundColor: theme.colors.surfaceElevated,
    borderColor: theme.colors.border,
  };

  // Variante SCROLL (frame `C/TripActive`): hoja hermana del mapa, fuera del slot de MapShell. Esquinas
  // superiores redondeadas + borde top/left/right (sin borde inferior), sin sombra ni márgenes de slot;
  // el padding lo pone el call site en `contentContainerStyle`. Pixel-equivalente al frosted inline.
  if (scrollable) {
    return (
      <ScrollView
        style={[
          {
            borderTopLeftRadius: theme.radii['2xl'],
            borderTopRightRadius: theme.radii['2xl'],
            borderWidth: 1,
            borderBottomWidth: 0,
          },
          surface,
          style,
        ]}
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      >
        {children}
      </ScrollView>
    );
  }

  return (
    <View
      style={[
        styles.sheet,
        surface,
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
    // Superficie sólida sobre el mapa Daylight Trust; color de fondo/borde se inyectan inline desde el tema.
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 24,
    borderWidth: 1,
    shadowColor: ELEVATION_SHADOW_COLOR,
    shadowOpacity: 0.14,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: -12 },
    elevation: 24,
  },
});
