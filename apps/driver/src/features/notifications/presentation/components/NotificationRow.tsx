import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Card, Text, useTheme } from '@veo/ui-kit';
import type { AppNotification } from '../../domain';
import { iconForKind, toneForKind } from '../notificationVisuals';
import { relativeTime } from '../relativeTime';

export interface NotificationRowProps {
  notification: AppNotification;
}

/**
 * Fila del feed de avisos: círculo con el ícono de su categoría (coloreado por tono) + título + cuerpo +
 * tiempo relativo. Cuando NO está leído, el borde y el círculo toman el acento y aparece un punto de
 * no-leído a la derecha (misma lengua visual que el feed del pasajero, con los tokens del conductor).
 */
export function NotificationRow({ notification }: NotificationRowProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const Glyph = iconForKind(notification.kind);
  const tone = toneForKind(notification.kind);
  const iconColor = theme.colors[tone];
  const unread = !notification.read;
  const time = relativeTime(notification.createdAt, t);

  return (
    <Card
      variant="outlined"
      padding="lg"
      style={unread ? { borderColor: theme.colors.accent } : undefined}
    >
      <View style={styles.row}>
        <View
          style={[
            styles.leadCircle,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderColor: unread ? theme.colors.accent : theme.colors.border,
            },
          ]}
        >
          <Glyph color={iconColor} size={18} />
        </View>
        <View style={styles.flex}>
          <View style={styles.titleRow}>
            <Text variant="bodyStrong" style={styles.title}>
              {notification.title}
            </Text>
            {unread ? (
              <View
                accessibilityLabel={t('notifications.unread')}
                style={[styles.dot, { backgroundColor: theme.colors.accent }]}
              />
            ) : null}
          </View>
          <Text variant="footnote" color="inkMuted" style={styles.body}>
            {notification.body}
          </Text>
          {time ? (
            <Text variant="caption" color="inkSubtle" style={styles.time}>
              {time}
            </Text>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 13, alignItems: 'flex-start' },
  flex: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flexShrink: 1 },
  body: { marginTop: 4 },
  time: { marginTop: 4 },
  leadCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
