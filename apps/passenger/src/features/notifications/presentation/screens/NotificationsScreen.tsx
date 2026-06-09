import { useQuery } from '@tanstack/react-query';
import { Card, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { EmptyState, ErrorState, LoadingState } from '../../../../shared/presentation/components/ScreenStates';
import { formatShortDate } from '../../../../shared/utils/format';
import type { AppNotification, NotificationKind } from '../../domain/entities';
import { iconForKind } from '../icons';

/** Tono (color del ícono) por categoría de aviso. */
function toneForKind(kind: NotificationKind): 'accent' | 'warn' | 'inkMuted' {
  if (kind === 'SAFETY') {
    return 'warn';
  }
  if (kind === 'TRIP') {
    return 'accent';
  }
  return 'inkMuted';
}

/**
 * Centro de avisos del pasajero (Notifs del design-handoff). Cubre los cuatro estados
 * (carga/error/vacío/lista) sobre el puerto `ListNotificationsUseCase`.
 *
 * Conectado al backend REAL (`GET /notifications` del public-bff → notification-service): trae las
 * notificaciones PUSH del pasajero ya renderizadas (título + cuerpo del template i18n). Lista vacía =
 * el pasajero todavía no tiene avisos (estado vacío HONESTO, sin "próximamente" falso). Sin
 * leído/no-leído por ahora (MVP cronológico; el `read_at` real es un follow-up).
 */
export function NotificationsScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const listNotifications = useDependency(TOKENS.listNotificationsUseCase);

  const query = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => listNotifications.execute(),
  });

  if (query.isLoading) {
    return (
      <SafeScreen>
        <LoadingState />
      </SafeScreen>
    );
  }

  if (query.isError) {
    return (
      <SafeScreen>
        <ErrorState message={t('notifications.loadError')} onRetry={() => query.refetch()} />
      </SafeScreen>
    );
  }

  const notifications = query.data ?? [];

  if (notifications.length === 0) {
    // Vacío HONESTO: el feed está conectado al backend; lista vacía = aún no hay avisos (no "próximamente").
    return (
      <SafeScreen>
        <EmptyState title={t('notifications.empty')} subtitle={t('notifications.emptySubtitle')} />
      </SafeScreen>
    );
  }

  return (
    <SafeScreen padded={false}>
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.xl, gap: theme.spacing.md }}
        showsVerticalScrollIndicator={false}
      >
        {notifications.map((item) => (
          <NotificationCard key={item.id} notification={item} />
        ))}
        <Text variant="footnote" color="inkSubtle" align="center">
          {t('notifications.end')}
        </Text>
      </ScrollView>
    </SafeScreen>
  );
}

interface NotificationCardProps {
  notification: AppNotification;
}

/** Tarjeta de un aviso: círculo con el ícono de su categoría, título, cuerpo y fecha. */
function NotificationCard({ notification }: NotificationCardProps): React.JSX.Element {
  const theme = useTheme();
  const Glyph = iconForKind(notification.kind);
  const tone = toneForKind(notification.kind);
  const iconColor = theme.colors[tone];

  return (
    <Card variant="outlined" padding="lg">
      <View style={styles.row}>
        <View
          style={[
            styles.leadCircle,
            { backgroundColor: theme.colors.surfaceElevated, borderColor: theme.colors.border },
          ]}
        >
          <Glyph color={iconColor} size={18} />
        </View>
        <View style={styles.flex}>
          <Text variant="bodyStrong">{notification.title}</Text>
          <Text variant="footnote" color="inkMuted" style={{ marginTop: theme.spacing.xs }}>
            {notification.body}
          </Text>
          <Text variant="caption" color="inkSubtle" style={{ marginTop: theme.spacing.xs }}>
            {formatShortDate(notification.createdAt)}
          </Text>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 13, alignItems: 'flex-start' },
  flex: { flex: 1 },
  leadCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
