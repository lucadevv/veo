import { type ReactNode } from 'react';
import { Pressable, type PressableProps, StyleSheet, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { type Theme } from '../tokens/themes';
import { TOUCH_TARGET } from '../tokens/spacing';
import { hexAlpha } from './internal/color';
import { Animated, usePressScale } from './internal/usePressScale';

export type IconButtonVariant = 'plain' | 'surface' | 'tinted' | 'danger';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  /** Glifo/ícono ya coloreado o que herede color por contexto. */
  icon: ReactNode;
  /** Obligatorio: los botones de sólo ícono necesitan etiqueta accesible. */
  accessibilityLabel: string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  disabled?: boolean;
  style?: ViewStyle;
}

const sizeMap: Record<IconButtonSize, number> = { sm: TOUCH_TARGET, md: 48, lg: 56 };

function getBackground(theme: Theme, variant: IconButtonVariant): string {
  switch (variant) {
    case 'plain':
      return 'transparent';
    case 'surface':
      return theme.colors.surfaceElevated;
    case 'tinted':
      return hexAlpha(theme.colors.accent, theme.scheme === 'dark' ? 0.2 : 0.12);
    case 'danger':
      return hexAlpha(theme.colors.danger, theme.scheme === 'dark' ? 0.22 : 0.12);
  }
}

/** Botón de sólo ícono, accesible (label obligatorio) y con área táctil ≥44pt. */
export function IconButton({
  icon,
  accessibilityLabel,
  variant = 'plain',
  size = 'md',
  disabled = false,
  style,
  onPress,
  ...rest
}: IconButtonProps) {
  const theme = useTheme();
  const { animatedStyle, onPressIn, onPressOut } = usePressScale(theme.motion.scale.pressStrong);
  const dimension = sizeMap[size];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={styles.pressable}
      {...rest}
    >
      <Animated.View
        style={[
          styles.box,
          {
            width: dimension,
            height: dimension,
            borderRadius: theme.radii.pill,
            backgroundColor: getBackground(theme, variant),
            opacity: disabled ? 0.45 : 1,
          },
          animatedStyle,
          style,
        ]}
      >
        {icon}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: { alignSelf: 'flex-start' },
  box: { alignItems: 'center', justifyContent: 'center' },
});
