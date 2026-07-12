import type {CarpoolSearchItem} from '@veo/api-client';
import {
  type RouteProp,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useInfiniteQuery} from '@tanstack/react-query';
import {Button, SafeScreen, Text, useTheme} from '@veo/ui-kit';
import React, {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {FlatList, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {ScreenHeader} from '../../../../shared/presentation/components/ScreenHeader';
import type {RootStackParamList} from '../../../../navigation/types';
import {EnterView} from '../../../trip/presentation/components/motion';
import {formatIsoDayShort} from '../../../../shared/utils/formatDay';
import {CarpoolTripCard} from '../components/CarpoolTripCard';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Tamaño de página de la búsqueda (keyset). */
const PAGE_SIZE = 20;

/**
 * Resultados de la búsqueda de carpooling (design/veo.pen P/ProgResults): header con la ruta
 * buscada + conteo, lista de cards (C/TripCard) y paginación KEYSET con `nextCursor` (cargar más
 * al llegar al final). Estados loading/error/empty honestos. Los FILTROS del pen
 * (Ordenar/Verificado/Precio/Salida) NO tienen backend (la búsqueda no acepta sort/filter) → se
 * omiten a propósito en vez de pintar controles que no filtran nada.
 * DEUDA: (backend) el search carpool (POST /carpool/search) debe aceptar sort (precio/salida) y filtro (soloVerificado) para habilitar los controles Ordenar/Verificado/Precio/Salida del .pen. Hoy solo manda geo+fecha+asientos+paging.
 */
export function CarpoolResultsScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const {search} =
    useRoute<RouteProp<RootStackParamList, 'CarpoolResults'>>().params;
  const searchTrips = useDependency(TOKENS.searchCarpoolTripsUseCase);

  const resultsQuery = useInfiniteQuery({
    queryKey: ['carpool', 'search', search],
    queryFn: ({pageParam}) =>
      searchTrips.execute({
        originLat: search.originLat,
        originLon: search.originLon,
        destLat: search.destLat,
        destLon: search.destLon,
        fecha: search.fecha,
        asientos: search.asientos,
        limit: PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    // nextCursor null = no hay más páginas (contrato keyset del bff).
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
  });

  const items = useMemo<CarpoolSearchItem[]>(
    () => resultsQuery.data?.pages.flatMap(page => page.items) ?? [],
    [resultsQuery.data],
  );

  if (resultsQuery.isLoading) {
    return (
      <SafeScreen>
        <ScreenHeader title={t('screens.carpoolResults')} />
        <LoadingState />
      </SafeScreen>
    );
  }

  if (resultsQuery.isError) {
    return (
      <SafeScreen>
        <ScreenHeader title={t('screens.carpoolResults')} />
        <ErrorState
          message={t('carpool.resultsLoadError')}
          onRetry={() => resultsQuery.refetch()}
        />
      </SafeScreen>
    );
  }

  const header = (
    <View style={{gap: theme.spacing.lg}}>
      {/* Header in-body (patrón ScreenHeader del pen): back pill + título display. */}
      <ScreenHeader title={t('screens.carpoolResults')} />
      <View style={{gap: theme.spacing.xs, paddingBottom: theme.spacing.md}}>
        <Text variant="headline">
          {t('carpool.route', {
            origin: search.originLabel,
            destination: search.destLabel,
          })}
        </Text>
        <Text variant="footnote" color="inkSubtle">
          {formatIsoDayShort(search.fecha)} ·{' '}
          {search.asientos === 1
            ? t('carpool.seatsOne')
            : t('carpool.seatsMany', {count: search.asientos})}
        </Text>
        <Text variant="footnote" color="inkSubtle">
          {items.length === 1
            ? t('carpool.resultsCountOne')
            : t('carpool.resultsCountMany', {count: items.length})}
        </Text>
      </View>
    </View>
  );

  if (items.length === 0) {
    return (
      <SafeScreen
        footer={
          <Button
            label={t('carpool.changeSearch')}
            fullWidth
            onPress={() => navigation.goBack()}
          />
        }>
        <ScreenHeader title={t('screens.carpoolResults')} />
        <EmptyState
          title={t('carpool.resultsEmpty')}
          subtitle={t('carpool.resultsEmptySubtitle')}
        />
      </SafeScreen>
    );
  }

  return (
    <SafeScreen padded={false}>
      <FlatList
        data={items}
        keyExtractor={item => item.trip.id}
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.md,
        }}
        ListHeaderComponent={header}
        renderItem={({item, index}) => (
          <EnterView index={index}>
            <CarpoolTripCard
              item={item}
              originLabel={search.originLabel}
              destinationLabel={search.destLabel}
              onPress={() =>
                navigation.navigate('CarpoolTripDetail', {
                  tripId: item.trip.id,
                  search,
                })
              }
            />
          </EnterView>
        )}
        // Paginación keyset: al acercarse al final se pide la página siguiente con el nextCursor.
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (resultsQuery.hasNextPage && !resultsQuery.isFetchingNextPage) {
            void resultsQuery.fetchNextPage();
          }
        }}
        ListFooterComponent={
          resultsQuery.hasNextPage ? (
            <Button
              label={t('carpool.loadMore')}
              variant="ghost"
              fullWidth
              loading={resultsQuery.isFetchingNextPage}
              onPress={() => void resultsQuery.fetchNextPage()}
            />
          ) : null
        }
      />
    </SafeScreen>
  );
}
