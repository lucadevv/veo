import React, { useCallback } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TripHistoryItem } from '@veo/api-client';
import { SafeScreen, Skeleton, Text, useTheme } from '@veo/ui-kit';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { TripsEmptyState } from '../components/TripsEmptyState';
import { TripHistoryRow } from '../components/TripHistoryRow';
import { useTripHistory } from '../hooks/useTrips';

/** Encabezado simple de la pestaña Viajes (sin retroceso: es un tab, no una pila). */
function TripsHeader({ title }: { title: string }): React.JSX.Element {
  return (
    <View style={styles.header}>
      <Text variant="title1" numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

/** Skeleton del historial: la silueta de la fila (no un spinner pelado) durante la primera carga. */
function HistorySkeleton(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ paddingTop: theme.spacing.md, gap: theme.spacing.md }}>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} height={132} radius={theme.radii.lg} />
      ))}
    </View>
  );
}

/**
 * Historial de viajes del conductor.
 *
 * Cableado al `GET /trips/history` del driver-bff (paginado por cursor keyset), ESPEJANDO el flujo del
 * pasajero: `useTripHistory` (useInfiniteQuery) trae `{ items, nextCursor }` con los ESTADOS REALES del
 * servidor (COMPLETED/CANCELLED/EXPIRED). CUATRO estados HONESTOS — nunca confundir vacío con cargando:
 *  - loading → SKELETON con la silueta de la fila,
 *  - error   → estado con reintentar (sin degradar a datos viejos: sería mentir),
 *  - vacío   → empty state premium con el copy honesto ("Aún no hay viajes para mostrar"),
 *  - datos   → FlatList de filas + paginación infinita (onEndReached → fetchNextPage) + pull-to-refresh.
 *
 * La fila es PRESSABLE: navega al detalle/recibo del viaje (frame C/Historial-Detalle) pasando el
 * `TripHistoryItem` completo que ya cargó (fuente real del recibo, más rica que el `GET /trips/:id`).
 */
export const TripHistoryScreen = (): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const {
    items,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    isRefetching,
    fetchNextPage,
    refetch,
  } = useTripHistory();

  const renderItem = useCallback(
    ({ item, index }: { item: TripHistoryItem; index: number }) => (
      <Reveal delay={Math.min(index, 6) * 40} distance={8}>
        <TripHistoryRow trip={item} />
      </Reveal>
    ),
    [],
  );

  const listFooter = (
    <View style={{ paddingVertical: theme.spacing.lg, gap: theme.spacing.sm }}>
      {isFetchingNextPage ? (
        <View style={styles.footerLoading}>
          <ActivityIndicator color={theme.colors.accent} />
          <Text variant="footnote" color="inkSubtle">
            {t('trips.history.loadingMore')}
          </Text>
        </View>
      ) : !hasNextPage && items.length > 0 ? (
        <Text variant="footnote" color="inkSubtle" align="center">
          {t('trips.history.endOfList')}
        </Text>
      ) : null}
    </View>
  );

  const body = isLoading ? (
    <HistorySkeleton />
  ) : isError ? (
    <StateView
      title={t('trips.history.errorTitle')}
      action={{ label: t('common.retry'), onPress: refetch }}
    />
  ) : items.length === 0 ? (
    <TripsEmptyState
      title={t('trips.history.emptyTitle')}
      description={t('trips.history.emptyBody')}
    />
  ) : (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        paddingTop: theme.spacing.md,
        paddingBottom: theme.spacing.xl,
        gap: theme.spacing.md,
      }}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={refetch}
          tintColor={theme.colors.accent}
          colors={[theme.colors.accent]}
        />
      }
      // Paginación infinita por cursor: al acercarse al fondo, pide la siguiente página. El hook ya gatea
      // (no dispara si no hay más o si ya hay una en vuelo), así un onEndReached agresivo es seguro.
      onEndReachedThreshold={0.4}
      onEndReached={fetchNextPage}
      ListFooterComponent={listFooter}
    />
  );

  return <SafeScreen header={<TripsHeader title={t('trips.historyTitle')} />}>{body}</SafeScreen>;
};

const styles = StyleSheet.create({
  header: { paddingTop: 8, paddingBottom: 12 },
  footerLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
});
