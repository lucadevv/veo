import type {MapPoint, TripResource} from '@veo/api-client';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Banner, BottomSheet, Button, Text, useTheme} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {FlatList, Pressable, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {formatPEN, formatTimeOfDay} from '../../../../shared/utils/format';
import {formatDayMonthShort} from '../../../../shared/utils/formatDay';
import {IconCalendar} from './icons';
import {EnterView} from './motion';

/** Query key canónica de los programados (`GET /trips/scheduled`). */
const SCHEDULED_QUERY_KEY = ['trips', 'scheduled'] as const;

export interface UpcomingTripsTabProps {
  /** CTA del vacío honesto: arranca el flujo REAL de programación (inline, desde el Home). */
  onSchedule: () => void;
}

/**
 * Tab "Próximos" de Tus viajes (design/veo.pen UcekU): los viajes PROGRAMADOS reales, cada uno como
 * card con fecha (calendario) + StatusPill + ruta + tarifa estimada + CANCELAR con confirmación
 * (DELETE /trips/:id/schedule) — es la ÚNICA lista de programados (la pantalla `ScheduledTrips`
 * aparte se eliminó en la consolidación). Estados honestos: carga, error con reintento, y vacío que
 * INVITA a programar (no se auto-cambia de tab con magia).
 *
 * GAPS vs pen (datos que el backend no tiene en SCHEDULED): el pen pinta conductor + vehículo
 * ("Carlos M. · Toyota Corolla") y estados "Confirmado"/"Esperando aprobación"; el contrato real solo
 * tiene el estado SCHEDULED y sin conductor asignado todavía → se omiten (no se inventan).
 */
export function UpcomingTripsTab({
  onSchedule,
}: UpcomingTripsTabProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const listScheduled = useDependency(TOKENS.listScheduledTripsUseCase);
  const cancelScheduled = useDependency(TOKENS.cancelScheduledTripUseCase);
  const queryClient = useQueryClient();

  // Viaje pendiente de confirmación de cancelación (null = sheet cerrado).
  const [pendingCancel, setPendingCancel] = useState<TripResource | null>(null);

  const scheduledQuery = useQuery({
    queryKey: SCHEDULED_QUERY_KEY,
    queryFn: () => listScheduled.execute(),
  });

  const cancelMutation = useMutation({
    mutationFn: (tripId: string) => cancelScheduled.execute(tripId),
    onSuccess: () => {
      setPendingCancel(null);
      void queryClient.invalidateQueries({queryKey: SCHEDULED_QUERY_KEY});
    },
  });

  if (scheduledQuery.isLoading) {
    return (
      <View style={{padding: theme.spacing.xl}}>
        <LoadingState lines={4} />
      </View>
    );
  }

  if (scheduledQuery.isError) {
    return (
      <View style={{padding: theme.spacing.xl}}>
        <ErrorState
          message={t('scheduled.loadError')}
          onRetry={() => scheduledQuery.refetch()}
        />
      </View>
    );
  }

  const trips = scheduledQuery.data ?? [];

  if (trips.length === 0) {
    // Vacío HONESTO per pen: invita a programar; si hay historial, vive en su propio tab.
    return (
      <View
        style={[
          styles.empty,
          {padding: theme.spacing['3xl'], gap: theme.spacing.lg},
        ]}>
        <View style={{gap: theme.spacing.xs, alignItems: 'center'}}>
          <Text variant="title3" align="center">
            {t('history.upcomingEmptyTitle')}
          </Text>
          <Text
            variant="callout"
            color="inkMuted"
            align="center"
            style={styles.emptyBody}>
            {t('history.upcomingEmptyBody')}
          </Text>
        </View>
        {/* El Button sin `fullWidth` trae `alignSelf:'flex-start'` (gana sobre el alignItems:center del
            contenedor) → quedaba a la izquierda. `alignSelf:'center'` lo centra bajo el texto centrado. */}
        <Button
          label={t('history.upcomingCta')}
          variant="accent"
          onPress={onSchedule}
          style={styles.emptyCta}
        />
      </View>
    );
  }

  return (
    <>
      <FlatList
        data={trips}
        keyExtractor={item => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.md,
          paddingBottom: theme.spacing.xl,
          gap: theme.spacing.md,
        }}
        renderItem={({item, index}) => (
          <EnterView index={index}>
            <UpcomingTripCard
              trip={item}
              onCancel={() => setPendingCancel(item)}
            />
          </EnterView>
        )}
        // Nota honesta al pie (sin promesa temporal: el backend no tiene ventana de 2 h ni recordatorio).
        ListFooterComponent={
          <View
            style={[
              styles.footNote,
              {gap: theme.spacing.xs, paddingVertical: theme.spacing.xs},
            ]}>
            <IconCalendar color={theme.colors.inkSubtle} size={14} />
            <Text variant="caption" color="inkSubtle">
              {t('scheduled.footNote')}
            </Text>
          </View>
        }
      />

      {/* Confirmación de cancelación (portada de la pantalla `ScheduledTrips` eliminada). */}
      <BottomSheet
        visible={pendingCancel !== null}
        onClose={() => setPendingCancel(null)}
        title={t('scheduled.cancelTitle')}
        footer={
          <View style={{gap: theme.spacing.sm}}>
            <Button
              label={t('scheduled.cancelConfirm')}
              variant="danger"
              fullWidth
              loading={cancelMutation.isPending}
              onPress={() => {
                if (pendingCancel) {
                  cancelMutation.mutate(pendingCancel.id);
                }
              }}
            />
            <Button
              label={t('scheduled.keep')}
              variant="ghost"
              fullWidth
              onPress={() => setPendingCancel(null)}
            />
          </View>
        }>
        <View style={{gap: theme.spacing.md}}>
          <Text variant="callout" color="inkMuted">
            {t('scheduled.cancelBody')}
          </Text>
          {cancelMutation.isError ? (
            <Banner tone="danger" title={t('scheduled.cancelError')} />
          ) : null}
        </View>
      </BottomSheet>
    </>
  );
}

interface UpcomingTripCardProps {
  trip: TripResource;
  /** Pide cancelar este programado (abre la confirmación en el contenedor). */
  onCancel: () => void;
}

/**
 * Card de un viaje próximo — MISMO lenguaje EDITORIAL que la fila del Historial (`TripHistoryRow`): una
 * sola card en ambos tabs de "Tus viajes". Punto de estado (brand) + micro-label "PROGRAMADO" neutro ·
 * "lomo" temporal (día `scheduledFor` + hora) · TRAYECTO como riel origen→destino con los lugares REALES
 * geocodificados (los programados sí los tienen) · footer con hairline + "estimada" + monto `title3`.
 * SUPERFICIE surface con elevación, sin borde duro (editorial, no plantilla).
 */
function UpcomingTripCard({
  trip,
  onCancel,
}: UpcomingTripCardProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const originLabel = usePointLabel(trip.origin);
  const destinationLabel = usePointLabel(trip.destination);
  // "15 jul" (no "15/07/2026"): el lomo es angosto (84) y la fecha completa truncaba con "…".
  const day = trip.scheduledFor ? formatDayMonthShort(trip.scheduledFor) : '—';
  const time = trip.scheduledFor ? formatTimeOfDay(trip.scheduledFor) : '';

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.lg,
          ...theme.elevation.level1,
        },
      ]}>
      {/* CABECERA FINA: estado (punto brand + micro-label NEUTRO "PROGRAMADO") + cancelar discreto. */}
      <View style={styles.topLine}>
        <View style={styles.statusGroup}>
          <View style={[styles.dot, {backgroundColor: theme.colors.brand}]} />
          <Text
            variant="micro"
            style={[styles.statusLabel, {color: theme.colors.inkSubtle}]}
            numberOfLines={1}>
            {t('tripStatus.SCHEDULED')}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('scheduled.cancel')}
          hitSlop={10}
          onPress={onCancel}>
          <Text variant="footnote" style={{color: theme.colors.danger}}>
            {t('scheduled.cancel')}
          </Text>
        </Pressable>
      </View>

      {/* CUERPO: "lomo" temporal (día + hora) + TRAYECTO como riel origen→destino (lugares reales). */}
      <View style={styles.body}>
        <View style={styles.dateSpine}>
          <Text variant="title3" numberOfLines={1}>
            {day}
          </Text>
          <Text variant="footnote" color="inkSubtle" tabular>
            {time}
          </Text>
        </View>

        <View style={styles.journey}>
          <View
            style={styles.rail}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants">
            <View
              style={[styles.railDotOrigin, {borderColor: theme.colors.brand}]}
            />
            <View
              style={[styles.railLine, {backgroundColor: theme.colors.border}]}
            />
            <View
              style={[styles.railDotDest, {backgroundColor: theme.colors.ink}]}
            />
          </View>
          <View style={styles.journeyLabels}>
            <Text variant="subhead" color="inkMuted" numberOfLines={1}>
              {originLabel}
            </Text>
            <Text variant="bodyStrong" numberOfLines={1}>
              {destinationLabel}
            </Text>
          </View>
        </View>
      </View>

      {/* PIE: hairline + aclaración "estimada" (la tarifa se confirma al activar) + monto (payoff). */}
      <View
        style={[
          styles.footer,
          {
            borderTopColor: theme.colors.border,
            paddingTop: theme.spacing.md,
            marginTop: theme.spacing.md,
          },
        ]}>
        <Text variant="caption" color="inkSubtle">
          {t('scheduled.fare')}
        </Text>
        <Text variant="title3" tabular>
          {formatPEN(trip.fareCents)}
        </Text>
      </View>
    </View>
  );
}

/**
 * Etiqueta legible de un punto vía geocoding inverso real (query key `['maps','reverse',…]`
 * compartida app-wide → caché común con el resto de las pantallas que geocodifican).
 */
function usePointLabel(point: {lat: number; lon: number}): string {
  const {t} = useTranslation();
  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const mapPoint: MapPoint = {lat: point.lat, lng: point.lon};
  const labelQuery = useQuery({
    queryKey: ['maps', 'reverse', mapPoint.lat, mapPoint.lng],
    queryFn: () => reverseGeocode.execute(mapPoint),
    staleTime: 5 * 60_000,
  });
  return labelQuery.data?.title ?? t('home.selectedOnMap');
}

const RAIL_DOT = 10;

const styles = StyleSheet.create({
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  emptyBody: {maxWidth: 280},
  emptyCta: {alignSelf: 'center'},
  // Card editorial (espejo de TripHistoryRow): superficie con elevación, sin borde duro.
  card: {minHeight: 44, overflow: 'hidden'},
  topLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusGroup: {flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1},
  dot: {width: 8, height: 8, borderRadius: 4},
  statusLabel: {textTransform: 'uppercase', flexShrink: 1},
  body: {flexDirection: 'row', alignItems: 'flex-start', gap: 16, marginTop: 14},
  dateSpine: {width: 84, gap: 2},
  journey: {flex: 1, flexDirection: 'row', gap: 12},
  rail: {width: RAIL_DOT, alignItems: 'center', paddingTop: 5},
  railDotOrigin: {
    width: RAIL_DOT,
    height: RAIL_DOT,
    borderRadius: RAIL_DOT / 2,
    borderWidth: 2.5,
  },
  railLine: {width: 2, flex: 1, marginVertical: 3, minHeight: 16},
  railDotDest: {width: RAIL_DOT, height: RAIL_DOT, borderRadius: 2},
  journeyLabels: {flex: 1, justifyContent: 'space-between', gap: 12},
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  footNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
