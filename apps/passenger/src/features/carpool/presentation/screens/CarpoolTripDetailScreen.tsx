import type {CarpoolTripDetail} from '@veo/api-client';
import {
  type RouteProp,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useQuery} from '@tanstack/react-query';
import {Avatar, Button, Card, SafeScreen, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {ScreenStateFallback} from '../../../../shared/presentation/components/ScreenStates';
import {formatPEN, formatTimeOfDay} from '../../../../shared/utils/format';
import type {RootStackParamList} from '../../../../navigation/types';
import {
  IconCar,
  IconStarFilled,
} from '../../../trip/presentation/components/icons';
import {formatDayTimeShort} from '../formatDay';
import {usePlaceLabel} from '../usePlaceLabel';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Query key del detalle (compartida con la revisión de reserva: misma cache, cero refetch doble). */
export function carpoolTripDetailKey(tripId: string): readonly unknown[] {
  return ['carpool', 'trip', tripId] as const;
}

/**
 * Detalle de un viaje publicado (design/veo.pen P/TripDetail): itinerario origen→paradas→destino
 * con reverse geocode REAL, precio por asiento, conductor público (nombre+rating, SIN teléfono),
 * vehículo (marca modelo · color · placa), reglas del viaje (texto libre REAL del conductor) y
 * asientos, con la barra inferior precio+CTA. Degradación honesta: driver/vehicle/reglas null →
 * esa sección NO se pinta (identity/fleet pueden no responder; el detalle igual sirve).
 * Diferencia honesta con el pen: las horas de las paradas/llegada NO existen en el contrato (solo
 * `fechaHoraSalida`), así que solo el origen lleva hora.
 */
export function CarpoolTripDetailScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const {tripId, search} =
    useRoute<RouteProp<RootStackParamList, 'CarpoolTripDetail'>>().params;
  const getDetail = useDependency(TOKENS.getCarpoolTripDetailUseCase);

  const detailQuery = useQuery({
    queryKey: carpoolTripDetailKey(tripId),
    queryFn: () => getDetail.execute(tripId),
  });

  if (detailQuery.isLoading) {
    return <ScreenStateFallback loading />;
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <ScreenStateFallback
        errorMessage={t('carpool.detailLoadError')}
        onRetry={() => detailQuery.refetch()}
      />
    );
  }

  const {trip, driver, vehicle}: CarpoolTripDetail = detailQuery.data;
  const hasSeats = trip.asientosDisponibles > 0;
  // Paradas en el orden REAL de la ruta (el wire no garantiza el orden del array).
  const stopovers = [...trip.stopovers].sort((a, b) => a.orden - b.orden);

  return (
    <SafeScreen
      padded={false}
      footer={
        <View style={[styles.bottomBar, {gap: theme.spacing.md}]}>
          <View>
            <Text variant="headline" tabular>
              {formatPEN(trip.precioBase)}
            </Text>
            <Text variant="caption" color="inkSubtle">
              {t('carpool.perSeatLong')}
            </Text>
          </View>
          <View style={styles.flex}>
            <Button
              label={hasSeats ? t('carpool.reserveCta') : t('carpool.noSeats')}
              fullWidth
              disabled={!hasSeats}
              onPress={() =>
                navigation.navigate('CarpoolBookingReview', {tripId, search})
              }
            />
          </View>
        </View>
      }>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}>
        {/* Itinerario: timeline con reverse geocode real; hora solo en la salida (ver docblock). */}
        <View style={{gap: theme.spacing.md}}>
          <View style={styles.itinHeader}>
            <Text variant="headline">{t('carpool.itinerary')}</Text>
            <Text variant="footnote" color="inkMuted">
              {formatDayTimeShort(trip.fechaHoraSalida)}
            </Text>
          </View>

          <TimelineStop
            kind="origin"
            lat={trip.origenLat}
            lon={trip.origenLon}
            time={formatTimeOfDay(trip.fechaHoraSalida)}
            subtitle={t('carpool.departurePoint')}
            hasNext={true}
          />
          {stopovers.map(stop => (
            <TimelineStop
              key={stop.orden}
              kind="stopover"
              lat={stop.lat}
              lon={stop.lon}
              subtitle={t('carpool.stopoverPoint')}
              // Siempre hay siguiente: después de una parada viene otra parada o el destino.
              hasNext
            />
          ))}
          <TimelineStop
            kind="destination"
            lat={trip.destinoLat}
            lon={trip.destinoLon}
            subtitle={t('carpool.arrivalPoint')}
            hasNext={false}
          />
        </View>

        {/* Precio por asiento (bloque grande del pen). */}
        <View style={[styles.priceRow, {gap: theme.spacing.sm}]}>
          <Text variant="title2" tabular>
            {formatPEN(trip.precioBase)}
          </Text>
          <Text variant="callout" color="inkSubtle">
            {t('carpool.perSeatLong')}
          </Text>
        </View>

        {/* Conductor público: solo si identity respondió (sin teléfono: contacto NO expuesto). */}
        {driver ? (
          <View style={{gap: theme.spacing.md}}>
            <Text variant="headline">{t('carpool.yourDriver')}</Text>
            <Card variant="outlined" padding="lg">
              <View style={[styles.driverRow, {gap: theme.spacing.md}]}>
                <Avatar name={driver.name} size="md" />
                <View style={styles.flex}>
                  <Text variant="bodyStrong">{driver.name}</Text>
                  <View style={[styles.ratingRow, {gap: theme.spacing.xs}]}>
                    <IconStarFilled color={theme.colors.warn} size={13} />
                    <Text variant="footnote" color="inkMuted" tabular>
                      {driver.averageRating.toFixed(1)}
                    </Text>
                  </View>
                </View>
              </View>
            </Card>
          </View>
        ) : (
          <Text variant="footnote" color="inkSubtle">
            {t('carpool.driverUnavailable')}
          </Text>
        )}

        {/* Vehículo público: solo si fleet respondió. */}
        {vehicle ? (
          <View style={[styles.vehicleRow, {gap: theme.spacing.md}]}>
            <View
              style={[
                styles.iconBubble,
                {backgroundColor: theme.colors.surfaceElevated},
              ]}>
              <IconCar color={theme.colors.inkMuted} size={18} />
            </View>
            <View style={styles.flex}>
              <Text variant="body" numberOfLines={1}>
                {`${vehicle.make} ${vehicle.model} · ${vehicle.color}`}
              </Text>
              <Text variant="footnote" color="inkSubtle" tabular>
                {t('carpool.plate', {plate: vehicle.plate})}
              </Text>
            </View>
          </View>
        ) : null}

        {/* Reglas del viaje: texto libre REAL del conductor; null → la sección no existe. */}
        {trip.reglas ? (
          <View style={{gap: theme.spacing.sm}}>
            <Text variant="headline">{t('carpool.rulesLabel')}</Text>
            <Text variant="callout" color="inkMuted">
              {trip.reglas}
            </Text>
          </View>
        ) : null}

        {/* Asientos disponibles ("3 de 4"). */}
        <View style={[styles.ratingRow, {gap: theme.spacing.sm}]}>
          <Text variant="bodyStrong" tabular>
            {t('carpool.seatsOfTotal', {
              available: trip.asientosDisponibles,
              total: trip.asientosTotales,
            })}
          </Text>
          <Text variant="callout" color="inkMuted">
            {t('carpool.seatsAvailableLabel')}
          </Text>
        </View>
      </ScrollView>
    </SafeScreen>
  );
}

interface TimelineStopProps {
  kind: 'origin' | 'stopover' | 'destination';
  lat: number;
  lon: number;
  /** Hora conocida (solo la salida la tiene en el contrato). */
  time?: string;
  subtitle: string;
  hasNext: boolean;
}

/** Parada del itinerario: riel (punto/anillo/pin + línea) + hora (si existe) + etiqueta geocodificada. */
function TimelineStop({
  kind,
  lat,
  lon,
  time,
  subtitle,
  hasNext,
}: TimelineStopProps): React.JSX.Element {
  const theme = useTheme();
  const label = usePlaceLabel(lat, lon);

  const marker =
    kind === 'origin' ? (
      <View style={[styles.dot, {backgroundColor: theme.colors.accent}]} />
    ) : kind === 'stopover' ? (
      <View style={[styles.ring, {borderColor: theme.colors.inkSubtle}]} />
    ) : (
      <View style={[styles.dot, {backgroundColor: theme.colors.ink}]} />
    );

  return (
    <View style={[styles.stopRow, {gap: theme.spacing.md}]}>
      <View style={styles.rail}>
        {marker}
        {hasNext ? (
          <View
            style={[styles.railLine, {backgroundColor: theme.colors.border}]}
          />
        ) : null}
      </View>
      <View style={[styles.flex, {paddingBottom: hasNext ? 20 : 0}]}>
        {time ? (
          <Text variant="footnote" color="inkMuted" tabular>
            {time}
          </Text>
        ) : null}
        <Text variant="bodyStrong">{label}</Text>
        <Text variant="footnote" color="inkSubtle">
          {subtitle}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1},
  bottomBar: {flexDirection: 'row', alignItems: 'center'},
  itinHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  priceRow: {flexDirection: 'row', alignItems: 'baseline'},
  driverRow: {flexDirection: 'row', alignItems: 'center'},
  ratingRow: {flexDirection: 'row', alignItems: 'center'},
  vehicleRow: {flexDirection: 'row', alignItems: 'center'},
  iconBubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopRow: {flexDirection: 'row', alignItems: 'stretch'},
  rail: {width: 20, alignItems: 'center'},
  dot: {width: 14, height: 14, borderRadius: 7, marginTop: 4},
  ring: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    marginTop: 4,
  },
  railLine: {flex: 1, width: 2, marginTop: 2},
});
