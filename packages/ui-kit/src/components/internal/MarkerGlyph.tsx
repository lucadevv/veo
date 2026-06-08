import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';

export type MarkerKind = 'origin' | 'destination' | 'user';

export interface MarkerGlyphProps {
  kind?: MarkerKind;
  /** Diámetro del glifo (px). */
  size?: number;
  style?: ViewStyle;
}

/**
 * Glifo de marcador de ubicación (puramente visual, sin lógica de mapa). Lima de marca:
 * `origin` = anillo hueco, `destination` = punto sólido con núcleo oscuro, `user` = punto con
 * halo. Lo consumen SearchField, OriginDestinationField y RoutePin para mantener un único
 * lenguaje de "punto lima".
 */
export function MarkerGlyph({ kind = 'origin', size = 14, style }: MarkerGlyphProps) {
  const theme = useTheme();
  const brand = theme.colors.brand;

  if (kind === 'origin') {
    return (
      <View
        style={[
          styles.center,
          { width: size, height: size, borderRadius: size / 2, borderWidth: Math.max(2, size * 0.18), borderColor: brand },
          style,
        ]}
      />
    );
  }

  if (kind === 'destination') {
    const core = Math.round(size * 0.34);
    return (
      <View
        style={[
          styles.center,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: brand },
          style,
        ]}
      >
        <View style={{ width: core, height: core, borderRadius: 2, backgroundColor: theme.colors.bg }} />
      </View>
    );
  }

  // user: punto sólido con anillo del lienzo (resalta sobre el mapa).
  return (
    <View
      style={[
        styles.center,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: brand,
          borderWidth: Math.max(2, size * 0.16),
          borderColor: theme.colors.bg,
        },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
