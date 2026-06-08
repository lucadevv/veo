import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { type SpacingToken } from '../tokens/spacing';
import { Animated, usePressScale } from './internal/usePressScale';

export type CardVariant = 'elevated' | 'outlined' | 'filled';

export interface CardProps {
  children: ReactNode;
  /** `elevated` = sombra · `outlined` = borde · `filled` = superficie elevada. Nunca borde+sombra. */
  variant?: CardVariant;
  /** Padding interno (token de espaciado). */
  padding?: SpacingToken;
  /** Si se pasa, la tarjeta es presionable con feedback de scale. */
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: ViewStyle;
}

/**
 * Contenedor de superficie. Aplica la regla anti "ghost-card": borde O sombra, nunca ambos.
 * Radio 16. Sin tarjetas anidadas (usa el contenido directo).
 */
export function Card({
  children,
  variant = 'outlined',
  padding = '2xl',
  onPress,
  accessibilityLabel,
  style,
}: CardProps) {
  const theme = useTheme();
  const { animatedStyle, onPressIn, onPressOut } = usePressScale();

  const surfaceStyle: ViewStyle = {
    backgroundColor: variant === 'filled' ? theme.colors.surfaceElevated : theme.colors.surface,
    borderRadius: theme.radii.lg,
    borderWidth: variant === 'outlined' ? 1 : 0,
    borderColor: theme.colors.border,
    padding: theme.spacing[padding],
    ...(variant === 'elevated' ? theme.elevation.level1 : null),
  };

  if (!onPress) {
    return <View style={[surfaceStyle, style]}>{children}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={styles.pressable}
    >
      <Animated.View style={[surfaceStyle, animatedStyle, style]}>{children}</Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: { alignSelf: 'stretch' },
});
