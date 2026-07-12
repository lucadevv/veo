import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { GeoPoint } from '@veo/api-client';
import { hexAlpha, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { AppMap } from '../../../../shared/presentation/components/AppMap';
import { RouteSummaryCard } from '../../../../shared/presentation/components/RouteSummaryCard';
import { IconAccount, IconStar } from '../../../../shared/presentation/icons';
import {
  calendarDaysAgo,
  formatPEN,
  formatShortDate,
  formatTimeOfDay,
  metersToKm,
  secondsToMinutes,
} from '../../../../shared/presentation/format';
import { useMyTripRating } from '../hooks/usePassengerRating';
import { commissionPercent, computeTripEarnings } from '../../domain';
import { Appear } from '../components/motion';

type Props = NativeStackScreenProps<RootStackParamList, 'TripDetail'>;

/**
 * Detalle/recibo de un viaje del HISTORIAL del conductor (frame C/Historial-Detalle). Cierra el seam
 * SOLO-DISEÑO: hasta ahora la fila del historial no navegaba a ningún lado.
 *
 * FUENTE DE DATOS (real, sin invención): el recibo se arma con el `TripHistoryItem` COMPLETO que la fila
 * ya trajo del `GET /trips/history` — trae origen/destino (coords), distancia, duración, fecha, tarifa y
 * tier. El `GET /trips/:id` del driver-bff (`driverTripView`) es MÁS POBRE que este item (no expone
 * coords, ni fecha, ni tier), así que reusarlo para el detalle degradaría la pantalla en vez de
 * enriquecerla: por eso NO se lo llama. Lo único que se resuelve on-demand por `id` es MI calificación
 * al pasajero (`GET /ratings?tripId` vía `useMyTripRating`).
 *
 * DEGRADACIONES HONESTAS (el contrato no trae el dato, no se inventa):
 *  - Direcciones de calle: el contrato solo trae lat/lng (sin reverse-geocode) → etiquetas genéricas
 *    "Punto de recojo"/"Destino" con los puntos de color (marca=origen, éxito=destino).
 *  - Nombre del pasajero: PII, no viaja en el contrato del viaje (regla #5) → avatar genérico + "Pasajero".
 *  - Mini-mapa: markers reales origen+destino (sin la geometría de ruta, que solo existe para el viaje
 *    activo); sin token de Mapbox, `AppMap` degrada a un lienzo oscuro (no crashea).
 */
export const TripDetailScreen = ({ navigation, route }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { trip } = route.params;

  // Desglose de la ganancia desde la tarifa (mismo modelo bruto − comisión que el cierre y Ganancias).
  const earnings = computeTripEarnings(trip.fareCents);

  // Coords del contrato del historial (`{lat,lng}`) → `GeoPoint` (`{lat,lon}`) que consume `AppMap`.
  const origin: GeoPoint = { lat: trip.origin.lat, lon: trip.origin.lng };
  const destination: GeoPoint = { lat: trip.destination.lat, lon: trip.destination.lng };

  // Fecha del recibo: preferimos el fin del viaje (lo que "pasó"); si no completó, la solicitud.
  const stamp = trip.completedAt ?? trip.requestedAt;
  const dateLabel = useMemo(() => {
    const days = calendarDaysAgo(stamp);
    const day =
      days === 0
        ? t('trips.history.dayToday')
        : days === 1
          ? t('trips.history.dayYesterday')
          : formatShortDate(stamp);
    const time = formatTimeOfDay(stamp);
    return time ? `${day} ${time}` : day;
  }, [stamp, t]);

  // MI calificación al pasajero (las estrellas que YO le puse). `null` si aún no califiqué.
  const rating = useMyTripRating(trip.id);
  const myStars = rating.data?.stars ?? null;

  return (
    <SafeScreen
      scroll
      padded
      header={<TopBar title={t('trips.detail.title')} onBack={navigation.goBack} />}
    >
      <Appear style={styles.body}>
        {/* MINI-MAPA: recorrido real (markers origen+destino). Sin token Mapbox → lienzo oscuro (honesto). */}
        <View
          accessibilityRole="image"
          accessibilityLabel={t('trips.detail.mapLabel')}
          style={[styles.map, { borderColor: theme.colors.border, borderRadius: theme.radii.md }]}
        >
          <AppMap origin={origin} destination={destination} fitToRoute interactive={false} />
        </View>

        {/* RUTA: origen→destino con el card canónico. Etiquetas genéricas (el contrato no trae
            direcciones de calle) y fill blanco porque acá va sobre el canvas gris, no sobre un sheet. */}
        <RouteSummaryCard
          fill="surface"
          origin={t('trips.detail.origin')}
          destination={t('trips.detail.destination')}
        />

        {/* META: distancia · duración · fecha. */}
        <View style={styles.meta}>
          <MetaCell value={t('trips.kilometers', { value: metersToKm(trip.distanceMeters) })} label={t('trips.distance')} />
          <MetaCell value={t('trips.minutes', { value: secondsToMinutes(trip.durationSeconds) })} label={t('trips.duration')} />
          <MetaCell value={dateLabel} label={t('trips.detail.date')} />
        </View>

        {/* RECIBO: tarifa − comisión = neto (el neto en verde, el payoff). */}
        <View style={[styles.card, cardStyle(theme)]}>
          <BreakdownRow label={t('trips.detail.fareLabel')} value={formatPEN(earnings.fareCents)} />
          <BreakdownRow
            label={t('trips.detail.commissionLabel', { pct: commissionPercent(earnings.commissionRate) })}
            value={`- ${formatPEN(earnings.commissionCents)}`}
            valueColor="inkSubtle"
          />
          <BreakdownRow
            label={t('trips.detail.netLabel')}
            value={formatPEN(earnings.netCents)}
            valueColor="success"
          />
        </View>

        {/* PASAJERO: avatar genérico (sin PII) + MI calificación al pasajero. */}
        <View style={[styles.pax, cardStyle(theme)]}>
          <View
            style={[
              styles.avatar,
              {
                backgroundColor: hexAlpha(theme.colors.brand, 0.15),
                borderColor: theme.colors.borderStrong,
              },
            ]}
          >
            <IconAccount size={20} color={theme.colors.brand} />
          </View>
          <View style={styles.paxInfo}>
            <Text variant="bodyStrong" numberOfLines={1}>
              {t('trips.detail.passenger')}
            </Text>
            {myStars != null ? (
              <View style={styles.ratingRow}>
                <Text variant="footnote" color="inkSubtle">
                  {t('trips.detail.youRated')}
                </Text>
                <IconStar size={13} color={theme.colors.inkSubtle} filled />
                <Text variant="footnote" color="inkSubtle" tabular>
                  {myStars.toFixed(1)}
                </Text>
              </View>
            ) : (
              <Text variant="footnote" color="inkSubtle">
                {t('trips.detail.notRated')}
              </Text>
            )}
          </View>
        </View>
      </Appear>
    </SafeScreen>
  );
};

/** Estilo compartido de las cards (surface + hairline + radio del sistema). */
function cardStyle(theme: ReturnType<typeof useTheme>): object {
  return {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.md,
    padding: theme.spacing.lg,
  };
}

interface MetaCellProps {
  value: string;
  label: string;
}

/** Celda del grid de meta: valor grotesk fuerte arriba, etiqueta muteada abajo. */
function MetaCell({ value, label }: MetaCellProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.metaCell,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.sm,
        },
      ]}
    >
      <Text variant="bodyStrong" tabular numberOfLines={1}>
        {value}
      </Text>
      <Text variant="caption" color="inkSubtle" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

interface BreakdownRowProps {
  label: string;
  value: string;
  valueColor?: 'ink' | 'inkSubtle' | 'success';
}

/** Fila etiqueta–monto del recibo. */
function BreakdownRow({ label, value, valueColor = 'ink' }: BreakdownRowProps): React.JSX.Element {
  return (
    <View style={styles.breakdownRow}>
      <Text variant="callout" color="inkMuted" style={styles.flex} numberOfLines={1}>
        {label}
      </Text>
      <Text variant="callout" color={valueColor} tabular numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12, paddingTop: 12, paddingBottom: 24 },
  map: {
    height: 120,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  card: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth, gap: 8 },
  meta: { flexDirection: 'row', gap: 8 },
  metaCell: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  breakdownRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pax: {
    alignSelf: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paxInfo: { flex: 1, gap: 2 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  flex: { flex: 1 },
});
