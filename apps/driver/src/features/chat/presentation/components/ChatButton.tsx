import React from 'react';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text, useTheme } from '@veo/ui-kit';
import { IconMessage } from '../../../../shared/presentation/icons';
import { useChatUnread } from '../hooks/useChat';

export interface ChatButtonProps {
  tripId: string;
  onPress: () => void;
  /** Etiqueta accesible (ya traducida por el consumidor). */
  accessibilityLabel: string;
  disabled?: boolean;
}

/**
 * Botón de chat con el pasajero + badge de no leídos. Se monta en el viaje activo; el contador sale
 * del store de chat (alimentado por el `chat:message` del socket aunque el chat esté cerrado). El
 * badge solo aparece con ≥1 no leído y satura a "9+".
 */
export const ChatButton = ({
  tripId,
  onPress,
  accessibilityLabel,
  disabled,
}: ChatButtonProps): React.JSX.Element => {
  const theme = useTheme();
  const unread = useChatUnread(tripId);
  const a11y = unread > 0 ? `${accessibilityLabel} (${unread})` : accessibilityLabel;

  return (
    <View style={styles.wrap}>
      <IconButton
        icon={<IconMessage size={22} color={theme.colors.accent} />}
        accessibilityLabel={a11y}
        variant="surface"
        size="lg"
        disabled={disabled}
        onPress={onPress}
      />
      {unread > 0 ? (
        <View
          pointerEvents="none"
          style={[
            styles.badge,
            { backgroundColor: theme.colors.accent, borderColor: theme.colors.bg },
          ]}
        >
          <Text variant="caption" color="onAccent" tabular style={styles.badgeText}>
            {unread > 9 ? '9+' : String(unread)}
          </Text>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
});
