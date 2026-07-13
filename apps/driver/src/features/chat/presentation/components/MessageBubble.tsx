import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';
import type { Message } from '../../domain';
import { isOwnMessage } from '../../domain';
import { formatTimeOfDay } from '../../../../shared/presentation/format';
import { BubbleAppear } from './motion';

export interface MessageBubbleProps {
  message: Message;
}

/**
 * Burbuja de chat. Las propias del conductor (rol DRIVER) van a la derecha sobre el acento cian;
 * las del pasajero a la izquierda sobre `surface`. Una sola esquina "pegada" al lado del autor
 * (radio reducido) ancla visualmente la burbuja a su columna sin recurrir a colas/triángulos.
 */
export const MessageBubble = React.memo(({ message }: MessageBubbleProps): React.JSX.Element => {
  const theme = useTheme();
  const own = isOwnMessage(message);
  const time = formatTimeOfDay(message.createdAt);

  const bubbleStyle = {
    backgroundColor: own ? theme.colors.accent : theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: own ? 0 : StyleSheet.hairlineWidth,
    borderRadius: theme.radii.lg,
    borderBottomRightRadius: own ? theme.radii.sm : theme.radii.lg,
    borderBottomLeftRadius: own ? theme.radii.lg : theme.radii.sm,
  };

  return (
    <BubbleAppear style={[styles.row, own ? styles.rowOwn : styles.rowOther]}>
      <View style={[styles.bubble, bubbleStyle]}>
        <Text variant="callout" color={own ? 'onAccent' : 'ink'}>
          {message.body}
        </Text>
        {time ? (
          <Text
            variant="caption"
            color={own ? 'onAccent' : 'inkSubtle'}
            align="right"
            tabular
            style={styles.time}
          >
            {time}
          </Text>
        ) : null}
      </View>
    </BubbleAppear>
  );
});

MessageBubble.displayName = 'MessageBubble';

const styles = StyleSheet.create({
  row: { flexDirection: 'row', marginVertical: 3 },
  rowOwn: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '82%', paddingHorizontal: 14, paddingVertical: 9 },
  time: { marginTop: 3, opacity: 0.85 },
});
