import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { TOUCH_TARGET } from '../tokens/spacing';
import { Chevron } from './internal/Chevron';
import { Text } from './Text';

export interface ListItemProps {
  title: string;
  subtitle?: string;
  /** Slot izquierdo (ícono, Avatar, etc.). */
  leading?: ReactNode;
  /** Slot derecho. Si se omite y `chevron` es true, dibuja un chevron. */
  trailing?: ReactNode;
  /** Muestra chevron de navegación a la derecha. */
  chevron?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: ViewStyle;
}

/**
 * Fila de lista (settings, lugares guardados, contactos). Feedback de press por cambio de fondo
 * (no scale: las filas se ven muchas veces; emil recomienda reducir animación en interacción
 * frecuente). Target ≥44pt.
 */
export function ListItem({
  title,
  subtitle,
  leading,
  trailing,
  chevron = false,
  onPress,
  disabled = false,
  accessibilityLabel,
  style,
}: ListItemProps) {
  const theme = useTheme();

  const content = (
    <>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="footnote" color="inkMuted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ?? (chevron ? <Chevron direction="right" color={theme.colors.inkSubtle} /> : null)}
    </>
  );

  const base: ViewStyle = {
    minHeight: subtitle ? 64 : TOUCH_TARGET + 12,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.xs,
    gap: theme.spacing.lg,
  };

  if (!onPress) {
    return <View style={[styles.row, base, style]}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        base,
        { borderRadius: theme.radii.md, opacity: disabled ? 0.45 : 1 },
        pressed ? { backgroundColor: theme.colors.surfaceElevated } : null,
        style,
      ]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  leading: { alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
});
