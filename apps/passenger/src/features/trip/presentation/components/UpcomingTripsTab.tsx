import type {MapPoint, TripResource} from '@veo/api-client';
import {useQuery} from '@tanstack/react-query';
import {Button, Card, StatusPill, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {FlatList, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {formatDateTime, formatPEN} from '../../../../shared/utils/format';
import {EnterView} from './motion';
import {IconCalendar} from './icons';

/**
 * MISMA query key que `ScheduledTripsScreen`: ambos tabs beben del MISMO dato real
 * (`GET /trips/scheduled`) y comparten caché — cancelar allá refresca acá sin listas paralelas.
 */
const SCHEDULED_QUERY_KEY = ['trips', 'scheduled'] as const;

export interface UpcomingTripsTabProps {
  /** CTA del vacío honesto: entra al flujo REAL de programación (`ScheduleNew`). */
  onSchedule: () => void;
}

/**
 * Tab "Próximos" de Tus viajes (design/veo.pen UcekU): los viajes PROGRAMADOS reales, cada uno como
 * card con fecha (calendario) + StatusPill + ruta + tarifa estimada. Estados honestos: carga, error
 * con reintento, y vacío que INVITA a programar (no se auto-cambia de tab con magia).
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

  const scheduledQuery = useQuery({
    queryKey: SCHEDULED_QUERY_KEY,
    queryFn: () => listScheduled.execute(),
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
        <Button
          label={t('history.upcomingCta')}
          variant="accent"
          onPress={onSchedule}
        />
      </View>
    );
  }

  return (
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
          <UpcomingTripCard trip={item} />
        </EnterView>
      )}
    />
  );
}

interface UpcomingTripCardProps {
  trip: TripResource;
}

/**
 * Card de un viaje próximo (pen UcekU "Upcoming"): fila superior con fecha/hora (icono calendario) y
 * StatusPill del estado REAL (SCHEDULED → "Programado"), divider, y fila ruta + tarifa estimada.
 */
function UpcomingTripCard({trip}: UpcomingTripCardProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const originLabel = usePointLabel(trip.origin);
  const destinationLabel = usePointLabel(trip.destination);

  return (
    <Card variant="outlined" padding="lg">
      <View style={{gap: theme.spacing.md}}>
        <View style={styles.topRow}>
          {trip.scheduledFor ? (
            <View style={[styles.dateWrap, {gap: theme.spacing.sm}]}>
              <IconCalendar color={theme.colors.inkSubtle} size={15} />
              <Text variant="subhead" color="inkMuted" tabular>
                {formatDateTime(trip.scheduledFor)}
              </Text>
            </View>
          ) : (
            // Sin fecha (no debería pasar en SCHEDULED, pero el campo es opcional): sin inventar.
            <View />
          )}
          <StatusPill label={t('tripStatus.SCHEDULED')} tone="brand" dot />
        </View>

        <View style={[styles.divider, {backgroundColor: theme.colors.border}]} />

        <View style={[styles.midRow, {gap: theme.spacing.md}]}>
          <View style={styles.routeCol}>
            <Text variant="bodyStrong" numberOfLines={1}>
              {t('scheduled.route', {
                origin: originLabel,
                destination: destinationLabel,
              })}
            </Text>
            {/* El pen pinta conductor/vehículo acá; SCHEDULED aún no tiene conductor → la línea
                honesta es la aclaración de que la tarifa es estimada. */}
            <Text variant="footnote" color="inkSubtle">
              {t('scheduled.fare')}
            </Text>
          </View>
          <Text variant="headline" tabular>
            {formatPEN(trip.fareCents)}
          </Text>
        </View>
      </View>
    </Card>
  );
}

/**
 * Etiqueta legible de un punto vía geocoding inverso real (misma query key que `ScheduledTripsScreen`
 * → caché compartida; el hook se duplica a propósito porque aquel vive privado en su pantalla).
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

const styles = StyleSheet.create({
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  emptyBody: {maxWidth: 280},
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dateWrap: {flexDirection: 'row', alignItems: 'center'},
  divider: {height: StyleSheet.hairlineWidth, alignSelf: 'stretch'},
  midRow: {flexDirection: 'row', alignItems: 'center'},
  routeCol: {flex: 1, gap: 3},
});
