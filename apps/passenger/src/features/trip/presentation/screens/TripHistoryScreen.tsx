import type { TripHistoryItem } from '@veo/api-client';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SafeScreen, Text, useTheme } from '@veo/ui-kit';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, RefreshControl, SectionList, StyleSheet, View } from 'react-native';
import { ErrorState } from '../../../../shared/presentation/components/ScreenStates';
import type { RootStackParamList } from '../../../../navigation/types';
import { groupTripsByTime, type HistorySection } from '../../domain/historyGrouping';
import { isLiveTrip } from '../../domain/tripStatusClass';
import { useActiveTripStore } from '../stores/activeTripStore';
import { useTripHistory } from '../hooks/useTripHistory';
import { EnterView } from '../components/motion';
import { TripDetailSheet } from '../components/TripDetailSheet';
import { TripHistoryRowContainer } from '../components/TripHistoryRowContainer';
import { TripHistoryEmpty, TripHistorySkeleton } from '../components/TripHistoryStates';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * Historial de viajes. Lee del SERVIDOR (`GET /trips/history`, paginado por cursor) con sus ESTADOS
 * REALES (COMPLETED / CANCELLED / EXPIRED…), NO de la foto local de MMKV (que mostraba todo
 * "Solicitado" porque nunca se actualizaba — el bug que esto cierra). El snapshot local sobrevive solo
 * para recents + la polyline del detalle (ver tripHistoryRepository.ts), pero el historial es del server.
 *
 * CUATRO estados HONESTOS — no confundir vacío con cargando, ni mostrar estados viejos como verdad:
 *  - loading → SKELETON con la silueta de la fila (no spinner pelado),
 *  - error   → estado con reintentar (sin red NO degradamos a la foto vieja: sería mentir),
 *  - vacío   → empty state con alma (emblema de ruta + copy VEO + CTA "Pide tu primer VEO"),
 *  - datos   → SectionList agrupada por tiempo (Hoy / Esta semana / Anteriores) + paginación infinita
 *              (footer "cargando más" al llegar al fondo) + pull-to-refresh.
 *
 * Apertura por ESTADO REAL (cierra el bug de la legacy):
 *  - TERMINAL  → abre el DETALLE en un `DraggableSheet` SOBRE la lista (no navega a otra pantalla: el
 *               dueño eliminó `TripDetailScreen`). La lista queda debajo; el sheet sube arrastrable y
 *               cierra con gesto/backdrop. Estado fresco del server (item del historial + `GET /trips/:id`).
 *  - VIVO      → adopta el id en `activeTripStore` y vuelve al Home → el sheet unificado rehidrata el
 *               viaje activo. NUNCA navega a `TripActive` (legacy).
 */
export function TripHistoryScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const setActiveTripId = useActiveTripStore((s) => s.setActiveTripId);

  // Viaje cuyo detalle se muestra en el sheet (null = sheet cerrado). Guardamos el ITEM completo, no solo
  // el id: el detalle pinta lo esencial al INSTANTE desde acá (sin flash de carga) y enriquece por red.
  const [selectedTrip, setSelectedTrip] = useState<TripHistoryItem | null>(null);

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

  const sections = useMemo<HistorySection<TripHistoryItem>[]>(
    () => groupTripsByTime(items),
    [items],
  );

  const goHome = useCallback(() => {
    navigation.navigate('Main', { screen: 'Home' });
  }, [navigation]);

  const openTrip = useCallback(
    (trip: TripHistoryItem) => {
      if (isLiveTrip(trip.status)) {
        // VIVO (raro en historial, pero posible): re-entra por el flujo unificado, NO por la legacy.
        // Adoptar el id hace que el sheet del Home rehidrate el viaje activo (mismo camino que el
        // banner cross-tab y `useHydrateActiveTrip`).
        setActiveTripId(trip.id);
        navigation.navigate('Main', { screen: 'Home' });
        return;
      }
      // TERMINAL: abre el detalle en el sheet SOBRE la lista (no navega). El item completo es la semilla
      // del sheet → lo esencial (ruta, fecha, tarifa, estado) se ve al instante; el resto enriquece por red.
      setSelectedTrip(trip);
    },
    [navigation, setActiveTripId],
  );

  const closeTripDetail = useCallback(() => setSelectedTrip(null), []);

  if (isLoading) {
    return (
      <SafeScreen padded={false}>
        <TripHistorySkeleton />
      </SafeScreen>
    );
  }

  if (isError) {
    return (
      <SafeScreen>
        <ErrorState onRetry={refetch} />
      </SafeScreen>
    );
  }

  if (items.length === 0) {
    return (
      <SafeScreen>
        <TripHistoryEmpty onRequestRide={goHome} />
      </SafeScreen>
    );
  }

  return (
    <SafeScreen padded={false}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ padding: theme.spacing.xl, paddingTop: theme.spacing.md }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={theme.colors.accent}
            colors={[theme.colors.accent]}
          />
        }
        // Paginación infinita por cursor: al acercarse al fondo, pide la siguiente página. El hook ya
        // gatea (no dispara si no hay más o si ya hay una en vuelo), así un onEndReached agresivo es seguro.
        onEndReachedThreshold={0.4}
        onEndReached={fetchNextPage}
        renderSectionHeader={({ section }) => (
          <Text
            variant="label"
            color="inkSubtle"
            style={[
              styles.sectionHeader,
              { marginTop: theme.spacing.lg, marginBottom: theme.spacing.sm },
            ]}
          >
            {t(`history.section.${(section as HistorySection<TripHistoryItem>).id}`)}
          </Text>
        )}
        renderItem={({ item, index, section }) => (
          <EnterView
            index={(section as HistorySection<TripHistoryItem>).id === 'today' ? index : 0}
            style={{ marginBottom: theme.spacing.md }}
          >
            <TripHistoryRowContainer trip={item} onPress={() => openTrip(item)} />
          </EnterView>
        )}
        ListFooterComponent={
          <View style={{ paddingVertical: theme.spacing.lg, gap: theme.spacing.sm }}>
            {isFetchingNextPage ? (
              // "Cargando más" al paginar: indicador + copy, no un salto en seco.
              <View style={styles.footerLoading}>
                <ActivityIndicator color={theme.colors.accent} />
                <Text variant="footnote" color="inkSubtle">
                  {t('history.loadingMore')}
                </Text>
              </View>
            ) : !hasNextPage ? (
              // Fin de la lista: nota honesta de que el historial vive en el servidor (sincronizado).
              <Text variant="footnote" color="inkSubtle" align="center">
                {t('history.serverNote')}
              </Text>
            ) : null}
          </View>
        }
      />

      {/* DETALLE EN SHEET (sobre la lista). El host se monta solo con un viaje seleccionado y trae su
          propio backdrop + gesto de cierre; al cerrar, `selectedTrip` vuelve a null y se desmonta. */}
      <TripDetailSheet trip={selectedTrip} onClose={closeTripDetail} />
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  sectionHeader: { textTransform: 'uppercase' },
  footerLoading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
});
