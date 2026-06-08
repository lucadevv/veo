import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { type Theme, type ThemeColors } from '../tokens/themes';
import { TOUCH_TARGET } from '../tokens/spacing';
import { Animated, usePressScale } from './internal/usePressScale';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger' | 'safe';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Ocupa todo el ancho disponible. */
  fullWidth?: boolean;
  /** Estado de carga: deshabilita y muestra spinner (mantiene el ancho). */
  loading?: boolean;
  disabled?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  style?: ViewStyle;
}

interface VariantVisual {
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  text: keyof ThemeColors;
}

function getVariantVisual(theme: Theme, variant: ButtonVariant): VariantVisual {
  const c = theme.colors;
  switch (variant) {
    case 'primary':
      return { backgroundColor: c.brand, borderColor: c.brand, borderWidth: 0, text: 'onBrand' };
    case 'accent':
      return { backgroundColor: c.accent, borderColor: c.accent, borderWidth: 0, text: 'onAccent' };
    case 'safe':
      return { backgroundColor: c.safe, borderColor: c.safe, borderWidth: 0, text: 'onSafe' };
    case 'danger':
      return { backgroundColor: c.danger, borderColor: c.danger, borderWidth: 0, text: 'onDanger' };
    case 'secondary':
      return { backgroundColor: c.surface, borderColor: c.borderStrong, borderWidth: 1, text: 'ink' };
    case 'ghost':
      return { backgroundColor: 'transparent', borderColor: 'transparent', borderWidth: 0, text: 'accent' };
  }
}

const sizeMap: Record<ButtonSize, { minHeight: number; paddingHorizontal: number; variant: 'subhead' | 'bodyStrong' }> = {
  sm: { minHeight: TOUCH_TARGET, paddingHorizontal: 16, variant: 'subhead' },
  md: { minHeight: 52, paddingHorizontal: 20, variant: 'bodyStrong' },
  lg: { minHeight: 58, paddingHorizontal: 24, variant: 'bodyStrong' },
};

/**
 * Botón VEO. Variantes de acción + tamaños. Feedback de press (scale 0.97 ease-out, interrumpible),
 * estado loading accesible, target ≥44pt. Toda la apariencia sale del tema.
 */
export function Button({
  label,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled = false,
  leftIcon,
  rightIcon,
  style,
  accessibilityLabel,
  onPress,
  ...rest
}: ButtonProps) {
  const theme = useTheme();
  const { animatedStyle, onPressIn, onPressOut } = usePressScale();
  const visual = getVariantVisual(theme, variant);
  const sizing = sizeMap[size];
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={[fullWidth ? styles.full : styles.auto, style]}
      {...rest}
    >
      <Animated.View
        style={[
          styles.base,
          {
            backgroundColor: visual.backgroundColor,
            borderColor: visual.borderColor,
            borderWidth: visual.borderWidth,
            borderRadius: theme.radii.pill,
            minHeight: sizing.minHeight,
            paddingHorizontal: sizing.paddingHorizontal,
            opacity: isDisabled ? 0.45 : 1,
          },
          animatedStyle,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={theme.colors[visual.text]} />
        ) : (
          <View style={styles.row}>
            {leftIcon ? <View style={styles.icon}>{leftIcon}</View> : null}
            <Text variant={sizing.variant} color={visual.text} numberOfLines={1}>
              {label}
            </Text>
            {rightIcon ? <View style={styles.icon}>{rightIcon}</View> : null}
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  full: { alignSelf: 'stretch' },
  auto: { alignSelf: 'flex-start' },
  base: { alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  icon: { alignItems: 'center', justifyContent: 'center' },
});
