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

/** Tono del punto de estado (clave de color del tema; el punto lleva el color, el texto va neutro). */
type StatusTone = 'success' | 'danger' | 'warn' | 'accent' | 'brand';

/**
 * Estado → tono del PUNTO. Terminales felices (completado) en verde de éxito; los no-felices
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

/** Estados vivos: el punto lleva un anillo (raro en historial, pero honesto si se cuela). */
const LIVE_STATUSES: ReadonlySet<TripStatus> = new Set<TripStatus>([
  'REQUESTED',
  'MATCHING',
  'ASSIGNED',
  'ACCEPTED',
  'ARRIVING',
  'ARRIVED',
  'IN_PROGRESS',
  'REASSIGNING',
]);

export interface TripHistoryRowProps {
  trip: TripHistoryItem;
}

/**
 * Fila del historial de viajes del CONDUCTOR — MISMA identidad editorial que la del pasajero (fila premium
 * compartida en criterio, no la card-con-borde-y-chevron que delata el "hecho por AI"):
 *
 *  1) CABECERA fina: punto de estado (lleva el tono) + micro-label en mayúsculas trackeadas NEUTRO ·
 *     ícono del tier a la derecha.
 *  2) CUERPO: "lomo" temporal a la izquierda (día `title3` + hora muteada) + el TRAYECTO como RIEL
 *     continuo origen→destino (se lee como recorrido, no como fila de datos). Sin inventar direcciones:
 *     origen = hora de salida, destino = distancia · duración.
 *  3) PIE: hairline + el MONTO con presencia (`title3`, payoff a la derecha).
 *
 * SUPERFICIE: surface con elevación sutil y SIN borde duro (menos "plantilla", más editorial). PRESSABLE:
 * navega al detalle/recibo (frame C/Historial-Detalle) con el item COMPLETO.
 */
export function TripHistoryRow({ trip }: TripHistoryRowProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const status = parseTripStatus(trip.status);
  const tone: StatusTone = status === 'UNKNOWN' ? 'accent' : STATUS_TONE[status] ?? 'accent';
  const dotColor = theme.colors[tone];
  const isLive = status !== 'UNKNOWN' && LIVE_STATUSES.has(status);
  const isCompleted = status === 'COMPLETED';
  const isCancelled = status === 'CANCELLED' || status === 'FAILED' || status === 'EXPIRED';
  const statusLabel =
    status === 'UNKNOWN'
      ? t('trips.status.unknown')
      : t(STATUS_LABEL_KEY[status] ?? 'trips.status.unknown');

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

  // El monto de un cancelado/vencido sin cobro (0) es un guion sobrio, no una tarifa fingida.
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
          borderRadius: theme.radii.lg,
          padding: theme.spacing.lg,
          ...theme.elevation.level1,
          opacity: pressed ? 0.9 : 1,
        },
      ]}
    >
      {/* CABECERA FINA: estado (punto en el tono + micro-label NEUTRO) a la izquierda · ícono del tier. */}
      <View style={styles.topLine}>
        <View style={styles.statusGroup}>
          <View
            style={[
              styles.dot,
              { backgroundColor: dotColor },
              isLive ? { borderColor: hexAlpha(dotColor, 0.28) } : null,
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

      {/* CUERPO: "lomo" temporal (día fuerte + hora muteada) + TRAYECTO como riel continuo origen→destino. */}
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

      {/* PIE: hairline + el MONTO con presencia (payoff a la derecha). */}
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
  card: { minHeight: 44, overflow: 'hidden' },
  topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusGroup: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 3 },
  // Estado como micro-label editorial: mayúsculas con tracking, NEUTRO (el punto lleva el color).
  statusLabel: { textTransform: 'uppercase', letterSpacing: 0.8, flexShrink: 1 },
  body: { flexDirection: 'row', alignItems: 'flex-start', gap: 16, marginTop: 14 },
  // "Lomo" temporal a la izquierda: ancho fijo para que los rieles de toda la lista queden alineados.
  dateSpine: { width: 84, gap: 2 },
  journey: { flex: 1, flexDirection: 'row', gap: 12 },
  rail: { width: RAIL_DOT, alignItems: 'center', paddingTop: 5 },
  railDotOrigin: { width: RAIL_DOT, height: RAIL_DOT, borderRadius: RAIL_DOT / 2, borderWidth: 2.5 },
  railLine: { width: 2, flex: 1, marginVertical: 3, minHeight: 16 },
  railDotDest: { width: RAIL_DOT, height: RAIL_DOT, borderRadius: 2 },
  journeyLabels: { flex: 1, justifyContent: 'space-between', gap: 12 },
  // PIE: hairline + monto a la derecha (el conductor no califica en su fila → sin rating tag).
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
});
