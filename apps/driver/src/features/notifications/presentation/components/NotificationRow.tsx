import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Card, hexAlpha, Text, useTheme } from '@veo/ui-kit';
import type { AppNotification } from '../../domain';
import { iconForKind, toneForKind } from '../notificationVisuals';
import { relativeTime } from '../relativeTime';

export interface NotificationRowProps {
  notification: AppNotification;
}

/**
 * Fila del feed de avisos (fiel al frame C/Notificaciones): tile cuadrado redondeado con fondo tintado
 * por el tono de su categoría + su ícono, el título con el tiempo relativo alineado a la derecha, y el
 * cuerpo debajo. Cuando NO está leído, la card toma el borde de acento (única señal, como en el frame).
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
      <View
        style={styles.row}
        accessibilityLabel={unread ? t('notifications.unread') : undefined}
      >
        <View
          style={[
            styles.leadTile,
            { borderRadius: theme.radii.md, backgroundColor: hexAlpha(iconColor, 0.15) },
          ]}
        >
          <Glyph color={iconColor} size={20} />
        </View>
        <View style={styles.flex}>
          <View style={styles.titleRow}>
            <Text variant="bodyStrong" style={styles.title}>
              {notification.title}
            </Text>
            {time ? (
              <Text variant="caption" color="inkSubtle" style={styles.time}>
                {time}
              </Text>
            ) : null}
          </View>
          <Text variant="footnote" color="inkMuted" style={styles.body}>
            {notification.body}
          </Text>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 13, alignItems: 'flex-start' },
  flex: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  title: { flex: 1 },
  body: { marginTop: 4 },
  time: { marginTop: 2 },
  leadTile: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
