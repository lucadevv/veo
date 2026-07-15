import type {CarpoolSearchItem} from '@veo/api-client';
import {
  type RouteProp,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {keepPreviousData, useInfiniteQuery} from '@tanstack/react-query';
import {BottomSheet, Button, SafeScreen, Text, useTheme} from '@veo/ui-kit';
import React, {useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {FlatList, Pressable, StyleSheet, View} from 'react-native';
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
import {
  IconBadgeCheck,
  IconBanknote,
  IconCheck,
  IconClock,
  IconSwapVertical,
} from '../../../trip/presentation/components/icons';
import type {GlyphProps} from '../../../trip/presentation/components/icons';
import {formatPEN} from '../../../../shared/utils/format';
import {formatIsoDayShort} from '../../../../shared/utils/formatDay';
import {CarpoolTripCard} from '../components/CarpoolTripCard';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Tamaño de página de la búsqueda (keyset). */
const PAGE_SIZE = 20;

/** Orden del marketplace (chips del pen): salida más temprana (default del server) o precio más bajo. */
type CarpoolOrden = 'salida' | 'precio';

/** Franja horaria del chip "Salida" (ventana [desde, hasta] inclusiva al minuto, hora Lima). */
interface SalidaFranja {
  key: 'madrugada' | 'manana' | 'tarde' | 'noche';
  desde: string;
  hasta: string;
  /** Key i18n del row del sheet (rango completo). */
  label: string;
  /** Key i18n corta para el chip. */
  chipLabel: string;
}

const FRANJAS: readonly SalidaFranja[] = [
  {
    key: 'madrugada',
    desde: '00:00',
    hasta: '05:59',
    label: 'carpool.departureMadrugada',
    chipLabel: 'carpool.departureMadrugadaChip',
  },
  {
    key: 'manana',
    desde: '06:00',
    hasta: '11:59',
    label: 'carpool.departureManana',
    chipLabel: 'carpool.departureMananaChip',
  },
  {
    key: 'tarde',
    desde: '12:00',
    hasta: '17:59',
    label: 'carpool.departureTarde',
    chipLabel: 'carpool.departureTardeChip',
  },
  {
    key: 'noche',
    desde: '18:00',
    hasta: '23:59',
    label: 'carpool.departureNoche',
    chipLabel: 'carpool.departureNocheChip',
  },
] as const;

/** Presets del precio máximo por asiento (céntimos). El sheet agrega "Sin límite" para limpiar. */
const PRECIO_PRESETS_CENTS: readonly number[] = [1000, 2000, 3000, 5000];

/** Cuál de los sheets de filtro está abierto (uno a la vez, como los chips). */
type FilterSheet = 'orden' | 'precio' | 'salida' | null;

/**
 * Resultados de la búsqueda de carpooling (design/veo.pen P/ProgResults): header con la ruta
 * buscada + FILA DE FILTROS del pen (Ordenar · Verificado · Precio · Salida) + conteo, lista de
 * cards (C/TripCard) y paginación KEYSET con `nextCursor`.
 *
 * Filtros REALES, no decorativos: `orden`/`precioMaxCents`/`salidaDesde|Hasta` viajan al server
 * (el keyset es sort-aware: cambiar filtros re-consulta desde la página 1 — la query key cambia).
 * "Verificado" es CLIENT-SIDE y honesto: todo resultado es de conductor KYC-verificado por
 * construcción (el publish lo exige y el search descarta no-elegibles); el chip oculta las cards
 * DEGRADADAS (identity caída → `driver: null`, no verificable en esta página).
 */
export function CarpoolResultsScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const {search} =
    useRoute<RouteProp<RootStackParamList, 'CarpoolResults'>>().params;
  const searchTrips = useDependency(TOKENS.searchCarpoolTripsUseCase);

  const [orden, setOrden] = useState<CarpoolOrden>('salida');
  const [precioMaxCents, setPrecioMaxCents] = useState<number | null>(null);
  const [franja, setFranja] = useState<SalidaFranja | null>(null);
  const [soloVerificado, setSoloVerificado] = useState(false);
  const [sheet, setSheet] = useState<FilterSheet>(null);

  const resultsQuery = useInfiniteQuery({
    // Los filtros de server van EN la key: cambiarlos re-consulta desde la página 1 (el cursor de
    // un orden no sirve para otro — keyset sort-aware). `soloVerificado` NO va (es client-side).
    queryKey: [
      'carpool',
      'search',
      search,
      {orden, precioMaxCents, franja: franja?.key ?? null},
    ],
    queryFn: ({pageParam}) =>
      searchTrips.execute({
        originLat: search.originLat,
        originLon: search.originLon,
        destLat: search.destLat,
        destLon: search.destLon,
        fecha: search.fecha,
        asientos: search.asientos,
        orden,
        // null → undefined: el HttpClient omite undefined del query string.
        precioMaxCents: precioMaxCents ?? undefined,
        salidaDesde: franja?.desde,
        salidaHasta: franja?.hasta,
        limit: PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    // nextCursor null = no hay más páginas (contrato keyset del bff).
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    // Al cambiar un filtro, la lista previa queda visible mientras llega la nueva página (sin
    // flash a spinner de pantalla entera — lección del flicker de ruta con keys vivas).
    placeholderData: keepPreviousData,
  });

  const items = useMemo<CarpoolSearchItem[]>(
    () => resultsQuery.data?.pages.flatMap(page => page.items) ?? [],
    [resultsQuery.data],
  );

  // "Verificado" client-side: oculta las cards degradadas (driver null = no verificable acá).
  const visibleItems = useMemo<CarpoolSearchItem[]>(
    () => (soloVerificado ? items.filter(item => item.driver !== null) : items),
    [items, soloVerificado],
  );

  const hasServerFilters = precioMaxCents !== null || franja !== null;
  const hasAnyFilter = hasServerFilters || soloVerificado || orden !== 'salida';

  const clearFilters = (): void => {
    setOrden('salida');
    setPrecioMaxCents(null);
    setFranja(null);
    setSoloVerificado(false);
  };

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

  // Fila de FILTROS del pen (chips pill con ícono 14 + label): activo = brandDim + borde/texto
  // brand (estado "Verificado" del pen); inactivo = superficie con borde. El label del chip
  // refleja el filtro APLICADO (p.ej. "S/ 20.00 máx", "Tarde") — el estado que el pen no enumera.
  const filtersRow = (
    <View style={[styles.filtersRow, {gap: theme.spacing.sm}]}>
      <FilterChip
        icon={IconSwapVertical}
        label={orden === 'precio' ? t('carpool.sortPrecio') : t('carpool.filterSort')}
        active={orden !== 'salida'}
        onPress={() => setSheet('orden')}
      />
      <FilterChip
        icon={IconBadgeCheck}
        label={t('carpool.filterVerified')}
        active={soloVerificado}
        onPress={() => setSoloVerificado(current => !current)}
      />
      <FilterChip
        icon={IconBanknote}
        label={
          precioMaxCents !== null
            ? t('carpool.priceMaxChip', {max: formatPEN(precioMaxCents)})
            : t('carpool.filterPrice')
        }
        active={precioMaxCents !== null}
        onPress={() => setSheet('precio')}
      />
      <FilterChip
        icon={IconClock}
        label={franja ? t(franja.chipLabel) : t('carpool.filterDeparture')}
        active={franja !== null}
        onPress={() => setSheet('salida')}
      />
    </View>
  );

  const header = (
    <View style={{gap: theme.spacing.lg}}>
      {/* Header in-body (patrón ScreenHeader del pen): back pill + título display. */}
      <ScreenHeader title={t('screens.carpoolResults')} />
      <View style={{gap: theme.spacing.xs}}>
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
      </View>
      {filtersRow}
      <Text
        variant="footnote"
        color="inkSubtle"
        style={{paddingBottom: theme.spacing.sm}}>
        {visibleItems.length === 1
          ? t('carpool.resultsCountOne')
          : t('carpool.resultsCountMany', {count: visibleItems.length})}
      </Text>
    </View>
  );

  // Vacío HONESTO en dos sabores: sin filtros = el server no tiene viajes para la búsqueda (invita
  // a cambiarla); con CUALQUIER filtro activo (server o client) = tus filtros ocultan resultados
  // (invita a aflojarlos con "Quitar filtros" — los filtros de precio/franja también son server-side,
  // así que `items` vacío no distingue solo; la señal es que HAY filtros aplicados).
  const emptyState =
    !hasAnyFilter ? (
      <EmptyState
        title={t('carpool.resultsEmpty')}
        subtitle={t('carpool.resultsEmptySubtitle')}
      />
    ) : (
      <View style={{gap: theme.spacing.md}}>
        <EmptyState
          title={t('carpool.filteredEmpty')}
          subtitle={t('carpool.filteredEmptySubtitle')}
        />
        <Button
          label={t('carpool.clearFilters')}
          variant="ghost"
          onPress={clearFilters}
        />
      </View>
    );

  return (
    <SafeScreen
      padded={false}
      footer={
        visibleItems.length === 0 && !hasAnyFilter ? (
          <Button
            label={t('carpool.changeSearch')}
            fullWidth
            onPress={() => navigation.goBack()}
          />
        ) : undefined
      }>
      <FlatList
        data={visibleItems}
        keyExtractor={item => item.trip.id}
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.md,
        }}
        ListHeaderComponent={header}
        ListEmptyComponent={emptyState}
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

      {/* Sheet ORDENAR: salida más temprana (default) o precio más bajo. */}
      <BottomSheet
        visible={sheet === 'orden'}
        onClose={() => setSheet(null)}
        title={t('carpool.sortSheetTitle')}>
        <View style={{gap: theme.spacing.xs}}>
          <OptionRow
            label={t('carpool.sortSalida')}
            selected={orden === 'salida'}
            onPress={() => {
              setOrden('salida');
              setSheet(null);
            }}
          />
          <OptionRow
            label={t('carpool.sortPrecio')}
            selected={orden === 'precio'}
            onPress={() => {
              setOrden('precio');
              setSheet(null);
            }}
          />
        </View>
      </BottomSheet>

      {/* Sheet PRECIO MÁXIMO por asiento: presets + sin límite. */}
      <BottomSheet
        visible={sheet === 'precio'}
        onClose={() => setSheet(null)}
        title={t('carpool.priceSheetTitle')}>
        <View style={{gap: theme.spacing.xs}}>
          <OptionRow
            label={t('carpool.priceNoLimit')}
            selected={precioMaxCents === null}
            onPress={() => {
              setPrecioMaxCents(null);
              setSheet(null);
            }}
          />
          {PRECIO_PRESETS_CENTS.map(cents => (
            <OptionRow
              key={cents}
              label={formatPEN(cents)}
              selected={precioMaxCents === cents}
              onPress={() => {
                setPrecioMaxCents(cents);
                setSheet(null);
              }}
            />
          ))}
        </View>
      </BottomSheet>

      {/* Sheet SALIDA: franja horaria del día (hora Lima), o todo el día. */}
      <BottomSheet
        visible={sheet === 'salida'}
        onClose={() => setSheet(null)}
        title={t('carpool.departureSheetTitle')}>
        <View style={{gap: theme.spacing.xs}}>
          <OptionRow
            label={t('carpool.departureAll')}
            selected={franja === null}
            onPress={() => {
              setFranja(null);
              setSheet(null);
            }}
          />
          {FRANJAS.map(option => (
            <OptionRow
              key={option.key}
              label={t(option.label)}
              selected={franja?.key === option.key}
              onPress={() => {
                setFranja(option);
                setSheet(null);
              }}
            />
          ))}
        </View>
      </BottomSheet>
    </SafeScreen>
  );
}

interface FilterChipProps {
  icon: (props: GlyphProps) => React.JSX.Element;
  label: string;
  active: boolean;
  onPress: () => void;
}

/**
 * Chip de filtro del pen (P/ProgResults · Filters): pill con ícono 14 + label 13/500. Activo =
 * relleno brandDim + borde/tinta brand (el estado "Verificado" del pen); inactivo = superficie
 * con borde, label inkMuted.
 */
function FilterChip({
  icon: Glyph,
  label,
  active,
  onPress,
}: FilterChipProps): React.JSX.Element {
  const theme = useTheme();
  const tint = active ? theme.colors.brand : theme.colors.inkSubtle;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{selected: active}}
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={({pressed}) => [
        styles.chip,
        {
          borderRadius: theme.radii.pill,
          borderColor: active ? theme.colors.brand : theme.colors.border,
          backgroundColor: active ? theme.colors.brandDim : theme.colors.surface,
          opacity: pressed ? 0.7 : 1,
        },
      ]}>
      <Glyph color={tint} size={14} />
      <Text
        variant="footnote"
        style={{
          color: active ? theme.colors.brand : theme.colors.inkMuted,
          fontWeight: '500',
        }}>
        {label}
      </Text>
    </Pressable>
  );
}

interface OptionRowProps {
  label: string;
  selected: boolean;
  onPress: () => void;
}

/** Fila de opción de los sheets de filtro: label + check accent cuando está elegida (target 44pt). */
function OptionRow({label, selected, onPress}: OptionRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{selected}}
      onPress={onPress}
      style={({pressed}) => [
        styles.optionRow,
        {
          borderRadius: theme.radii.md,
          backgroundColor: selected ? theme.colors.brandDim : 'transparent',
          opacity: pressed ? 0.7 : 1,
        },
      ]}>
      <Text
        variant="body"
        style={selected ? {color: theme.colors.brand, fontWeight: '600'} : null}>
        {label}
      </Text>
      {selected ? <IconCheck color={theme.colors.brand} size={18} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  filtersRow: {flexDirection: 'row', flexWrap: 'wrap'},
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
  },
  optionRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
