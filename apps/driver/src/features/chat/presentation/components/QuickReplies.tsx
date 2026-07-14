import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';

export interface QuickRepliesProps {
  /** Plantillas listas (ya traducidas) que el conductor puede tocar sin escribir. */
  replies: readonly string[];
  /** Envía la plantilla tocada. */
  onSelect: (text: string) => void;
  /** Deshabilita los atajos (envío en curso o viaje inactivo). */
  disabled?: boolean;
}

/**
 * Fila de respuestas rápidas (seguridad: el conductor no escribe mientras maneja). Chips pill
 * recesados (`surfaceMuted`, sin borde) pensados para vivir DENTRO de la card del composer —
 * mismo diseño que el chat del pasajero (simetría entre apps, regla del dueño). Envuelve en
 * varias filas si no entran (no recorta plantillas en pantallas estrechas).
 */
export const QuickReplies = ({
  replies,
  onSelect,
  disabled,
}: QuickRepliesProps): React.JSX.Element => {
  const theme = useTheme();
  return (
    <View style={[styles.row, { gap: theme.spacing.xs }]}>
      {replies.map((text) => (
        <Pressable
          key={text}
          onPress={() => onSelect(text)}
          disabled={disabled}
          accessibilityRole="button"
          style={({ pressed }) => [
            {
              backgroundColor: theme.colors.surfaceMuted,
              borderRadius: theme.radii.pill,
              paddingVertical: theme.spacing.xs,
              paddingHorizontal: theme.spacing.md,
              opacity: pressed || disabled ? 0.7 : 1,
            },
          ]}
        >
          <Text variant="footnote" color="inkMuted">
            {text}
          </Text>
        </Pressable>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap' },
});
