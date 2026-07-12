import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';

export interface SegmentedTabItem {
  /** Clave estable del segmento. */
  key: string;
  /** Etiqueta visible (ya traducida). */
  label: string;
}

export interface SegmentedTabsProps {
  items: SegmentedTabItem[];
  value: string;
  onChange: (key: string) => void;
}

/**
 * Control segmentado (pill switcher) para alternar secciones dentro de una pantalla. Sigue el
 * lenguaje Midnight Motion: pista en superficie, segmento activo elevado con acento. Feedback de
 * press por opacidad (no scale: cambia de estado con frecuencia). Accesible como botones con
 * `selected`. La transición de color es instantánea para respetar reduce-motion sin esfuerzo.
 */
export function SegmentedTabs({ items, value, onChange }: SegmentedTabsProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.track,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.pill,
        },
      ]}
    >
      {items.map((item) => {
        const selected = item.key === value;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={item.label}
            onPress={() => onChange(item.key)}
            style={({ pressed }) => [
              styles.segment,
              {
                borderRadius: theme.radii.pill,
                // Segmento activo en acento sólido (surfaceElevated === surface === #FFFFFF sería blanco-sobre-blanco); el indicador ya no depende del borde.
                backgroundColor: selected ? theme.colors.accent : 'transparent',
                borderColor: 'transparent',
                opacity: pressed ? 0.85 : 1,
              },
            ]}
          >
            <Text
              variant="footnote"
              color={selected ? 'onAccent' : 'inkMuted'}
              numberOfLines={1}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    padding: 4,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderWidth: 1,
  },
});
