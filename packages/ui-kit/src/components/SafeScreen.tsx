import { type ReactNode } from 'react';
import { ScrollView, StatusBar, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';

export interface SafeScreenProps {
  children: ReactNode;
  /** Contenido scrollable (por defecto false: pantallas con mapa o layout fijo). */
  scroll?: boolean;
  /** Aplica padding horizontal estándar al contenido. */
  padded?: boolean;
  /** Header fijo (no scrollea). */
  header?: ReactNode;
  /** Footer fijo (p.ej. barra de CTA), con inset inferior seguro. */
  footer?: ReactNode;
  /**
   * Reserva el inset superior (notch/status bar). Por defecto `true`. Ponelo en `false` para
   * pantallas full-bleed donde el contenido es el héroe hasta el borde (mapa): en ese caso los
   * overlays flotantes deben offsetearse ellos mismos con `insets.top`.
   */
  topInset?: boolean;
  /** Override del color de fondo (por defecto `colors.bg` del tema). */
  backgroundColor?: string;
  contentContainerStyle?: ViewStyle;
  style?: ViewStyle;
}

/**
 * Scaffold de pantalla con safe areas, barra de estado acorde al tema y slots header/footer.
 * El footer reserva el inset inferior (home indicator) para que nada quede bajo el chrome del SO.
 */
export function SafeScreen({
  children,
  scroll = false,
  padded = true,
  header,
  footer,
  backgroundColor,
  contentContainerStyle,
  style,
  topInset = true,
}: SafeScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const bg = backgroundColor ?? theme.colors.bg;
  const horizontal = padded ? theme.spacing.xl : 0;

  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[
        { paddingHorizontal: horizontal, paddingBottom: theme.spacing.xl },
        contentContainerStyle,
      ]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.flex}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, { paddingHorizontal: horizontal }, contentContainerStyle]}>
      {children}
    </View>
  );

  return (
    <View
      style={[styles.flex, { backgroundColor: bg, paddingTop: topInset ? insets.top : 0 }, style]}
    >
      <StatusBar barStyle={theme.statusBarStyle} backgroundColor={bg} translucent />
      {header ? <View style={{ paddingHorizontal: horizontal }}>{header}</View> : null}
      {body}
      {footer ? (
        <View
          style={[
            styles.footer,
            {
              paddingHorizontal: horizontal,
              paddingTop: theme.spacing.md,
              paddingBottom: insets.bottom + theme.spacing.md,
              backgroundColor: bg,
              borderTopColor: theme.colors.border,
            },
          ]}
        >
          {footer}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth },
});
