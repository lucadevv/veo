import type {CarpoolSearchItem} from '@veo/api-client';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {keepPreviousData, useInfiniteQuery, useQuery} from '@tanstack/react-query';
import {
  BottomSheet,
  Button,
  Card,
  SafeScreen,
  StatusPill,
  Text,
  useTheme,
} from '@veo/ui-kit';
// Submódulo puro (NO el barrel `@veo/utils`, que arrastra `ids`/`crypto` con `node:crypto` —
// irresoluble en RN/Hermes; mismo patrón que `@veo/utils/money` en el driver).
import {
  regionById,
  regionForPoint,
  REGIONS_PE,
  type RegionPE,
} from '@veo/utils/regions';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {useCurrentLocation} from '../../../../core/location/useCurrentLocation';
import {useAppTabBarHeight} from '../../../../navigation/components/AppTabBar';
import type {RootStackParamList} from '../../../../navigation/types';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {ScreenHeader} from '../../../../shared/presentation/components/ScreenHeader';
import {formatPEN} from '../../../../shared/utils/format';
import {
  IconChevronDown,
  IconClose,
  IconPin,
  IconSearch,
} from '../../../trip/presentation/components/icons';
import {EnterView} from '../../../trip/presentation/components/motion';
import {CarpoolFeedCard} from '../components/CarpoolFeedCard';
import {OptionRow} from '../components/OptionRow';
import {useCarpoolBookingStore} from '../stores/carpoolBookingStore';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Tamaño de página del feed (keyset). */
const PAGE_SIZE = 20;

/**
 * FEED del marketplace de carpooling (design/veo.pen P/CarpoolFeed), RAÍZ del tab "Compartir" —
 * browse-first: se ven TODOS los viajes publicados futuros (grilla 2 columnas), no un buscador
 * vacío. La REGIÓN se detecta de la ubicación actual (catálogo `REGIONS_PE` por bounding box) y se
 * cambia con el chip; sin permiso de ubicación → todas las regiones. La búsqueda por ruta es la
 * pill que empuja `CarpoolSearch` (intención concreta). Reserva viva → banner de re-entrada.
 */
export function CarpoolBrowseScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const tabBarHeight = useAppTabBarHeight();
  const browseTrips = useDependency(TOKENS.browseCarpoolTripsUseCase);
  const getPopularRoutes = useDependency(TOKENS.getCarpoolPopularRoutesUseCase);

  // Re-entrada al seguimiento de una solicitud viva (bookingId persistido en el store).
  const activeBookingId = useCarpoolBookingStore(s => s.activeBookingId);

  // REGIÓN del feed: null = todas. Se auto-detecta UNA vez de la ubicación (si el usuario no eligió
  // manualmente antes); denied/error de ubicación → queda en todas (honesto, sin bloquear el feed).
  const [region, setRegion] = useState<RegionPE | null>(null);
  // Región de DESTINO (solo la setean las rutas populares): chip "→ X" descartable.
  const [destRegion, setDestRegion] = useState<RegionPE | null>(null);
  const [regionSheetOpen, setRegionSheetOpen] = useState(false);
  const userChoseRegion = useRef(false);
  const location = useCurrentLocation();
  useEffect(() => {
    if (userChoseRegion.current || location.status !== 'ready' || !location.point) {
      return;
    }
    const detected = regionForPoint(location.point.lat, location.point.lon);
    if (detected) {
      setRegion(current => current ?? detected);
    }
  }, [location.status, location.point]);

  const feedQuery = useInfiniteQuery({
    queryKey: [
      'carpool',
      'browse',
      {region: region?.id ?? null, destRegion: destRegion?.id ?? null},
    ],
    queryFn: ({pageParam}) =>
      browseTrips.execute({
        region: region?.id,
        destRegion: destRegion?.id,
        limit: PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    // Cambiar de región mantiene la grilla previa visible mientras llega la nueva (sin flash).
    placeholderData: keepPreviousData,
  });

  const items = useMemo<CarpoolSearchItem[]>(
    () => feedQuery.data?.pages.flatMap(page => page.items) ?? [],
    [feedQuery.data],
  );

  // Top de rutas populares (agregado liviano; la sección se OMITE si no hay datos o falla —
  // el feed nunca se bloquea por el agregado).
  const popularQuery = useQuery({
    queryKey: ['carpool', 'popular-routes'],
    queryFn: () => getPopularRoutes.execute(),
    staleTime: 60_000,
  });
  const popularRoutes = popularQuery.data?.routes ?? [];

  const pickRegion = (next: RegionPE | null): void => {
    userChoseRegion.current = true;
    setRegion(next);
    // Elegir región a mano invalida el par de la ruta popular (el destino ya no acompaña).
    setDestRegion(null);
    setRegionSheetOpen(false);
  };

  // Tap en una ruta popular: el feed se filtra al PAR origen→destino (misma región → solo origen).
  const pickPopularRoute = (origenId: string, destinoId: string): void => {
    userChoseRegion.current = true;
    setRegion(regionById(origenId) ?? null);
    setDestRegion(origenId === destinoId ? null : (regionById(destinoId) ?? null));
  };

  const header = (
    <View style={{gap: theme.spacing.md, paddingBottom: theme.spacing.sm}}>
      {/* Header in-body sin back (raíz de tab) — pen P/CarpoolFeed. */}
      <ScreenHeader back={false} title={t('screens.carpoolFeed')} />

      {/* Chip de REGIÓN (pen RegionChip): pin brand + nombre + chevron → sheet selector. Al lado,
          el chip de DESTINO (pen DestChip, solo con ruta popular activa): "→ X" descartable. */}
      <View style={[styles.regionRow, {gap: theme.spacing.sm}]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={region?.nombre ?? t('carpool.feedRegionAll')}
          onPress={() => setRegionSheetOpen(true)}
          style={({pressed}) => [
            styles.regionChip,
            {
              borderRadius: theme.radii.pill,
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              opacity: pressed ? 0.7 : 1,
            },
          ]}>
          <IconPin color={theme.colors.brand} size={14} />
          <Text variant="footnote" style={{fontWeight: '500'}} numberOfLines={1}>
            {region?.nombre ?? t('carpool.feedRegionAll')}
          </Text>
          <IconChevronDown color={theme.colors.inkMuted} size={14} />
        </Pressable>
        {destRegion ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`→ ${destRegion.nombre}`}
            onPress={() => setDestRegion(null)}
            style={({pressed}) => [
              styles.regionChip,
              {
                borderRadius: theme.radii.pill,
                backgroundColor: theme.colors.brandDim,
                borderColor: theme.colors.brand,
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <Text
              variant="footnote"
              numberOfLines={1}
              style={{fontWeight: '500', color: theme.colors.brand}}>
              → {destRegion.nombre}
            </Text>
            <IconClose color={theme.colors.brand} size={12} />
          </Pressable>
        ) : null}
      </View>

      {/* Pill de BÚSQUEDA (pen SearchPill): intención concreta → buscador por ruta. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('carpool.toPlaceholder')}
        onPress={() => navigation.navigate('CarpoolSearch')}
        style={({pressed}) => [
          styles.searchPill,
          {
            borderRadius: theme.radii.pill,
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            opacity: pressed ? 0.7 : 1,
          },
        ]}>
        <IconSearch color={theme.colors.brand} size={18} />
        <Text variant="callout" color="inkSubtle">
          {t('carpool.toPlaceholder')}
        </Text>
      </Pressable>

      {/* Solicitud de asiento EN CURSO: re-entrada al seguimiento. */}
      {activeBookingId !== null ? (
        <Card variant="outlined" padding="lg">
          <View style={styles.bookingRow}>
            <StatusPill label={t('carpool.activeBookingEntry')} tone="warn" dot />
            <Button
              label={t('carpool.viewBooking')}
              variant="ghost"
              size="sm"
              onPress={() =>
                navigation.navigate('CarpoolBookingStatus', {
                  bookingId: activeBookingId,
                })
              }
            />
          </View>
        </Card>
      ) : null}

      {/* Conteo honesto de lo CARGADO (pen Count) — sin repetir la región: el chip de arriba ya
          delimita el ámbito (dos portadoras del mismo dato en el mismo header; audit de copy). */}
      <Text variant="footnote" color="inkSubtle">
        {items.length === 1
          ? t('carpool.feedCountAllOne')
          : t('carpool.feedCountAllMany', {count: items.length})}
      </Text>

      {/* RUTAS POPULARES (pen PopularRoutes): pares región→región con oferta viva. La sección se
          OMITE sin datos (o si el agregado falla): sin filas fantasma ni placeholders. */}
      {popularRoutes.length > 0 ? (
        <View style={{gap: theme.spacing.sm}}>
          <Text variant="subhead" color="inkMuted" style={{fontWeight: '600'}}>
            {t('carpool.feedPopularLabel')}
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{gap: theme.spacing.sm}}>
            {popularRoutes.map(route => (
              <Pressable
                key={`${route.origenRegionId}-${route.destinoRegionId}`}
                accessibilityRole="button"
                accessibilityLabel={`${route.origenNombre} → ${route.destinoNombre}, ${t('carpool.feedFromPrice', {price: formatPEN(route.precioDesdeCents)})}`}
                onPress={() =>
                  pickPopularRoute(route.origenRegionId, route.destinoRegionId)
                }
                style={({pressed}) => [
                  styles.routeCard,
                  {
                    borderRadius: theme.radii.md,
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.border,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}>
                <Text variant="footnote" style={{fontWeight: '600'}} numberOfLines={1}>
                  {route.origenRegionId === route.destinoRegionId
                    ? t('carpool.feedRouteLocal', {region: route.origenNombre})
                    : `${route.origenNombre} → ${route.destinoNombre}`}
                </Text>
                <Text variant="caption" color="inkMuted">
                  {t('carpool.feedFromPrice', {
                    price: formatPEN(route.precioDesdeCents),
                  })}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );

  if (feedQuery.isLoading) {
    return (
      <SafeScreen>
        <ScreenHeader back={false} title={t('screens.carpoolFeed')} />
        <LoadingState />
      </SafeScreen>
    );
  }

  if (feedQuery.isError) {
    return (
      <SafeScreen>
        <ScreenHeader back={false} title={t('screens.carpoolFeed')} />
        <ErrorState
          message={t('carpool.feedLoadError')}
          onRetry={() => feedQuery.refetch()}
        />
      </SafeScreen>
    );
  }

  return (
    <SafeScreen padded={false}>
      <FlatList
        data={items}
        keyExtractor={item => item.trip.id}
        numColumns={2}
        columnWrapperStyle={{gap: theme.spacing.md}}
        contentContainerStyle={{
          padding: theme.spacing.xl,
          paddingBottom: tabBarHeight,
          gap: theme.spacing.md,
        }}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={{gap: theme.spacing.md}}>
            <EmptyState
              title={
                region
                  ? t('carpool.feedEmpty', {region: region.nombre})
                  : t('carpool.feedEmptyAll')
              }
              subtitle={t('carpool.feedEmptySubtitle')}
            />
            {region ? (
              <Button
                label={t('carpool.feedRegionAll')}
                variant="ghost"
                onPress={() => pickRegion(null)}
              />
            ) : null}
          </View>
        }
        refreshControl={
          <RefreshControl
            refreshing={feedQuery.isRefetching && !feedQuery.isFetchingNextPage}
            onRefresh={() => void feedQuery.refetch()}
            tintColor={theme.colors.accent}
            colors={[theme.colors.accent]}
          />
        }
        renderItem={({item, index}) => (
          <EnterView index={index} style={styles.cell}>
            <CarpoolFeedCard
              item={item}
              onPress={() =>
                navigation.navigate('CarpoolTripDetail', {tripId: item.trip.id})
              }
            />
          </EnterView>
        )}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (feedQuery.hasNextPage && !feedQuery.isFetchingNextPage) {
            void feedQuery.fetchNextPage();
          }
        }}
        ListFooterComponent={
          feedQuery.hasNextPage ? (
            <Button
              label={t('carpool.loadMore')}
              variant="ghost"
              fullWidth
              loading={feedQuery.isFetchingNextPage}
              onPress={() => void feedQuery.fetchNextPage()}
            />
          ) : null
        }
      />

      {/* Selector de REGIÓN: catálogo compartido + "todas". */}
      <BottomSheet
        visible={regionSheetOpen}
        onClose={() => setRegionSheetOpen(false)}
        title={t('carpool.feedRegionSheetTitle')}>
        <View style={{gap: theme.spacing.xs}}>
          <OptionRow
            label={t('carpool.feedRegionAll')}
            selected={region === null}
            onPress={() => pickRegion(null)}
          />
          {REGIONS_PE.map(option => (
            <OptionRow
              key={option.id}
              label={option.nombre}
              selected={region?.id === option.id}
              onPress={() => pickRegion(option)}
            />
          ))}
        </View>
      </BottomSheet>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  regionRow: {flexDirection: 'row'},
  regionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    maxWidth: '100%',
  },
  searchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderWidth: 1,
  },
  bookingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  // Celda de la grilla: mitad del ancho (el gap lo pone el columnWrapper).
  cell: {flex: 1},
  routeCard: {gap: 2, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1},
});
