import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Card, SafeScreen, Skeleton, Text, useTheme } from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { useMarkAllNotificationsRead, useNotifications } from '../hooks/useNotifications';
import { NotificationRow } from '../components/NotificationRow';

type Props = NativeStackScreenProps<RootStackParamList, 'Notifications'>;

/** Fila-fantasma del feed durante la carga (círculo + dos líneas), coherente con `NotificationRow`. */
function SkeletonRow(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Card variant="elevated" padding="lg">
      <View style={styles.skeletonRow}>
        <Skeleton variant="circle" height={40} />
        <View style={styles.skeletonLines}>
          <Skeleton height={14} width="60%" radius={theme.radii.sm} />
          <Skeleton height={12} width="90%" radius={theme.radii.sm} />
          <Skeleton height={10} width="30%" radius={theme.radii.sm} />
        </View>
      </View>
    </Card>
  );
}

/**
 * Centro de avisos del CONDUCTOR (feed in-app). Cubre los cuatro estados —carga (skeleton) / error
 * (reintentable) / vacío / lista— sobre `GetNotificationsUseCase`. Vacío HONESTO: el feed está
 * conectado al backend; lista vacía = aún no hay avisos (sin "próximamente").
 *
 * LEÍDOS: al ENTRAR con no-leídos se dispara read-all (una vez por visita) — entrar a la bandeja ES
 * leerla (patrón del pasajero, condensado: allí el gesto es explícito). El borde de acento de las
 * filas y el punto de la campana del Dashboard se apagan con el estado REAL: la caché solo se marca
 * leída cuando el server confirma (si el PATCH falla, los no-leídos persisten — honesto).
 */
export const NotificationsScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { data, isLoading, isError, error, refetch } = useNotifications();
  const markAllRead = useMarkAllNotificationsRead();

  // Una sola pasada por visita: cuando el feed llega con no-leídos, se marcan todos como leídos.
  const markedOnEnter = useRef(false);
  useEffect(() => {
    if (markedOnEnter.current || !data) {
      return;
    }
    if (data.some((n) => !n.read)) {
      markedOnEnter.current = true;
      markAllRead.mutate();
    }
  }, [data, markAllRead]);

  const header = <TopBar title={t('notifications.title')} onBack={navigation.goBack} />;

  if (isLoading) {
    return (
      <SafeScreen header={header}>
        <View style={[styles.list, { gap: theme.spacing.md }]}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      </SafeScreen>
    );
  }

  if (isError || !data) {
    return (
      <SafeScreen header={header}>
        <StateView
          title={t('notifications.loadError')}
          description={toErrorMessage(error, t)}
          action={{ label: t('common.retry'), onPress: () => refetch() }}
        />
      </SafeScreen>
    );
  }

  if (data.length === 0) {
    return (
      <SafeScreen header={header}>
        <StateView title={t('notifications.emptyTitle')} description={t('notifications.emptyBody')} />
      </SafeScreen>
    );
  }

  return (
    <SafeScreen scroll header={header}>
      <View style={[styles.list, { gap: theme.spacing.md, paddingBottom: theme.spacing['3xl'] }]}>
        {data.map((notification, index) => (
          <Reveal key={notification.id} delay={index * 60}>
            <NotificationRow notification={notification} />
          </Reveal>
        ))}
        <Text variant="footnote" color="inkSubtle" align="center" style={styles.end}>
          {t('notifications.end')}
        </Text>
      </View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  list: { flex: 1 },
  end: { marginTop: 8 },
  skeletonRow: { flexDirection: 'row', gap: 13, alignItems: 'center' },
  skeletonLines: { flex: 1, gap: 8 },
});
