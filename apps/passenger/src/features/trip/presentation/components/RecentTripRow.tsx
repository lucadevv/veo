import type {MapPoint, TripHistoryItem} from '@veo/api-client';
import {useQuery} from '@tanstack/react-query';
import {Text, useTheme} from '@veo/ui-kit';
import React, {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import type {RoutePlace} from '../../../maps/domain/entities';
import {
  calendarDaysAgo,
  formatDistance,
  formatDurationMinutes,
  formatShortDate,
} from '../../../../shared/utils/format';
import {IconPin} from './icons';
import {Animated, usePressScale} from './motion';

export interface RecentTripRowProps {
  trip: TripHistoryItem;
  onSelect: (place: RoutePlace) => void;
}

/**
 * Fila COMPACTA de "Tus últimos viajes" (Home idle). Etiqueta el DESTINO del viaje con geocoding inverso
 * real (el item del historial solo trae el punto, no el nombre) y, al tocar, RE-PIDE ese destino:
 * `onSelect` lo fija → entra a cotización. Muestra metadatos honestos del propio item (día relativo +
 * distancia · duración), sin inventar direcciones. Press sutil (escala 0.97, reduce-motion safe). Si el
 * geocoding aún no resolvió, no renderiza (no muestra una fila sin nombre).
 */
export function RecentTripRow({
  trip,
  onSelect,
}: RecentTripRowProps): React.JSX.Element | null {
  const theme = useTheme();
  const {t} = useTranslation();
  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const {animatedStyle, onPressIn, onPressOut} = usePressScale();

  const mapPoint = useMemo<MapPoint>(
    () => ({lat: trip.destination.lat, lng: trip.destination.lng}),
    [trip.destination.lat, trip.destination.lng],
  );

  const labelQuery = useQuery({
    queryKey: ['maps', 'reverse', mapPoint.lat, mapPoint.lng],
    queryFn: () => reverseGeocode.execute(mapPoint),
    staleTime: 5 * 60_000,
  });

  const dayLabel = useMemo(() => {
    const days = calendarDaysAgo(trip.requestedAt);
    if (days === 0) return t('history.dayToday');
    if (days === 1) return t('history.dayYesterday');
    return formatShortDate(trip.requestedAt);
  }, [trip.requestedAt, t]);

  const meta = useMemo(() => {
    const distance = formatDistance(trip.distanceMeters);
    const duration = t('history.minutes', {
      minutes: formatDurationMinutes(trip.durationSeconds),
    });
    return `${dayLabel} · ${distance} · ${duration}`;
  }, [trip.distanceMeters, trip.durationSeconds, dayLabel, t]);

  if (!labelQuery.data) {
    return null;
  }

  const label = labelQuery.data;

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('home.recentTripRowLabel', {
          destination: label.title,
          meta,
        })}
        onPress={() =>
          onSelect({
            point: {lat: label.lat, lng: label.lng},
            title: label.title,
            subtitle: label.subtitle,
          })
        }
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={[
          styles.row,
          {paddingVertical: theme.spacing.sm, gap: theme.spacing.md},
        ]}>
        <View
          style={[
            styles.iconWrap,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderRadius: theme.radii.md,
            },
          ]}>
          <IconPin color={theme.colors.inkSubtle} size={18} />
        </View>
        <View style={styles.labels}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {label.title}
          </Text>
          <Text variant="footnote" color="inkSubtle" numberOfLines={1}>
            {meta}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const ICON = 36;

const styles = StyleSheet.create({
  row: {minHeight: 44, flexDirection: 'row', alignItems: 'center'},
  iconWrap: {
    width: ICON,
    height: ICON,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labels: {flex: 1, gap: 2},
});
