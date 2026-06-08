import { useState } from 'react';
import { Image, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { hexAlpha } from './internal/color';
import { Text } from './Text';

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

export interface AvatarProps {
  /** URL de la imagen. Si falta o falla, muestra iniciales. */
  uri?: string;
  /** Nombre para iniciales y a11y. */
  name?: string;
  size?: AvatarSize;
  /** Anillo de estado (p.ej. conductor en línea). */
  online?: boolean;
  style?: ViewStyle;
}

const sizeMap: Record<AvatarSize, number> = { sm: 32, md: 44, lg: 56, xl: 72 };

function initials(name?: string): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join('');
}

/** Avatar circular con fallback a iniciales y anillo de estado opcional. */
export function Avatar({ uri, name, size = 'md', online = false, style }: AvatarProps) {
  const theme = useTheme();
  const [failed, setFailed] = useState(false);
  const dimension = sizeMap[size];
  const showImage = Boolean(uri) && !failed;
  const dotSize = Math.max(10, Math.round(dimension * 0.28));

  return (
    <View style={[{ width: dimension, height: dimension }, style]}>
      {showImage ? (
        <Image
          accessibilityRole="image"
          accessibilityLabel={name ? `Foto de ${name}` : 'Avatar'}
          source={{ uri }}
          onError={() => setFailed(true)}
          style={{
            width: dimension,
            height: dimension,
            borderRadius: dimension / 2,
            backgroundColor: theme.colors.surfaceElevated,
          }}
        />
      ) : (
        <View
          accessibilityRole="image"
          accessibilityLabel={name ? `Avatar de ${name}` : 'Avatar'}
          style={[
            styles.fallback,
            {
              width: dimension,
              height: dimension,
              borderRadius: dimension / 2,
              backgroundColor: hexAlpha(theme.colors.brand, theme.scheme === 'dark' ? 0.3 : 0.12),
            },
          ]}
        >
          <Text variant={size === 'sm' ? 'caption' : 'headline'} color="brand">
            {initials(name)}
          </Text>
        </View>
      )}

      {online ? (
        <View
          style={[
            styles.statusDot,
            {
              width: dotSize,
              height: dotSize,
              borderRadius: dotSize / 2,
              backgroundColor: theme.colors.success,
              borderColor: theme.colors.surface,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center' },
  statusDot: { position: 'absolute', right: 0, bottom: 0, borderWidth: 2 },
});
