import {IconButton, SosButton, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {IconChat} from './icons';
import {LiveBadge} from './LiveBadge';

export interface TripTopBarProps {
  /** Mensajes del conductor sin leer (badge sobre el botón de chat). */
  unreadCount: number;
  onOpenChat: () => void;
  onSos: () => void;
}

/** Chrome del VIAJE ACTIVO sobre el mapa: SOS (der.), pill "EN VIVO" (centro), chat (izq. + badge). */
export function TripTopBar({
  unreadCount,
  onOpenChat,
  onSos,
}: TripTopBarProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <>
      <View
        style={[
          styles.tripSos,
          {top: insets.top + theme.spacing.sm, right: theme.spacing.lg},
        ]}>
        <SosButton size={56} onPress={onSos} />
      </View>
      <View
        style={[styles.tripPill, {top: insets.top + theme.spacing.sm}]}
        pointerEvents="none">
        <LiveBadge />
      </View>
      <View
        style={[
          styles.tripChat,
          {top: insets.top + theme.spacing.sm, left: theme.spacing.lg},
        ]}>
        <IconButton
          accessibilityLabel={t('chat.open')}
          variant="surface"
          onPress={onOpenChat}
          icon={<IconChat color={theme.colors.ink} size={20} />}
        />
        {unreadCount > 0 ? (
          <View
            style={[
              styles.tripBadge,
              {
                backgroundColor: theme.colors.accent,
                borderColor: theme.colors.bg,
              },
            ]}>
            <Text variant="caption" color="onAccent" tabular>
              {unreadCount > 9 ? '9+' : unreadCount}
            </Text>
          </View>
        ) : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // Chrome flotante del viaje activo sobre el mapa.
  tripSos: {position: 'absolute'},
  tripChat: {position: 'absolute'},
  tripPill: {position: 'absolute', left: 0, right: 0, alignItems: 'center'},
  tripBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
