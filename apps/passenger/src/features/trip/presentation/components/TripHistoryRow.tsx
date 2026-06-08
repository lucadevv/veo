import type { TripHistoryItem, TripStatus } from '@veo/api-client';
import { Text, useTheme } from '@veo/ui-kit';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  calendarDaysAgo,
  formatDistance,
  formatDurationMinutes,
  formatPEN,
  formatShortDate,
  formatTimeOfDay,
} from '../../../../shared/utils/format';
import { hexAlpha } from './color';
import { Animated, usePressScale } from './motion';
import { IconCar, IconMoto } from './icons';
import { TripRatingTag } from './TripRatingTag';

export interface TripHistoryRowProps {
  trip: TripHistoryItem;
  /** Estrellas de mi calificación (1–5), `null` si completado sin calificar, `undefined` si N/A o cargando. */
  ratingStars: number | null | undefined;
  ratingLoading?: boolean;
  onPress: () => void;
}

/**
 * Color del PUNTO de estado. El color jamás es el único indicador (siempre hay texto al lado); acá es un
 * acento FINO, no un bloque. Los terminales felices (completado) usan el verde de marca; los no-felices
 * (cancelado/expirado/fallido) un tono de alarma sobrio; lo vivo, el accent.
 */
const STATUS_DOT: Partial<Record<TripStatus, 'success' | 'danger' | 'warn' | 'accent' | 'brand'>> = {
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

/** Estados vivos: el punto pulsa (raro en historial, pero honesto si se cuela). */
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

function normalizeStatus(status: string): TripStatus {
  return status.toUpperCase() as TripStatus;
}

/**
 * Fila PREMIUM del historial — pensada con criterio EDITORIAL, no como la card-con-borde-y-chevron que
 * delata el "hecho por AI". El dueño dijo que la anterior se veía común; esto la repiensa de cero.
 *
 * JERARQUÍA DE AUTOR (qué cuenta la fila de un vistazo, en orden de peso visual):
 *  1) EL TRAYECTO es la identidad del viaje → el RIEL origen→destino es la COLUMNA de la card (un riel
 *     continuo a la izquierda), no un detalle más. Un viaje SE LEE como un recorrido, no como una fila
 *     de datos. Origen = hora real de salida; destino = distancia · duración (sin direcciones inventadas).
 *  2) LA FECHA, a la izquierda del riel, como un "lomo" temporal: día relativo en peso fuerte + hora en
 *     mute tabular debajo. Tipografía con CONTRASTE real de pesos/tamaños (no todo del mismo gris).
 *  3) EL ESTADO como un DETALLE FINO en línea con la fecha: un punto de color + micro-label en mayúsculas
 *     trackeadas, NO un chip genérico flotando arriba-derecha. El color es acento, el texto manda.
 *  4) EL MONTO con PRESENCIA: grande, tabular, alineado a la derecha como el PAYOFF de la card, separado
 *     por una hairline (no un borde que encajona todo). Es el dato que el pasajero busca al escanear.
 *
 * SUPERFICIE: surface con elevación sutil y SIN borde duro (menos "plantilla", más editorial). Toda la
 * card es el tap-target (≥44) con press sutil (escala 0.985 + leve lift), reduce-motion safe. Coherente
 * con el detalle-sheet: mismo riel, misma tipografía de monto, mismo lenguaje de estado. UNA historia.
 */
export function TripHistoryRow({
  trip,
  ratingStars,
  ratingLoading = false,
  onPress,
}: TripHistoryRowProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const { animatedStyle, onPressIn, onPressOut } = usePressScale(0.985);

  const status = normalizeStatus(trip.status);
  const dotTone = STATUS_DOT[status] ?? 'accent';
  const dotColor = theme.colors[dotTone];
  const isLive = LIVE_STATUSES.has(status);
  const isCompleted = status === 'COMPLETED';
  const isCancelled = status === 'CANCELLED' || status === 'FAILED' || status === 'EXPIRED';

  const dayLabel = useMemo(() => {
    const days = calendarDaysAgo(trip.requestedAt);
    if (days === 0) return t('history.dayToday');
    if (days === 1) return t('history.dayYesterday');
    return formatShortDate(trip.requestedAt);
  }, [trip.requestedAt, t]);

  const time = formatTimeOfDay(trip.requestedAt);
  const VehicleIcon = trip.vehicleType === 'MOTO' ? IconMoto : IconCar;

  // Resumen del trayecto SIN inventar direcciones: distancia + duración (lo que el item SÍ sabe).
  const distanceText = formatDistance(trip.distanceMeters);
  const durationText = t('history.minutes', {
    minutes: formatDurationMinutes(trip.durationSeconds),
  });

  // El monto de un viaje cancelado/expirado no es una "tarifa pagada": si no hubo cobro (0), no lo
  // fingimos como protagonista — mostramos un guion sobrio. Si hubo penalidad (>0), sí se muestra.
  const showFare = isCompleted || trip.fareCents > 0;

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('history.rowLabel', {
          day: dayLabel,
          time,
          fare: formatPEN(trip.fareCents),
          status: t(`tripStatus.${status}`),
        })}
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.lg,
            padding: theme.spacing.lg,
            ...theme.elevation.level1,
          },
        ]}
      >
        {/* CABECERA FINA: estado (punto + micro-label trackeada) a la izquierda · vehículo a la derecha.
            El estado vive ACÁ como un detalle de autor, no como un chip suelto. */}
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
              style={[styles.statusLabel, { color: isCancelled ? theme.colors.inkMuted : theme.colors.inkSubtle }]}
              numberOfLines={1}
            >
              {t(`tripStatus.${status}`)}
            </Text>
          </View>
          <View style={styles.vehicle}>
            <VehicleIcon color={theme.colors.inkSubtle} size={16} />
          </View>
        </View>

        {/* CUERPO: a la izquierda el "lomo" temporal (día fuerte + hora muteada); a la derecha el trayecto
            como riel continuo. El riel es la columna que hace que la fila se LEA como un recorrido. */}
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
            <View style={styles.rail} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <View style={[styles.railDotOrigin, { borderColor: theme.colors.brand }]} />
              <View style={[styles.railLine, { backgroundColor: theme.colors.border }]} />
              <View style={[styles.railDotDest, { backgroundColor: theme.colors.ink }]} />
            </View>
            <View style={styles.journeyLabels}>
              <Text variant="subhead" color="inkMuted" numberOfLines={1}>
                {t('history.departedAt', { time })}
              </Text>
              <Text variant="bodyStrong" numberOfLines={1}>
                {`${distanceText} · ${durationText}`}
              </Text>
            </View>
          </View>
        </View>

        {/* PIE: hairline + el MONTO con presencia (payoff) y, si corresponde, el sello de calificación. */}
        <View style={[styles.footer, { borderTopColor: theme.colors.border, paddingTop: theme.spacing.md, marginTop: theme.spacing.md }]}>
          {isCompleted && trip.driverId ? (
            <TripRatingTag stars={ratingStars ?? null} loading={ratingLoading} />
          ) : (
            <View />
          )}
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
    </Animated.View>
  );
}

const RAIL_DOT = 10;

const styles = StyleSheet.create({
  card: { minHeight: 44, overflow: 'hidden' },
  topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusGroup: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 3 },
  // Estado como micro-label editorial: mayúsculas con tracking, no un chip.
  statusLabel: { textTransform: 'uppercase', letterSpacing: 0.8, flexShrink: 1 },
  vehicle: { flexDirection: 'row', alignItems: 'center' },
  body: { flexDirection: 'row', alignItems: 'flex-start', gap: 16, marginTop: 14 },
  // "Lomo" temporal a la izquierda: ancho fijo para que los rieles de toda la lista queden alineados.
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
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
});
