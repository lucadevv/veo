import type {CarpoolSearchItem} from '@veo/api-client';
import {Avatar, Card, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {formatPEN, formatTimeOfDay} from '../../../../shared/utils/format';
import {IconStarFilled} from '../../../trip/presentation/components/icons';

export interface CarpoolTripCardProps {
  item: CarpoolSearchItem;
  /** Etiquetas de la RUTA BUSCADA (lo que el pasajero eligió; el wire solo trae coordenadas). */
  originLabel: string;
  destinationLabel: string;
  onPress: () => void;
}

/**
 * Card de un viaje publicado en los resultados de búsqueda (design/veo.pen C/TripCard).
 * Fila 1: hora de salida + ciudades y el precio por asiento. Fila 2: conductor (iniciales, nombre,
 * rating) + asientos libres. Diferencias honestas con el pen: NO se pinta hora de llegada ni
 * duración (el contrato solo trae `fechaHoraSalida`, no ETA), y si `driver` viene null (identity
 * no respondió) la fila lo dice en vez de inventar un nombre.
 */
export function CarpoolTripCard({
  item,
  originLabel,
  destinationLabel,
  onPress,
}: CarpoolTripCardProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const {trip, driver} = item;

  const seatsLabel =
    trip.asientosDisponibles === 1
      ? t('carpool.seatsOne')
      : t('carpool.seatsMany', {count: trip.asientosDisponibles});

  return (
    <Card
      variant="outlined"
      padding="lg"
      onPress={onPress}
      accessibilityLabel={t('carpool.route', {
        origin: originLabel,
        destination: destinationLabel,
      })}>
      <View style={{gap: theme.spacing.md}}>
        <View style={styles.topRow}>
          <View style={[styles.flex, {gap: theme.spacing.xs}]}>
            <View style={[styles.inline, {gap: theme.spacing.sm}]}>
              <Text variant="headline" tabular>
                {formatTimeOfDay(trip.fechaHoraSalida)}
              </Text>
              {/* flexShrink: un distrito de origen largo ELIPSA en vez de empujar/recortar contra la hora. */}
              <Text
                variant="callout"
                color="inkMuted"
                numberOfLines={1}
                style={{flexShrink: 1}}>
                {originLabel}
              </Text>
            </View>
            <Text variant="callout" color="inkMuted" numberOfLines={1}>
              {destinationLabel}
            </Text>
          </View>
          <View style={styles.priceCol}>
            <Text variant="headline" tabular>
              {formatPEN(trip.precioBase)}
            </Text>
            <Text variant="caption" color="inkSubtle">
              {t('carpool.perSeatUnit')}
            </Text>
          </View>
        </View>

        <View
          style={[styles.divider, {backgroundColor: theme.colors.border}]}
        />

        <View style={[styles.inline, {gap: theme.spacing.sm}]}>
          {driver ? (
            <>
              <Avatar name={driver.name} size="sm" />
              <Text variant="subhead" numberOfLines={1}>
                {driver.name}
              </Text>
              <View style={styles.flex} />
              <IconStarFilled color={theme.colors.warn} size={13} />
              <Text variant="footnote" color="inkMuted" tabular>
                {driver.averageRating.toFixed(1)}
              </Text>
            </>
          ) : (
            // identity no respondió: card honesta, sin nombre ni rating inventados.
            <>
              <Text variant="subhead" color="inkMuted">
                {t('carpool.driverPending')}
              </Text>
              <View style={styles.flex} />
            </>
          )}
          <Text variant="footnote" color="inkSubtle">
            {seatsLabel}
          </Text>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  topRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
  inline: {flexDirection: 'row', alignItems: 'center'},
  priceCol: {alignItems: 'flex-end', gap: 1},
  divider: {height: StyleSheet.hairlineWidth, alignSelf: 'stretch'},
  flex: {flex: 1},
});
