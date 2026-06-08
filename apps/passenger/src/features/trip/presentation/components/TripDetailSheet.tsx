import type { GeoPoint, TripHistoryItem, TripStatus } from '@veo/api-client';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { Button, DriverCard, MapShell, Text, useReducedMotion, useTheme } from '@veo/ui-kit';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import type { RootStackParamList } from '../../../../navigation/types';
import { AppMap } from '../../../../shared/presentation/components/AppMap';
import {
  DraggableSheet,
  type DraggableSheetHandle,
} from '../../../../shared/presentation/components/DraggableSheet';
import { decodePolylineToCoordinates } from '../../../../shared/utils/polyline';
import {
  formatDistance,
  formatDurationMinutes,
  formatShortDate,
  formatTimeOfDay,
} from '../../../../shared/utils/format';
import { TipCard } from '../../../payments/presentation';
import { buildReceipt } from '../../domain/receipt';
import { EnterView } from './motion';
import { IconSearch } from './icons';
import { TripFareCard } from './TripFareCard';
import { TripReceiptCard } from './TripReceiptCard';
import { TripRatingSection } from './TripRatingSection';
import { TripRouteRail } from './TripRouteRail';
import { TripStatusPill } from './TripStatusPill';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Convierte el punto del contrato (`{lat,lng}`) al `GeoPoint` (`{lat,lon}`) que consume el mapa. */
function toGeo(point: { lat: number; lng: number } | null | undefined): GeoPoint | null {
  return point ? { lat: point.lat, lon: point.lng } : null;
}

const BACKDROP_OPACITY = 0.58;
const FADE_MS = 220;

export interface TripDetailSheetProps {
  /**
   * Viaje del historial sobre el que se abrió el detalle. Es la SEMILLA: lo esencial (fecha, estado,
   * ruta, tarifa, método, distancia/duración) se pinta AL INSTANTE desde acá —sin flash de carga— porque
   * el item del historial del server ya lo trae. `null` mantiene el host montado pero cerrado.
   */
  trip: TripHistoryItem | null;
  onClose: () => void;
}

/**
 * DETALLE de un viaje TERMINAL en un DRAGGABLE SHEET sobre "Mis Viajes" (no una pantalla aparte). El
 * dueño lo pidió textual: "el detalle quiero que lo hagas en un DraggableSheet" + "eliminá esa pantalla".
 *
 * POR QUÉ SHEET Y NO PANTALLA. El sheet mantiene la lista DEBAJO (contexto: de dónde vengo), sube sobre
 * ella arrastrable, y cierra con gesto hacia abajo o tocando el backdrop —el mismo lenguaje físico del
 * flujo de viaje (RequestFlowScreen reusa el MISMO `DraggableSheet`)—. La continuidad espacial (la card
 * que toqué sigue ahí cuando bajo el sheet) se siente premium; una pantalla full la rompía.
 *
 * INSTANTÁNEO POR DISEÑO. El `DraggableSheet` no trae backdrop ni montaje/desmontaje (está pensado para
 * vivir fijo en el Home), así que acá lo envolvemos en un HOST: backdrop animado (fade + tap-to-close),
 * `BackHandler` de Android, y un `GestureHandlerRootView` propio para que el pan del sheet funcione por
 * encima de la lista. El cuerpo se pinta de la SEMILLA del historial sin esperar red; `GET /trips/:id`
 * solo ENRIQUECE lo que el item no tiene (conductor + vehículo + `myRatingStars`), apareciendo cuando
 * llega sin bloquear lo esencial. Estado SIEMPRE del server (item o detalle), nunca del snapshot local.
 *
 * ANCLAJES. `['content', 0.92]`: peek que ABRAZA el mapa + encabezado + ruta + tarifa (lo esencial de un
 * vistazo) y expandido casi-completo con recibo + calificación + propina + "Olvidé algo". Igual que el
 * Home, el peek es content-hugging (no pantalla a medias vacía).
 */
export function TripDetailSheet({ trip, onClose }: TripDetailSheetProps): React.JSX.Element | null {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const tabBarHeight = useBottomTabBarHeight();

  const sheetRef = useRef<DraggableSheetHandle>(null);
  const tripRepository = useDependency(TOKENS.tripRepository);
  const history = useDependency(TOKENS.tripHistoryRepository);

  const tripId = trip?.id ?? null;

  // Snapshot LOCAL (solo aporta la POLYLINE y el surge del recibo: lo que ni el item ni el detalle traen).
  const snapshot = useMemo(
    () => (tripId ? history.list().find((item) => item.id === tripId) ?? null : null),
    [history, tripId],
  );

  // ENRIQUECIMIENTO: conductor + vehículo + myRatingStars (lo que el item del historial NO trae). Best-
  // effort: si falla o tarda, lo esencial ya está pintado desde la semilla. Estado fresco del server.
  const detailQuery = useQuery({
    queryKey: ['trip', tripId, 'detail'],
    queryFn: () => tripRepository.getActiveTrip(tripId as string),
    enabled: Boolean(tripId),
    staleTime: 30_000,
  });
  const detail = detailQuery.data;

  /* ── Backdrop + montaje/desmontaje del host (el DraggableSheet no los trae) ── */
  const progress = useSharedValue(0); // 0 = oculto, 1 = visible (gobierna el fade del backdrop).
  const open = trip != null;

  useEffect(() => {
    progress.value = reduced
      ? open
        ? 1
        : 0
      : withTiming(open ? 1 : 0, {
          duration: FADE_MS,
          easing: Easing.bezier(...theme.motion.easing.standard),
        });
  }, [open, reduced, progress, theme]);

  // Cierra primero ASENTANDO el sheet al peek (gesto natural) y luego desmonta vía onClose del padre.
  const requestClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // Android: el botón atrás cierra el sheet, no la pantalla, mientras está abierto.
  useEffect(() => {
    if (!open) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      requestClose();
      return true;
    });
    return () => sub.remove();
  }, [open, requestClose]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value * BACKDROP_OPACITY }));

  if (!trip) {
    return null;
  }

  // ── Datos del cuerpo (semilla del item + enriquecimiento del detalle, todo nullable-safe) ──
  const status = trip.status.toUpperCase() as TripStatus;
  const isCompleted = status === 'COMPLETED';

  // Mapa: routePolyline del server (detalle enriquecido) cuando llega → si no, el snapshot MMKV local
  // (offline-first, sin flash) → si ninguna, línea recta origen→destino. origin/destination: el item del
  // historial SIEMPRE los trae; el detalle del server es respaldo. El server prefiere sobre la semilla.
  const routeCoordinates = decodePolylineToCoordinates(
    detail?.routePolyline ?? snapshot?.routePolyline,
  );
  const originPoint = toGeo(detail?.origin ?? trip.origin);
  const destinationPoint = toGeo(detail?.destination ?? trip.destination);

  // Fecha real del server: completado → completedAt; cancelado → cancelledAt; si no, la solicitud. El
  // detalle del server manda; la semilla del historial pinta al instante hasta que llega (offline-first).
  const dateIso =
    (isCompleted
      ? detail?.completedAt ?? trip.completedAt
      : detail?.cancelledAt ?? trip.cancelledAt) ?? (detail?.requestedAt ?? trip.requestedAt);
  const tripDate = formatShortDate(dateIso);
  const departureTime = formatTimeOfDay(detail?.requestedAt ?? trip.requestedAt);
  const distanceText = formatDistance(trip.distanceMeters);
  const durationText = t('history.minutes', {
    minutes: formatDurationMinutes(trip.durationSeconds),
  });

  // Recibo: necesita el view fresco (driver/vehicle para las etiquetas). Solo en completados con detalle.
  const receipt = isCompleted && detail ? buildReceipt(detail, snapshot) : null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* BACKDROP: oscurece la lista y cierra al tocar. Fade propio (el sheet no lo trae). El
          `GestureHandlerRootView` raíz de la app (App.tsx) ya habilita el pan del sheet acá. */}
      <Animated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel={t('actions.close')}
          onPress={requestClose}
        />
      </Animated.View>

      <DraggableSheet
          ref={sheetRef}
          snapPoints={SNAP_POINTS}
          maxContentFraction={PEEK_MAX_FRACTION}
          bottomOffset={tabBarHeight}
          // Arrastrar el sheet por debajo del peek = cerrar (índice 0 es el más bajo; un flick hacia abajo
          // lo lleva ahí y el padre desmonta). No hay índice "cerrado" en el sheet: el host gobierna eso.
          renderHeader={() => (
            <View style={[styles.mapWrap, { marginHorizontal: theme.spacing.xl, marginTop: theme.spacing.xs }]}>
              <MapShell rounded style={styles.map}>
                <AppMap
                  origin={originPoint}
                  destination={destinationPoint}
                  routeCoordinates={routeCoordinates.length > 1 ? routeCoordinates : undefined}
                  fitToRoute={routeCoordinates.length > 1}
                  fitEdgePadding={{ top: 28, bottom: 28, left: 28, right: 28 }}
                  center={originPoint}
                  interactive={false}
                />
              </MapShell>
            </View>
          )}
          renderScroll={(ScrollComponent) => (
            <ScrollComponent
              style={styles.scroll}
              contentContainerStyle={[
                styles.scrollContent,
                {
                  paddingHorizontal: theme.spacing.xl,
                  paddingTop: theme.spacing.lg,
                  paddingBottom: insets.bottom + theme.spacing.xl,
                  gap: theme.spacing.md,
                },
              ]}
              showsVerticalScrollIndicator={false}
            >
              {/* Encabezado de autor: "Viaje del [fecha real]" + estado. Lee como el título de un recibo. */}
              <EnterView index={0}>
                <View style={styles.headerRow}>
                  <Text variant="title2" numberOfLines={1} style={styles.headerTitle}>
                    {t('tripDetail.titleDated', { date: tripDate })}
                  </Text>
                  <TripStatusPill status={status} />
                </View>
              </EnterView>

              {/* Riel origen→destino: hora real de salida · distancia · duración (sin direcciones falsas). */}
              <EnterView index={1}>
                <TripRouteRail
                  origin={t('history.departedAt', { time: departureTime })}
                  destination={`${distanceText} · ${durationText}`}
                />
              </EnterView>

              {/* Conductor + vehículo (tarjeta canónica). Aparece cuando el detalle enriquece (best-effort). */}
              {detail?.driver ? (
                <EnterView index={2}>
                  <DriverCard
                    name={t('trip.driver')}
                    rating={detail.driver.rating ?? undefined}
                    vehicle={
                      detail.vehicle
                        ? `${detail.vehicle.make} ${detail.vehicle.model} · ${detail.vehicle.color}`
                        : undefined
                    }
                    plate={detail.vehicle?.plate}
                  />
                </EnterView>
              ) : null}

              {/* Tarifa + método con logo canónico. Semilla del item: visible al instante. */}
              <EnterView index={3}>
                <TripFareCard fareCents={trip.fareCents} paymentMethod={trip.paymentMethod} />
              </EnterView>

              {isCompleted && receipt ? (
                <EnterView index={4}>
                  <TripReceiptCard receipt={receipt} />
                </EnterView>
              ) : null}

              {/* Calificación integrada (read-only si ya calificaste; CTA → RatingBody que maneja el 409). */}
              {isCompleted && detail?.driver ? (
                <EnterView index={5}>
                  <TripRatingSection
                    tripId={trip.id}
                    driverId={detail.driver.id}
                    embeddedStars={detail.myRatingStars}
                    onRated={() => detailQuery.refetch()}
                  />
                </EnterView>
              ) : null}

              {/* Propina (100% al conductor). Si ya hubo, muestra el estado enviado. */}
              {isCompleted && detail?.driver ? (
                <EnterView index={6}>
                  <TipCard tripId={trip.id} initialTipCents={detail.tipCents} />
                </EnterView>
              ) : null}

              {/* Acción honesta y única: reportar un objeto olvidado (cierra el sheet y abre el ticket). */}
              {isCompleted ? (
                <EnterView index={7}>
                  <Button
                    label={t('lostItem.entry')}
                    variant="secondary"
                    fullWidth
                    leftIcon={<IconSearch color={theme.colors.ink} size={18} />}
                    onPress={() => {
                      requestClose();
                      navigation.navigate('LostItem', { tripId: trip.id });
                    }}
                  />
                </EnterView>
              ) : null}
            </ScrollComponent>
          )}
        />
    </View>
  );
}

/** Peek que abraza mapa + encabezado + ruta + tarifa; expandido casi-completo con el resto. */
const SNAP_POINTS = ['content', 0.92] as const;
const PEEK_MAX_FRACTION = 0.6;

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000000' },
  mapWrap: { borderRadius: 18, overflow: 'hidden' },
  map: { height: 168 },
  scroll: { flex: 1 },
  scrollContent: {},
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  headerTitle: { flex: 1 },
});
