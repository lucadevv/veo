import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {formatTimeOfDay} from '../../../../shared/utils/format';
import type {ChatMessage} from '../../domain/entities';
import {isOwnMessage} from '../../domain/entities';

export interface MessageBubbleProps {
  message: ChatMessage;
}

/**
 * Burbuja de chat (mismo diseño que el conductor · identidad Trust): las propias del pasajero van a la
 * derecha sobre el acento teal; las del conductor a la izquierda sobre `surface` DELINEADO (hairline) para
 * que la burbuja tenga cuerpo sobre el lienzo claro. Una sola esquina "pegada" al lado del autor (radio
 * reducido) ancla la burbuja a su columna sin colas. La HORA (HH:MM, no la fecha completa) va DENTRO de la
 * burbuja, abajo a la derecha, sutil — el separador de día ("Hoy") ya da el contexto de fecha.
 */
export const MessageBubble = React.memo(
  ({message}: MessageBubbleProps): React.JSX.Element => {
    const theme = useTheme();
    const own = isOwnMessage(message);
    const time = formatTimeOfDay(message.createdAt);

    return (
      <View style={[styles.row, own ? styles.rowOwn : styles.rowOther]}>
        <View
          style={[
            styles.bubble,
            {
              backgroundColor: own ? theme.colors.accent : theme.colors.surface,
              borderColor: theme.colors.border,
              borderWidth: own ? 0 : StyleSheet.hairlineWidth,
              borderRadius: theme.radii.lg,
              // Esquina "cola" más cerrada del lado del autor; el resto redondeado.
              borderBottomRightRadius: own ? theme.radii.sm : theme.radii.lg,
              borderBottomLeftRadius: own ? theme.radii.lg : theme.radii.sm,
            },
          ]}>
          <Text variant="callout" color={own ? 'onAccent' : 'ink'}>
            {message.body}
          </Text>
          {time ? (
            <Text
              variant="caption"
              color={own ? 'onAccent' : 'inkSubtle'}
              align="right"
              tabular
              style={styles.time}>
              {time}
            </Text>
          ) : null}
        </View>
      </View>
    );
  },
);

MessageBubble.displayName = 'MessageBubble';

const styles = StyleSheet.create({
  row: {flexDirection: 'row', marginVertical: 3},
  rowOwn: {justifyContent: 'flex-end'},
  rowOther: {justifyContent: 'flex-start'},
  bubble: {maxWidth: '82%', paddingHorizontal: 14, paddingVertical: 9},
  time: {marginTop: 3, opacity: 0.85},
});
