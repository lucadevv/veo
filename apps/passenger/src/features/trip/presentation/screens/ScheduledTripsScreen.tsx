import type {MapPoint, TripResource} from '@veo/api-client';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Banner,
  BottomSheet,
  Button,
  Card,
  SafeScreen,
  StatusPill,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React, {useState} from 'react';
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
import {useCarpoolBookingStore} from '../../../carpool/presentation/stores/carpoolBookingStore';
import {formatDateTime, formatPEN} from '../../../../shared/utils/format';
import type {RootStackParamList} from '../../../../navigation/types';
import {EnterView} from '../components/motion';
import {IconCalendar, IconPlus} from '../components/icons';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const SCHEDULED_QUERY_KEY = ['trips', 'scheduled'] as const;

/**
 * "Mis viajes programados": lista los viajes en estado SCHEDULED (GET /trips/scheduled) con su
 * fecha/hora, trayecto origen→destino, tarifa estimada y un botón Cancelar
 * (DELETE /trips/:id/schedule) con confirmación. Estado vacío elegante. Las etiquetas de los puntos
 * se resuelven con geocoding inverso real (sin inventar direcciones).
 */
export function ScheduledTripsScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const listScheduled = useDependency(TOKENS.listScheduledTripsUseCase);
  const cancelScheduled = useDependency(TOKENS.cancelScheduledTripUseCase);
  const queryClient = useQueryClient();

  const [pendingCancel, setPendingCancel] = useState<TripResource | null>(null);

  // Carpooling (ADR-014): entrada al marketplace de asientos + re-entrada al seguimiento de una
  // solicitud viva (el poll de la pantalla de estado se corta al salir; el bookingId persiste).
  const activeBookingId = useCarpoolBookingStore(s => s.activeBookingId);
  const carpoolEntry = (
    <Card variant="outlined" padding="lg">
      <View style={{gap: theme.spacing.md}}>
        <View style={{gap: theme.spacing.xs}}>
          <Text variant="bodyStrong">{t('carpool.entryTitle')}</Text>
          <Text variant="footnote" color="inkMuted">
            {t('carpool.entryBody')}
          </Text>
        </View>
        {activeBookingId !== null ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.spacing.sm,
            }}>
            <StatusPill
              label={t('carpool.activeBookingEntry')}
              tone="warn"
              dot
            />
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
        ) : null}
        <Button
          label={t('carpool.entryCta')}
          variant="secondary"
          size="sm"
          onPress={() => navigation.navigate('CarpoolSearch')}
        />
      </View>
    </Card>
  );

  // Botón "+" para programar un viaje nuevo (entra al flujo real de programación).
  const scheduleButton = (
    <Button
      label={t('scheduleNew.entry')}
      variant="accent"
      fullWidth
      leftIcon={<IconPlus color={theme.colors.onAccent} size={20} />}
      onPress={() => navigation.navigate('ScheduleNew')}
    />
  );

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
      <SafeScreen>
        <ScreenHeader title={t('screens.scheduledTrips')} />
        <LoadingState />
      </SafeScreen>
    );
  }

  if (scheduledQuery.isError) {
    return (
      <SafeScreen>
        <ScreenHeader title={t('screens.scheduledTrips')} />
        <ErrorState
          message={t('scheduled.loadError')}
          onRetry={() => scheduledQuery.refetch()}
        />
      </SafeScreen>
    );
  }

  const trips = scheduledQuery.data ?? [];

  // Nota al pie del listado (design/veo.pen ZVdlh Note: icono calendar-days + texto sutil). El pen
  // promete "cancelar hasta 2 h antes sin costo", pero la regla REAL del backend (trip-service
  // scheduled-trip.service: penaltyCents 0 mientras siga SCHEDULED; el cron lo activa ~10 min antes)
  // no tiene ventana de 2 h → copy honesto sin promesa temporal. No hay recordatorio previo real
  // ("te avisamos 30 min antes" sería mentira: no existe ese scheduler).
  const footNote = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.xs,
        paddingVertical: theme.spacing.xs,
      }}>
      <IconCalendar color={theme.colors.inkSubtle} size={14} />
      <Text variant="caption" color="inkSubtle">
        {t('scheduled.footNote')}
      </Text>
    </View>
  );

  if (trips.length === 0) {
    return (
      <SafeScreen footer={scheduleButton}>
        <ScreenHeader title={t('screens.scheduledTrips')} />
        <View style={{paddingTop: theme.spacing.xl}}>{carpoolEntry}</View>
        <EmptyState
          title={t('scheduled.empty')}
          subtitle={t('scheduled.emptySubtitle')}
        />
      </SafeScreen>
    );
  }

  return (
    <SafeScreen padded={false} footer={scheduleButton}>
      <FlatList
        data={trips}
        keyExtractor={item => item.id}
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.md,
        }}
        ListHeaderComponent={
          <View style={{gap: theme.spacing.md}}>
            {/* Header in-body (patrón ScreenHeader del pen): back pill + título display. */}
            <ScreenHeader title={t('screens.scheduledTrips')} />
            {carpoolEntry}
          </View>
        }
        ListFooterComponent={footNote}
        renderItem={({item, index}) => (
          <EnterView index={index}>
            <ScheduledTripCard
              trip={item}
              onCancel={() => setPendingCancel(item)}
            />
          </EnterView>
        )}
      />

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
    </SafeScreen>
  );
}

interface ScheduledTripCardProps {
  trip: TripResource;
  onCancel: () => void;
}

/** Tarjeta de un viaje programado: hora, trayecto (con etiquetas reales), tarifa estimada y cancelar. */
function ScheduledTripCard({
  trip,
  onCancel,
}: ScheduledTripCardProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const originLabel = usePlaceLabel(trip.origin);
  const destinationLabel = usePlaceLabel(trip.destination);
  const stopCount = trip.waypoints.length;

  return (
    <Card variant="outlined" padding="lg">
      <View style={{gap: theme.spacing.md}}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
          <StatusPill
            label={
              trip.scheduledFor
                ? t('schedule.scheduledFor', {
                    when: formatDateTime(trip.scheduledFor),
                  })
                : t('tripStatus.SCHEDULED')
            }
            tone="brand"
            dot
          />
          <Text variant="bodyStrong" tabular>
            {formatPEN(trip.fareCents)}
          </Text>
        </View>

        <View style={{gap: theme.spacing.xs}}>
          <Text variant="footnote" color="inkSubtle">
            {t('scheduled.route', {
              origin: originLabel,
              destination: destinationLabel,
            })}
          </Text>
          {stopCount > 0 ? (
            <Text variant="footnote" color="inkSubtle">
              {stopCount === 1
                ? t('scheduled.stopsOne')
                : t('scheduled.stopsMany', {count: stopCount})}
            </Text>
          ) : null}
          <Text variant="footnote" color="inkSubtle">
            {t('scheduled.fare')}
          </Text>
        </View>

        <Button
          label={t('scheduled.cancel')}
          variant="secondary"
          size="sm"
          onPress={onCancel}
        />
      </View>
    </Card>
  );
}

/** Etiqueta legible de un punto del viaje vía geocoding inverso real (cae al "punto en el mapa" mientras carga). */
function usePlaceLabel(point: {lat: number; lon: number}): string {
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
