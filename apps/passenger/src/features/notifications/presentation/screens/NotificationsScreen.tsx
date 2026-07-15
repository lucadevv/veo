import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Banner,
  Button,
  Card,
  IconButton,
  SafeScreen,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, ScrollView, StyleSheet, View} from 'react-native';
import {container} from '../../../../core/di/registry';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import type {RootStackParamList} from '../../../../navigation/types';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {ScreenHeader} from '../../../../shared/presentation/components/ScreenHeader';
import {formatShortDate} from '../../../../shared/utils/format';
import type {AppNotification, NotificationKind} from '../../domain/entities';
import {IconSettings, iconForKind} from '../icons';

const LIST_KEY = ['notifications', 'list'] as const;

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
 * el pasajero todavía no tiene avisos (estado vacío HONESTO, sin "próximamente" falso). Leído/no-leído
 * YA implementado: el `read` viene del `read_at` real del server, el badge cuenta los no-leídos y
 * "marcar todo como leído" (markAllRead) los limpia.
 */
export function NotificationsScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const listNotifications = useDependency(TOKENS.listNotificationsUseCase);
  const queryClient = useQueryClient();

  // Engranaje → preferencias de notificaciones (pen: el feed "Avisos" y las preferencias
  // "Notificaciones" son DOS pantallas). Antes era headerRight del header nativo; con el header
  // IN-BODY vive en el slot `trailing` del ScreenHeader, en TODAS las branches (loading/error/
  // vacío/lista) para no perder la entrada a los ajustes.
  const trailing = (
    <IconButton
      accessibilityLabel={t('notifications.prefs.openSettings')}
      variant="plain"
      size="sm"
      icon={<IconSettings color={theme.colors.ink} size={20} />}
      onPress={() => navigation.navigate('NotificationPrefs')}
    />
  );
  const header = (
    <ScreenHeader title={t('screens.notifications')} trailing={trailing} />
  );

  const query = useQuery({
    queryKey: LIST_KEY,
    queryFn: () => listNotifications.execute(),
  });

  // Actualiza el cache de la lista marcando como leídas las notificaciones indicadas (optimistic).
  const applyRead = React.useCallback(
    (ids: 'all' | string[]) => {
      queryClient.setQueryData<AppNotification[]>(LIST_KEY, prev =>
        prev?.map(n =>
          ids === 'all' || ids.includes(n.id) ? {...n, read: true} : n,
        ),
      );
    },
    [queryClient],
  );

  // Mutación "marcar leído". Resolución PEREZOSA + GUARDADA: si el binding DI aún no está cableado
  // (lo consolida el lead en el registry), el tap es un no-op honesto en vez de crashear la pantalla.
  const markReadMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!container.has(TOKENS.markNotificationReadUseCase)) return;
      await container.resolve(TOKENS.markNotificationReadUseCase).execute(id);
    },
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({queryKey: LIST_KEY});
      const prev = queryClient.getQueryData<AppNotification[]>(LIST_KEY);
      applyRead([id]);
      return {prev};
    },
    onError: (_e, _id, ctx) => {
      // Revert: la marca no cuajó en el server → restauramos el estado previo y avisamos.
      if (ctx?.prev) queryClient.setQueryData(LIST_KEY, ctx.prev);
    },
    onSettled: () => queryClient.invalidateQueries({queryKey: LIST_KEY}),
  });

  const markAllMutation = useMutation({
    mutationFn: async () => {
      if (!container.has(TOKENS.markAllNotificationsReadUseCase)) return;
      await container.resolve(TOKENS.markAllNotificationsReadUseCase).execute();
    },
    onMutate: async () => {
      await queryClient.cancelQueries({queryKey: LIST_KEY});
      const prev = queryClient.getQueryData<AppNotification[]>(LIST_KEY);
      applyRead('all');
      return {prev};
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(LIST_KEY, ctx.prev);
    },
    onSettled: () => queryClient.invalidateQueries({queryKey: LIST_KEY}),
  });

  const markError = markReadMutation.isError || markAllMutation.isError;

  if (query.isLoading) {
    return (
      <SafeScreen>
        {header}
        <LoadingState />
      </SafeScreen>
    );
  }

  if (query.isError) {
    return (
      <SafeScreen>
        {header}
        <ErrorState
          message={t('notifications.loadError')}
          onRetry={() => query.refetch()}
        />
      </SafeScreen>
    );
  }

  const notifications = query.data ?? [];

  if (notifications.length === 0) {
    // Vacío HONESTO: el feed está conectado al backend; lista vacía = aún no hay avisos (no "próximamente").
    return (
      <SafeScreen>
        {header}
        <EmptyState
          title={t('notifications.empty')}
          subtitle={t('notifications.emptySubtitle')}
        />
      </SafeScreen>
    );
  }

  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <SafeScreen padded={false}>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.md,
        }}
        showsVerticalScrollIndicator={false}>
        {/* Header in-body (patrón ScreenHeader del pen): back pill + título + engranaje. */}
        {header}
        {markError ? (
          <Banner
            tone="warn"
            title={t('notifications.markReadErrorTitle')}
            description={t('notifications.markReadErrorBody')}
          />
        ) : null}
        {/* "Marcar todo leído": solo cuando hay no leídos. Optimistic con revert ante error. */}
        {unreadCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            label={t('notifications.markAllRead')}
            onPress={() => markAllMutation.mutate()}
            disabled={markAllMutation.isPending}
            style={styles.markAll}
          />
        ) : null}
        {notifications.map(item => (
          <NotificationCard
            key={item.id}
            notification={item}
            onPress={() => {
              if (!item.read) markReadMutation.mutate(item.id);
            }}
          />
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
  onPress: () => void;
}

/**
 * Tarjeta de un aviso: círculo con el ícono de su categoría, título, cuerpo y fecha. Al tocarla se
 * marca como leída (si estaba no leída). Un punto de acento señala las NO leídas.
 */
function NotificationCard({
  notification,
  onPress,
}: NotificationCardProps): React.JSX.Element {
  const theme = useTheme();
  const Glyph = iconForKind(notification.kind);
  const tone = toneForKind(notification.kind);
  const iconColor = theme.colors[tone];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={notification.title}
      onPress={onPress}>
      <Card variant="outlined" padding="lg">
        <View style={styles.row}>
          <View
            style={[
              styles.leadCircle,
              {
                backgroundColor: theme.colors.surfaceElevated,
                borderColor: theme.colors.border,
              },
            ]}>
            <Glyph color={iconColor} size={18} />
          </View>
          <View style={styles.flex}>
            <Text variant="bodyStrong">{notification.title}</Text>
            <Text
              variant="footnote"
              color="inkMuted"
              style={{marginTop: theme.spacing.xs}}>
              {notification.body}
            </Text>
            <Text
              variant="caption"
              color="inkSubtle"
              style={{marginTop: theme.spacing.xs}}>
              {formatShortDate(notification.createdAt)}
            </Text>
          </View>
          {/* Punto de "no leído": desaparece al marcar. */}
          {!notification.read ? (
            <View
              style={[styles.unreadDot, {backgroundColor: theme.colors.accent}]}
            />
          ) : null}
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', gap: 13, alignItems: 'flex-start'},
  flex: {flex: 1},
  leadCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markAll: {alignSelf: 'flex-end'},
  unreadDot: {width: 8, height: 8, borderRadius: 4, marginTop: 6},
});
