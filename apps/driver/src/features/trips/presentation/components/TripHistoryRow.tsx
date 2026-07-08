import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { TripHistoryItem, TripStatus } from '@veo/api-client';
import { hexAlpha, Text, useTheme } from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import {
  calendarDaysAgo,
  formatPEN,
  formatShortDate,
  formatTimeOfDay,
  metersToKm,
  secondsToMinutes,
} from '../../../../shared/presentation/format';
import { vehicleClassGlyph } from '../../../../shared/presentation/vehicle-class';
import { parseTripStatus } from '../../domain/value-objects/trip-status';

/** Tono del punto de estado (clave de color del tema; el color es un acento fino, nunca el único indicador). */
type StatusTone = 'success' | 'danger' | 'warn' | 'accent' | 'brand';

/**
 * Estado → tono del punto. Terminales felices (completado) en verde de éxito; los no-felices
 * (cancelado/fallido) en alarma sobria; vencido en warn; lo vivo en accent; lo asignado/programado en brand.
 * Lookup PARCIAL con fallback explícito a `accent` (un estado nuevo del contrato no rompe la fila).
 */
const STATUS_TONE: Partial<Record<TripStatus, StatusTone>> = {
  COMPLETED: 'success',
  CANCELLED: 'danger',
  FAILED: 'danger',
  EXPIRED: 'warn',
  REQUESTED: 'accent',
  MATCHING: 'accent',
  IN_PROGRESS: 'accent',
  REASSIGNING: 'accent',
  ASSIGNED: 'brand',
  ACCEPTED: 'brand',
  ARRIVING: 'brand',
  ARRIVED: 'brand',
  SCHEDULED: 'brand',
};

/** Estado → clave i18n de su etiqueta (viven en `trips.status.*`). Fallback a `unknown`. */
const STATUS_LABEL_KEY: Partial<Record<TripStatus, string>> = {
  COMPLETED: 'trips.status.completed',
  CANCELLED: 'trips.status.cancelled',
  FAILED: 'trips.status.failed',
  EXPIRED: 'trips.status.expired',
  REQUESTED: 'trips.status.requested',
  MATCHING: 'trips.status.matching',
  IN_PROGRESS: 'trips.status.inProgress',
  REASSIGNING: 'trips.status.reassigning',
  ASSIGNED: 'trips.status.assigned',
  ACCEPTED: 'trips.status.accepted',
  ARRIVING: 'trips.status.arriving',
  ARRIVED: 'trips.status.arrived',
  SCHEDULED: 'trips.status.scheduled',
};

export interface TripHistoryRowProps {
  trip: TripHistoryItem;
}

/**
 * Fila del historial de viajes del CONDUCTOR (card de "Mis Viajes"). Espeja la jerarquía editorial de la
 * fila del pasajero, adaptada a los tokens del conductor (modo noche por defecto):
 *
 *  - CABECERA fina: punto de estado + micro-label en mayúsculas trackeadas · ícono del tier a la derecha.
 *  - CUERPO: "lomo" temporal (día relativo fuerte + hora muteada) + el trayecto como RIEL continuo
 *    origen→destino con su resumen (distancia · duración). NO se inventan direcciones: solo lo que el item sabe.
 *  - PIE: hairline + el MONTO con presencia (payoff). En un cancelado/vencido sin cobro, un guion sobrio.
 *
 * PRESSABLE: navega al detalle/recibo del viaje (frame C/Historial-Detalle) pasando el `TripHistoryItem`
 * COMPLETO que ya trae la fila (origen/destino, distancia, duración, fecha, tarifa, tier) — la fuente real
 * del recibo, más rica que el `GET /trips/:id`. El feedback táctil es una atenuación sobria al presionar.
 */
export function TripHistoryRow({ trip }: TripHistoryRowProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const status = parseTripStatus(trip.status);
  const tone: StatusTone = status === 'UNKNOWN' ? 'accent' : STATUS_TONE[status] ?? 'accent';
  const dotColor = theme.colors[tone];
  const statusLabel =
    status === 'UNKNOWN'
      ? t('trips.status.unknown')
      : t(STATUS_LABEL_KEY[status] ?? 'trips.status.unknown');

  const isCompleted = status === 'COMPLETED';
  const isCancelled = status === 'CANCELLED' || status === 'FAILED' || status === 'EXPIRED';

  const dayLabel = useMemo(() => {
    const days = calendarDaysAgo(trip.requestedAt);
    if (days === 0) return t('trips.history.dayToday');
    if (days === 1) return t('trips.history.dayYesterday');
    return formatShortDate(trip.requestedAt);
  }, [trip.requestedAt, t]);

  const time = formatTimeOfDay(trip.requestedAt);

  // Ícono del tier desde el registro EXHAUSTIVO clase→glyph (sin ternarios `=== 'MOTO'`).
  const VehicleIcon = vehicleClassGlyph(trip.vehicleType);

  // Resumen del trayecto SIN inventar direcciones: distancia + duración (lo que el item SÍ trae).
  const summary = t('trips.history.tripSummary', {
    distance: t('trips.kilometers', { value: metersToKm(trip.distanceMeters) }),
    duration: t('trips.minutes', { value: secondsToMinutes(trip.durationSeconds) }),
  });

  // El monto de un cancelado/vencido no es una "tarifa cobrada": si no hubo cobro (0), guion sobrio en vez
  // de fingirlo como protagonista. Si hubo penalidad (>0) o fue completado, sí se muestra.
  const showFare = isCompleted || trip.fareCents > 0;

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={t('trips.history.departedAt', { time })}
      accessibilityHint={t('trips.detail.title')}
      onPress={() => navigation.navigate('TripDetail', { trip })}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.lg,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      {/* CABECERA FINA: estado (punto + micro-label) a la izquierda · ícono del tier a la derecha. */}
      <View style={styles.topLine}>
        <View style={styles.statusGroup}>
          <View
            style={[
              styles.dot,
              { backgroundColor: dotColor, borderColor: hexAlpha(dotColor, 0.28) },
            ]}
          />
          <Text
            variant="caption"
            style={[
              styles.statusLabel,
              { color: isCancelled ? theme.colors.inkMuted : theme.colors.inkSubtle },
            ]}
            numberOfLines={1}
          >
            {statusLabel}
          </Text>
        </View>
        <VehicleIcon color={theme.colors.inkSubtle} size={16} />
      </View>

      {/* CUERPO: "lomo" temporal a la izquierda + el trayecto como riel continuo a la derecha. */}
      <View style={styles.body}>
        <View style={styles.dateSpine}>
          <Text variant="title3" numberOfLines={1}>
            {dayLabel}
          </Text>
          <Text variant="footnote" color="inkSubtle" tabular>
            {time}
          </Text>
        </View>

        <View style={styles.journey}>
          <View
            style={styles.rail}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <View style={[styles.railDotOrigin, { borderColor: theme.colors.brand }]} />
            <View style={[styles.railLine, { backgroundColor: theme.colors.border }]} />
            <View style={[styles.railDotDest, { backgroundColor: theme.colors.ink }]} />
          </View>
          <View style={styles.journeyLabels}>
            <Text variant="subhead" color="inkMuted" numberOfLines={1}>
              {t('trips.history.departedAt', { time })}
            </Text>
            <Text variant="bodyStrong" numberOfLines={1}>
              {summary}
            </Text>
          </View>
        </View>
      </View>

      {/* PIE: hairline + el MONTO con presencia (payoff), alineado a la derecha. */}
      <View
        style={[
          styles.footer,
          {
            borderTopColor: theme.colors.border,
            paddingTop: theme.spacing.md,
            marginTop: theme.spacing.md,
          },
        ]}
      >
        {showFare ? (
          <Text variant="title3" tabular>
            {formatPEN(trip.fareCents)}
          </Text>
        ) : (
          <Text variant="title3" color="inkSubtle">
            —
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const RAIL_DOT = 10;

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusGroup: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 3 },
  statusLabel: { textTransform: 'uppercase', letterSpacing: 0.8, flexShrink: 1 },
  body: { flexDirection: 'row', alignItems: 'flex-start', gap: 16, marginTop: 14 },
  dateSpine: { width: 84, gap: 2 },
  journey: { flex: 1, flexDirection: 'row', gap: 12 },
  rail: { width: RAIL_DOT, alignItems: 'center', paddingTop: 5 },
  railDotOrigin: { width: RAIL_DOT, height: RAIL_DOT, borderRadius: RAIL_DOT / 2, borderWidth: 2.5 },
  railLine: { width: 2, flex: 1, marginVertical: 3, minHeight: 16 },
  railDotDest: { width: RAIL_DOT, height: RAIL_DOT, borderRadius: 2 },
  journeyLabels: { flex: 1, justifyContent: 'space-between', gap: 12 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
