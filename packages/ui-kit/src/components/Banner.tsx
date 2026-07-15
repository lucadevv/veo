import { type ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { type ThemeColors } from '../tokens/themes';
import { hexAlpha } from './internal/color';
import { Button } from './Button';
import { Text } from './Text';

export type BannerTone = 'info' | 'success' | 'safe' | 'warn' | 'danger';

export interface BannerProps {
  title: string;
  description?: string;
  tone?: BannerTone;
  /** Ícono opcional a la izquierda (ya coloreado por el consumidor). */
  icon?: ReactNode;
  /** Acción inline opcional. */
  action?: { label: string; onPress: () => void };
  style?: ViewStyle;
}

const toneToColor: Record<BannerTone, keyof ThemeColors> = {
  info: 'info',
  success: 'success',
  safe: 'safe',
  warn: 'warn',
  danger: 'danger',
};

/**
 * Aviso inline. Fondo tintado del tono (sin side-stripe: está prohibido). Para `danger` anuncia
 * como alerta a lectores de pantalla. El color va acompañado de texto e ícono opcional.
 */
export function Banner({ title, description, tone = 'info', icon, action, style }: BannerProps) {
  const theme = useTheme();
  const colorKey = toneToColor[tone];
  const tint = theme.colors[colorKey];

  return (
    <View
      accessibilityRole={tone === 'danger' ? 'alert' : 'summary'}
      accessibilityLiveRegion={tone === 'danger' ? 'assertive' : 'polite'}
      style={[
        styles.container,
        {
          backgroundColor: hexAlpha(tint, theme.scheme === 'dark' ? 0.18 : 0.1),
          borderRadius: theme.radii.md,
          padding: theme.spacing.lg,
          gap: theme.spacing.md,
        },
        style,
      ]}
    >
      <View style={styles.row}>
        {icon ? <View style={styles.icon}>{icon}</View> : null}
        <View style={styles.body}>
          <Text variant="bodyStrong" color={colorKey}>
            {title}
          </Text>
          {description ? (
            <Text variant="callout" color="inkMuted" style={styles.desc}>
              {description}
            </Text>
          ) : null}
        </View>
      </View>
      {action ? (
        <Button label={action.label} onPress={action.onPress} variant="ghost" size="sm" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch' },
  row: { flexDirection: 'row', gap: 12 },
  icon: { paddingTop: 2 },
  body: { flex: 1, gap: 2 },
  desc: { marginTop: 2 },
});
