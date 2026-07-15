import type {CarpoolSearchItem} from '@veo/api-client';
import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import {formatPEN, formatTimeOfDay} from '../../../../shared/utils/format';
import {formatWeekdayDay} from '../../../../shared/utils/formatDay';
import {IconStarFilled} from '../../../trip/presentation/components/icons';
import {usePlaceLabel} from '../usePlaceLabel';

export interface CarpoolFeedCardProps {
  item: CarpoolSearchItem;
  onPress: () => void;
}

/** Micro-label temporal de la card: HOY / MAÑANA / "VIE 17" (día calendario local del viaje). */
function dayLabel(iso: string, hoy: string, manana: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOf = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(date) - startOf(now)) / 86_400_000);
  if (diffDays <= 0) {
    return hoy;
  }
  if (diffDays === 1) {
    return manana;
  }
  return formatWeekdayDay(date);
}

/**
 * Card COMPACTA del feed del marketplace (design/veo.pen T/CarpoolCard · grilla 2 columnas):
 * micro-label del día + HORA grande + destino geocodificado + divisor + precio (brand) con la
 * píldora "Quedan N" (asientos REALES disponibles — el estado del viaje, honesto) + conductor
 * (rating + nombre). Conductor `null` = card DEGRADADA (identity caída): la fila se omite, sin
 * inventar nombres. El destino sale del geocoding inverso por coordenada (cache compartida).
 */
export function CarpoolFeedCard({
  item,
  onPress,
}: CarpoolFeedCardProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const {trip, driver} = item;

  const destinoLabel = usePlaceLabel(trip.destinoLat, trip.destinoLon);
  const dia = dayLabel(
    trip.fechaHoraSalida,
    t('schedule.today'),
    t('schedule.tomorrow'),
  );
  const quedan =
    trip.asientosDisponibles === 1
      ? t('carpool.seatsLeftOne')
      : t('carpool.seatsLeftMany', {count: trip.asientosDisponibles});

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${dia} ${formatTimeOfDay(trip.fechaHoraSalida)} → ${destinoLabel}, ${formatPEN(trip.precioBase)}, ${quedan}`}
      onPress={onPress}
      style={({pressed}) => [
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.md,
          opacity: pressed ? 0.85 : 1,
          ...theme.elevation.level1,
        },
      ]}>
      <Text
        variant="caption"
        style={[styles.dia, {color: theme.colors.inkSubtle}]}>
        {dia}
      </Text>
      <Text variant="title2" tabular numberOfLines={1}>
        {formatTimeOfDay(trip.fechaHoraSalida)}
      </Text>
      <Text variant="footnote" color="inkMuted" numberOfLines={1}>
        → {destinoLabel}
      </Text>

      <View style={[styles.div, {backgroundColor: theme.colors.border}]} />

      <View style={styles.row}>
        <Text
          variant="bodyStrong"
          tabular
          numberOfLines={1}
          style={{color: theme.colors.brand}}>
          {formatPEN(trip.precioBase)}
        </Text>
        <View
          style={[
            styles.quedanPill,
            {
              backgroundColor: theme.colors.successDim,
              borderRadius: theme.radii.pill,
            },
          ]}>
          <Text
            variant="caption"
            style={[styles.quedanLabel, {color: theme.colors.successText}]}>
            {quedan}
          </Text>
        </View>
      </View>

      {driver !== null ? (
        <View style={styles.row}>
          <View style={styles.rating}>
            <IconStarFilled color={theme.colors.warn} size={11} />
            <Text variant="caption" color="inkMuted" tabular>
              {driver.averageRating.toFixed(1)}
            </Text>
          </View>
          <Text
            variant="caption"
            color="inkSubtle"
            numberOfLines={1}
            style={styles.nombre}>
            · {driver.name}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {flex: 1, gap: 6, borderWidth: 1, minHeight: 44},
  dia: {fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase'},
  div: {height: StyleSheet.hairlineWidth, alignSelf: 'stretch'},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  quedanPill: {paddingVertical: 3, paddingHorizontal: 8},
  quedanLabel: {fontSize: 10, fontWeight: '600'},
  rating: {flexDirection: 'row', alignItems: 'center', gap: 4},
  nombre: {flexShrink: 1},
});
