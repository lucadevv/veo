import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Button } from '@veo/ui-kit';

export interface QuickRepliesProps {
  /** Plantillas listas (ya traducidas) que el conductor puede tocar sin escribir. */
  replies: readonly string[];
  /** Envía la plantilla tocada. */
  onSelect: (text: string) => void;
  /** Deshabilita los atajos (envío en curso o viaje inactivo). */
  disabled?: boolean;
}

/**
 * Fila horizontal de respuestas rápidas (seguridad: el conductor no escribe mientras maneja).
 * Scroll horizontal para no recortar plantillas en pantallas estrechas; cada chip es un `Button`
 * `secondary` del ui-kit, con su feedback de press y target ≥44pt heredados del sistema.
 */
export const QuickReplies = ({
  replies,
  onSelect,
  disabled,
}: QuickRepliesProps): React.JSX.Element => (
  <ScrollView
    horizontal
    showsHorizontalScrollIndicator={false}
    keyboardShouldPersistTaps="handled"
    contentContainerStyle={styles.content}
  >
    {replies.map((text) => (
      <Button
        key={text}
        label={text}
        variant="secondary"
        size="sm"
        disabled={disabled}
        onPress={() => onSelect(text)}
        style={styles.chip}
      />
    ))}
  </ScrollView>
);

const styles = StyleSheet.create({
  content: { gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  chip: { flexShrink: 0 },
});
