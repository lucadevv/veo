import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { TOUCH_TARGET } from '../tokens/spacing';
import { MarkerGlyph } from './internal/MarkerGlyph';
import { Animated, usePressScale } from './internal/usePressScale';
import { Text } from './Text';

export interface SearchFieldProps {
  /** Texto guía cuando no hay valor. */
  placeholder?: string;
  /** Valor seleccionado (destino elegido). Si existe, se muestra como `ink`. */
  value?: string;
  /** Slot izquierdo. Por defecto un punto lima de ubicación. */
  leftIcon?: ReactNode;
  /** Slot derecho opcional (p. ej. botón de "casa"/favoritos). */
  trailing?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: ViewStyle;
}

/**
 * Barra de búsqueda de destino ("¿A dónde vamos?"). Superficie elevada presionable que abre la
 * pantalla de búsqueda (presentacional: no edita texto). Punto lima a la izquierda. Flota sobre
 * el mapa con sombra de nivel 2.
 */
export function SearchField({
  placeholder = '¿A dónde vamos?',
  value,
  leftIcon,
  trailing,
  onPress,
  accessibilityLabel,
  style,
}: SearchFieldProps) {
  const theme = useTheme();
  const { animatedStyle, onPressIn, onPressOut } = usePressScale();
  const hasValue = Boolean(value);

  return (
    <Pressable
      accessibilityRole="search"
      accessibilityLabel={accessibilityLabel ?? value ?? placeholder}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={styles.pressable}
    >
      <Animated.View
        style={[
          styles.bar,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderRadius: theme.radii.lg,
            borderColor: theme.colors.border,
            paddingHorizontal: theme.spacing.lg,
            minHeight: TOUCH_TARGET + 12,
            gap: theme.spacing.md,
            ...theme.elevation.level2,
          },
          animatedStyle,
          style,
        ]}
      >
        <View style={styles.icon}>{leftIcon ?? <MarkerGlyph kind="origin" size={14} />}</View>
        <Text
          variant="bodyStrong"
          color={hasValue ? 'ink' : 'inkSubtle'}
          numberOfLines={1}
          style={styles.label}
        >
          {hasValue ? value : placeholder}
        </Text>
        {trailing ? <View style={styles.icon}>{trailing}</View> : null}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: { alignSelf: 'stretch' },
  bar: { flexDirection: 'row', alignItems: 'center', borderWidth: 1 },
  icon: { alignItems: 'center', justifyContent: 'center' },
  label: { flex: 1 },
});
