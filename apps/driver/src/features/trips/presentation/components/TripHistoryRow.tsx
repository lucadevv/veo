import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { TripHistoryItem, TripStatus } from '@veo/api-client';
import { Text, useTheme } from '@veo/ui-kit';
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
 * Fila del historial de viajes del CONDUCTOR, FIEL al frame C/Historial (`Trip-*`):
 *
 *  - CABECERA fina: punto de estado + micro-label EN EL COLOR DEL TONO (COMPLETADO en jade) · ícono del tier.
 *  - FILA única: "lomo" temporal (día fuerte + hora muteada, ancho fijo) + trayecto en texto plano
 *    ("Salió a las…" + distancia · duración) + el MONTO a la derecha, en la MISMA fila.
 *
 * NO hay riel origen→destino ni footer con hairline: el frame es compacto y el monto acompaña la fila, no
 * cuelga de un pie con divisoria. No se inventan direcciones: solo lo que el `TripHistoryItem` trae.
 *
 * PRESSABLE: navega al detalle/recibo (frame C/Historial-Detalle) con el item COMPLETO. Feedback: atenuación.
 */
export function TripHistoryRow({ trip }: TripHistoryRowProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const status = parseTripStatus(trip.status);
  const tone: StatusTone = status === 'UNKNOWN' ? 'accent' : STATUS_TONE[status] ?? 'accent';
  const toneColor = theme.colors[tone];
  const statusLabel =
    status === 'UNKNOWN'
      ? t('trips.status.unknown')
      : t(STATUS_LABEL_KEY[status] ?? 'trips.status.unknown');

  const isCompleted = status === 'COMPLETED';

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
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.lg,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      {/* CABECERA FINA: estado (punto + micro-label en el tono) a la izquierda · ícono del tier a la derecha. */}
      <View style={styles.topLine}>
        <View style={styles.statusGroup}>
          <View style={[styles.dot, { backgroundColor: toneColor }]} />
          <Text variant="caption" style={[styles.statusLabel, { color: toneColor }]} numberOfLines={1}>
            {statusLabel}
          </Text>
        </View>
        <VehicleIcon color={theme.colors.inkSubtle} size={16} />
      </View>

      {/* FILA única: fecha (ancho fijo) · trayecto (crece) · monto — todo en línea, como el frame. */}
      <View style={styles.mid}>
        <View style={styles.dateCol}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {dayLabel}
          </Text>
          <Text variant="caption" color="inkMuted" tabular>
            {time}
          </Text>
        </View>

        <View style={styles.route}>
          <Text variant="footnote" numberOfLines={1}>
            {t('trips.history.departedAt', { time })}
          </Text>
          <Text variant="caption" color="inkMuted" numberOfLines={1}>
            {summary}
          </Text>
        </View>

        {showFare ? (
          <Text variant="bodyStrong" tabular>
            {formatPEN(trip.fareCents)}
          </Text>
        ) : (
          <Text variant="bodyStrong" color="inkSubtle">
            —
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusGroup: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  statusLabel: { textTransform: 'uppercase', letterSpacing: 0.5, flexShrink: 1, fontWeight: '700' },
  mid: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 12 },
  dateCol: { width: 78, gap: 2 },
  route: { flex: 1, gap: 3 },
});
