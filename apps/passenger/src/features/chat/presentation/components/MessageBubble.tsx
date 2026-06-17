import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {formatDateTime} from '../../../../shared/utils/format';
import type {ChatMessage} from '../../domain/entities';
import {isOwnMessage} from '../../domain/entities';

export interface MessageBubbleProps {
  message: ChatMessage;
}

/**
 * Burbuja de mensaje. Propios (pasajero) en acento lima alineados a la derecha; del conductor en
 * superficie alineados a la izquierda. La hora va debajo, sutil. El color del texto propio usa
 * `onAccent` para contraste AA sobre el lima.
 */
export function MessageBubble({
  message,
}: MessageBubbleProps): React.JSX.Element {
  const theme = useTheme();
  const own = isOwnMessage(message);

  return (
    <View style={[styles.row, {alignItems: own ? 'flex-end' : 'flex-start'}]}>
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: own ? theme.colors.accent : theme.colors.surface,
            // Esquina "cola" más cerrada del lado del remitente; el resto redondeado.
            borderTopRightRadius: own ? theme.radii.sm : theme.radii.lg,
            borderTopLeftRadius: own ? theme.radii.lg : theme.radii.sm,
            borderBottomLeftRadius: theme.radii.lg,
            borderBottomRightRadius: theme.radii.lg,
            paddingVertical: theme.spacing.sm,
            paddingHorizontal: theme.spacing.md,
          },
        ]}>
        <Text variant="body" color={own ? 'onAccent' : 'ink'}>
          {message.body}
        </Text>
      </View>
      <Text
        variant="caption"
        color="inkSubtle"
        style={{marginTop: theme.spacing.xxs}}
        tabular>
        {formatDateTime(message.createdAt)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {width: '100%'},
  bubble: {maxWidth: '82%'},
});
