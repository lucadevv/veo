import type {
  GeoPoint,
  MapPoint,
  MobilePaymentMethod,
  QuoteOption,
  SpecialRequest,
} from '@veo/api-client';
import {isKycRequiredError} from '@veo/api-client';
import {isPujaMode} from '@veo/shared-types';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useMutation, useQuery} from '@tanstack/react-query';
import {
  Banner,
  Button,
  IconButton,
  RideOptionRow,
  Skeleton,
  StatusPill,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, StatusBar, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import type {RootStackParamList} from '../../../../navigation/types';
import {AppMap} from '../../../../shared/presentation/components/AppMap';
import {
  offeringDisplayName,
  offeringGlyph,
} from '../../../../shared/presentation/components/offeringGlyphs';
import {
  formatDateTime,
  formatDistance,
  formatDurationMinutes,
  formatPEN,
} from '../../../../shared/utils/format';
import {useChildModeStore} from '../../../childMode/presentation/stores/childModeStore';
import {usePaymentPrefsStore} from '../../../payments/presentation/stores/paymentPrefsStore';
import {
  PaymentMethodRow,
  PaymentMethodSheet,
} from '../../../payments/presentation';
import {useIsYapeAutoActive} from '../../../../shared/presentation/hooks/useIsYapeAutoActive';
import {PromoField, type AppliedPromo} from '../../../promos/presentation';
import {ScheduleSheet} from '../../../trip/presentation/components/ScheduleSheet';
import {initialBidCents, stepBidCents} from '../../../../shared/utils/bid';
import {uuidv4} from '../../../../shared/utils/uuid';
import {isWaypointSet, type RoutePlace} from '../../domain/entities';
import {BidPanel} from '../../../../shared/presentation/components/BidPanel';
import {buildCreateTripInput} from '../../../trip/domain/buildCreateTripInput';
import {RoutePointsList} from '../components/RoutePointsList';
import {SpecialRequestChips} from '../components/SpecialRequestChips';
import {VehicleIcon} from '../components/VehicleIcon';
import {SelectionBump} from '../components/motion';
import {IconArrowLeft} from '../../../trip/presentation/components/icons';
import {useRideDraftStore} from '../stores/rideDraftStore';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Convierte el punto de la API de mapas (lng) al `GeoPoint` de dominio (lon). */
function toGeoPoint(point: MapPoint): GeoPoint {
  return {lat: point.lat, lon: point.lng};
}

/**
 * LEGACY: solo flujo PROGRAMADO (`ScheduleNew` → `Search` con `flow: 'quote'`) y callers no migrados.
 * El flujo NORMAL de pedir viaje vive ENTERO en el sheet de `RequestFlowScreen` (fase `quoting` =
 * `QuotingBody`); NO debe pasar por esta pantalla. No borrar todavía: el flujo programado la usa.
 *
 * Ruta + cotización. Con origen y destino fijados, llama AUTOMÁTICAMENTE a `/maps/quote` (incluyendo
 * las paradas intermedias), dibuja la polyline real y lista las categorías (precio PEN + ETA reales,
 * con distinción visual moto vs auto). Permite agregar paradas (máx 3) y programar el viaje para
 * después. Al confirmar, crea el viaje real (POST /trips) con `waypoints`, `vehicleType` y
 * `scheduledFor` según corresponda, y navega al seguimiento o muestra la confirmación de programado.
 */
export function RouteQuoteScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  // Alto real del panel flotante (medido por onLayout) para reservar ese espacio abajo al encuadrar
  // la ruta → el panel no la tapa. Memoizado para no romper el React.memo del mapa (sin re-fit en
  // cada render). Reservamos también arriba el área del botón de atrás + notch.
  const [panelHeight, setPanelHeight] = useState(0);
  const mapFitPadding = useMemo(
    () => ({
      top: insets.top + 56,
      bottom: panelHeight + 24,
      left: 48,
      right: 48,
    }),
    [insets.top, panelHeight],
  );

  const quoteRide = useDependency(TOKENS.quoteRideUseCase);
  const createTrip = useDependency(TOKENS.createTripUseCase);
  const history = useDependency(TOKENS.tripHistoryRepository);
  const defaultMethod = usePaymentPrefsStore(s => s.defaultMethod);
  const setDefaultMethod = usePaymentPrefsStore(s => s.setDefault);
  const yapeAutoActive = useIsYapeAutoActive();
  const childMode = useChildModeStore();

  const origin = useRideDraftStore(s => s.origin);
  const destination = useRideDraftStore(s => s.destination);
  const waypoints = useRideDraftStore(s => s.waypoints);
  const setEditing = useRideDraftStore(s => s.setEditing);
  const addWaypoint = useRideDraftStore(s => s.addWaypoint);
  const removeWaypoint = useRideDraftStore(s => s.removeWaypoint);
  const reset = useRideDraftStore(s => s.reset);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // Programación elegida (epoch ms) o null = viaje inmediato.
  const [scheduledAt, setScheduledAt] = useState<number | null>(null);
  // PUJA · oferta del pasajero en céntimos (null hasta que llega un quote PUJA y la inicializa).
  const [bidCents, setBidCents] = useState<number | null>(null);
  // PUJA · solicitudes especiales (mascota/equipaje/silla); el conductor las ve antes de aceptar (BE-2).
  const [specialRequests, setSpecialRequests] = useState<SpecialRequest[]>([]);
  // Método de pago PARA ESTE VIAJE: sembrado del default del perfil al montar (lazy). No pisa el default.
  const [tripPaymentMethod, setTripPaymentMethod] =
    useState<MobilePaymentMethod>(() => defaultMethod);
  const [paymentSheetOpen, setPaymentSheetOpen] = useState(false);

  const ready = Boolean(origin && destination);

  // Solo las paradas con dirección fijada cuentan para cotizar/crear (las vacías son marcadores UI).
  const setWaypoints = useMemo<RoutePlace[]>(
    () => waypoints.filter(isWaypointSet),
    [waypoints],
  );
  const quoteWaypoints = useMemo<MapPoint[]>(
    () => setWaypoints.map(stop => stop.point),
    [setWaypoints],
  );

  // Clave de cotización: incluye las paradas para refrescar al agregarlas/quitarlas.
  const waypointsKey = useMemo(
    () => quoteWaypoints.map(p => `${p.lat},${p.lng}`).join('|'),
    [quoteWaypoints],
  );

  // IK · key de idempotencia POR INTENTO de confirmación: estable mientras los parámetros no cambien
  // (un reintento tras red flaky / doble-submit dedupea server-side → MISMO viaje, no dos boards), y se
  // REGENERA si el pasajero cambia algo del pedido (bid, categoría, programación, paradas, chips) — un
  // intento distinto no debe heredar la key del anterior (devolvería el viaje viejo con el bid viejo).
  const idempotencyKey = useMemo(
    () => uuidv4(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- la key es función de ESTOS parámetros del pedido
    [bidCents, selectedId, scheduledAt, waypointsKey, specialRequests],
  );

  const quoteQuery = useQuery({
    queryKey: [
      'maps',
      'quote',
      origin?.point.lat,
      origin?.point.lng,
      destination?.point.lat,
      destination?.point.lng,
      waypointsKey,
    ],
    queryFn: () =>
      quoteRide.execute({
        origin: origin!.point,
        destination: destination!.point,
        ...(quoteWaypoints.length > 0 ? {waypoints: quoteWaypoints} : {}),
      }),
    enabled: ready,
    staleTime: 60_000,
  });

  // Selecciona por defecto la primera opción (la más económica) cuando llega la cotización.
  useEffect(() => {
    const first = quoteQuery.data?.options[0];
    if (first && !selectedId) {
      setSelectedId(first.id);
    }
  }, [quoteQuery.data, selectedId]);

  // UI REACTIVA (server-driven): el selector se muestra SIEMPRE; el panel de abajo (puja vs precio fijo)
  // y el bid dependen de la oferta ELEGIDA, no de un modo global. La app refleja, no decide.
  const quote = quoteQuery.data;
  const selectedOption = useMemo(
    () => quote?.options.find(option => option.id === selectedId) ?? null,
    [quote, selectedId],
  );
  // Modo EFECTIVO de la oferta elegida (ADR 013 §1.3; fallback al top-level del quote). Predicado de
  // dominio — sin string mágico (§4-ter).
  const selectedIsPuja = isPujaMode(selectedOption?.mode ?? quote?.mode);
  // Piso + sugerido PER-OFERTA (A2): cada oferta PUJA trae lo suyo; fallback al top-level (server viejo).
  const selectedBidFloorCents =
    selectedOption?.bidFloorCents ?? quote?.bidFloorCents ?? 0;
  const selectedSuggestedCents =
    selectedOption?.suggestedCents ?? quote?.suggestedCents;

  // Re-ancla el bid al sugerido de la oferta ELEGIDA: cambia al cambiar la ruta (nueva tarifa) O al
  // cambiar de oferta (Moto→Económico tienen sugeridos distintos), preservando ajustes manuales mientras
  // la oferta y la ruta no cambien (mismo patrón que QuotingBody — coherencia entre las dos superficies).
  const lastSuggestedRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!selectedIsPuja || !selectedOption) return;
    if (selectedSuggestedCents !== lastSuggestedRef.current) {
      lastSuggestedRef.current = selectedSuggestedCents;
      setBidCents(
        initialBidCents(selectedSuggestedCents, selectedBidFloorCents),
      );
    }
  }, [
    selectedIsPuja,
    selectedOption,
    selectedSuggestedCents,
    selectedBidFloorCents,
  ]);

  const decrementBid = useCallback(
    () =>
      setBidCents(b =>
        stepBidCents(b ?? selectedBidFloorCents, -1, selectedBidFloorCents),
      ),
    [selectedBidFloorCents],
  );
  const incrementBid = useCallback(
    () =>
      setBidCents(b =>
        stepBidCents(b ?? selectedBidFloorCents, 1, selectedBidFloorCents),
      ),
    [selectedBidFloorCents],
  );

  const routeCoordinates = useMemo<[number, number][] | undefined>(() => {
    const geometry = quoteQuery.data?.geometry;
    return geometry ? (geometry.coordinates as [number, number][]) : undefined;
  }, [quoteQuery.data]);

  const selectedFareCents = selectedOption?.priceCents ?? 0;

  // El cupón se valida contra la tarifa de la categoría elegida; si cambia la categoría, el descuento
  // previsualizado ya no es fiable: se descarta y el pasajero lo re-aplica sobre la nueva tarifa.
  const selectChanged = (id: string): void => {
    if (id !== selectedId) {
      setAppliedPromo(null);
    }
    setSelectedId(id);
  };

  // Navega al buscador para fijar/editar un punto del trayecto.
  const editOrigin = useCallback(() => {
    setEditing({kind: 'origin'});
    navigation.navigate('Search');
  }, [navigation, setEditing]);
  const editDestination = useCallback(() => {
    setEditing({kind: 'destination'});
    navigation.navigate('Search');
  }, [navigation, setEditing]);
  const editWaypoint = useCallback(
    (index: number) => {
      setEditing({kind: 'waypoint', index});
      navigation.navigate('Search');
    },
    [navigation, setEditing],
  );
  const onAddWaypoint = useCallback(() => {
    addWaypoint();
    navigation.navigate('Search');
  }, [addWaypoint, navigation]);

  const createMutation = useMutation({
    mutationFn: () =>
      createTrip.execute(
        buildCreateTripInput({
          origin: toGeoPoint(origin!.point),
          destination: toGeoPoint(destination!.point),
          paymentMethod: tripPaymentMethod,
          selectedId,
          selectedOption,
          selectedIsPuja,
          bidCents,
          specialRequests,
          waypoints: setWaypoints.map(stop => toGeoPoint(stop.point)),
          scheduledAt,
          promoCode: appliedPromo?.code ?? null,
          childMode: {enabled: childMode.enabled, code: childMode.code},
        }),
        // IK · una key por intento: el reintento dedupea server-side (no crea dos boards).
        idempotencyKey,
      ),
    onSuccess: trip => {
      history.record(trip);
      childMode.reset();
      const wasScheduled = scheduledAt !== null;
      reset();
      if (wasScheduled) {
        // Viaje programado: no entra a dispatch ahora; lleva al listado de programados.
        navigation.navigate('ScheduledTrips');
        return;
      }
      // El SERVIDOR resolvió el modo (autoritativo en `trip.dispatchMode`): si es PUJA, al board de
      // ofertas; si es FIXED, al seguimiento. Usar el modo del viaje (no el del quote) reconcilia un flip
      // de política entre cotizar y crear.
      if (isPujaMode(trip.dispatchMode)) {
        navigation.navigate('OffersBoard', {tripId: trip.id});
        return;
      }
      navigation.navigate('TripActive', {tripId: trip.id});
    },
    onError: error => {
      // Residual defensivo (ADR-018): el muro pre-viaje se retiró — el BFF ya NO devuelve 403 KYC_REQUIRED
      // al crear un viaje, así que esta rama es hoy inalcanzable. Se conserva como reflejo del contrato en
      // esta pantalla LEGACY (solo flujo programado): si el server reintrodujera el gate, la UI ya deriva a
      // la verificación sin cambiar código. No es un gate proactivo (la verificación es opcional, desde Perfil).
      if (isKycRequiredError(error)) {
        navigation.navigate('KycCamera');
      }
    },
  });

  const options = quoteQuery.data?.options ?? [];
  const canConfirm =
    !createMutation.isPending &&
    ready &&
    Boolean(selectedId) &&
    (selectedIsPuja
      ? bidCents !== null && bidCents >= selectedBidFloorCents
      : true);

  const formatEta = (option: QuoteOption): string =>
    t('trip.etaMinutes', {minutes: formatDurationMinutes(option.etaSeconds)});

  // Subtítulo de la opción: etiqueta del tipo de vehículo (del registro de glyphs, ADR 013 §1.6)
  // y, en la más barata, el sello.
  const optionDescription = (
    option: QuoteOption,
    cheapest: boolean,
  ): string => {
    const vehicle = t(offeringGlyph(option).vehicleLabelKey);
    return cheapest ? `${vehicle} · ${t('quote.cheapest')}` : vehicle;
  };

  const confirmLabel = createMutation.isPending
    ? t('quote.requesting')
    : scheduledAt !== null
      ? t('schedule.confirm')
      : selectedIsPuja && bidCents !== null
        ? t('puja.searchDriver', {price: formatPEN(bidCents)})
        : t('quote.confirm');

  return (
    <View style={[styles.root, {backgroundColor: theme.colors.bg}]}>
      {/* Barra de estado oscura sobre el mapa claro (veoLightStyle) full-bleed. */}
      <StatusBar
        barStyle="dark-content"
        backgroundColor="transparent"
        translucent
      />

      {/* MAPA FULL-BLEED: ocupa toda la pantalla (también bajo la barra de estado), inmersivo. El
          panel inferior y el botón de atrás FLOTAN encima → el mapa se ve a través de las esquinas
          redondeadas del panel. */}
      <View style={StyleSheet.absoluteFill}>
        <AppMap
          origin={origin ? toGeoPoint(origin.point) : null}
          destination={destination ? toGeoPoint(destination.point) : null}
          waypoints={setWaypoints.map(stop => toGeoPoint(stop.point))}
          routeCoordinates={routeCoordinates}
          fitToRoute={Boolean(routeCoordinates)}
          fitEdgePadding={mapFitPadding}
          interactive={false}
        />
      </View>

      <View
        style={[
          styles.backButton,
          {top: insets.top + theme.spacing.sm, left: theme.spacing.lg},
        ]}>
        <IconButton
          accessibilityLabel={t('actions.back')}
          variant="surface"
          onPress={() => navigation.goBack()}
          icon={<IconArrowLeft color={theme.colors.ink} size={22} />}
        />
      </View>

      <View
        onLayout={e => setPanelHeight(e.nativeEvent.layout.height)}
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radii.xl,
            borderTopRightRadius: theme.radii.xl,
            borderColor: theme.colors.border,
            paddingBottom: insets.bottom + theme.spacing.md,
          },
        ]}>
        <View
          style={[styles.grabber, {backgroundColor: theme.colors.borderStrong}]}
        />

        <ScrollView
          style={styles.optionsScroll}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.sm,
            gap: theme.spacing.md,
          }}
          showsVerticalScrollIndicator={false}>
          {/* Trayecto editable: origen → paradas → destino (+ agregar parada). */}
          <RoutePointsList
            origin={origin}
            destination={destination}
            waypoints={waypoints}
            onEditOrigin={editOrigin}
            onEditDestination={editDestination}
            onEditWaypoint={editWaypoint}
            onRemoveWaypoint={removeWaypoint}
            onAddWaypoint={onAddWaypoint}
          />

          <View style={[styles.titleRow]}>
            <Text variant="title3">{t('quote.title')}</Text>
            {quoteQuery.data ? (
              <Text variant="footnote" color="inkMuted" tabular>
                {formatDistance(quoteQuery.data.distanceMeters)} ·{' '}
                {t('trip.etaMinutes', {
                  minutes: formatDurationMinutes(
                    quoteQuery.data.durationSeconds,
                  ),
                })}
              </Text>
            ) : null}
          </View>

          {quoteQuery.isError ? (
            <Banner
              tone="danger"
              title={t('quote.error')}
              action={{
                label: t('actions.retry'),
                onPress: () => quoteQuery.refetch(),
              }}
            />
          ) : null}

          {quoteQuery.isLoading ||
          (ready && !quoteQuery.data && !quoteQuery.isError) ? (
            <View style={{gap: theme.spacing.sm}}>
              <Skeleton variant="rect" height={64} />
              <Skeleton variant="rect" height={64} />
              <Skeleton variant="rect" height={64} />
              <Text
                variant="footnote"
                color="inkSubtle"
                align="center"
                style={{marginTop: theme.spacing.sm}}>
                {t('quote.calculating')}
              </Text>
            </View>
          ) : (
            // UI REACTIVA (igual que QuotingBody): el selector se muestra SIEMPRE; debajo de la oferta
            // elegida, si resuelve PUJA → panel de oferta (piso/sugerido PROPIOS); si es FIJO → el precio
            // firme está en la fila. Así el flujo programado TAMBIÉN puede pujar una Moto.
            <View style={{gap: theme.spacing.sm}}>
              {options.map((option, index) => (
                <SelectionBump
                  key={option.id}
                  index={index}
                  selected={option.id === selectedId}>
                  <RideOptionRow
                    name={offeringDisplayName(option)}
                    price={formatPEN(option.priceCents)}
                    eta={formatEta(option)}
                    description={optionDescription(option, index === 0)}
                    icon={
                      <VehicleIcon
                        icon={option.icon}
                        vehicleType={option.vehicleType}
                      />
                    }
                    selected={option.id === selectedId}
                    onPress={() => selectChanged(option.id)}
                  />
                </SelectionBump>
              ))}

              {selectedIsPuja && selectedOption && bidCents !== null ? (
                <View
                  style={{gap: theme.spacing.lg, marginTop: theme.spacing.xs}}>
                  <BidPanel
                    bidCents={bidCents}
                    suggestedCents={selectedSuggestedCents}
                    floorCents={selectedBidFloorCents}
                    onDecrement={decrementBid}
                    onIncrement={incrementBid}
                  />
                  <SpecialRequestChips
                    value={specialRequests}
                    onChange={setSpecialRequests}
                  />
                </View>
              ) : null}
            </View>
          )}
        </ScrollView>

        <View
          style={{
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.md,
            gap: theme.spacing.sm,
          }}>
          {/* Resumen de programación o atajo para programar. */}
          {scheduledAt !== null ? (
            <View style={styles.scheduleRow}>
              <StatusPill
                label={t('schedule.scheduledFor', {
                  when: formatDateTime(new Date(scheduledAt).toISOString()),
                })}
                tone="brand"
                dot
              />
              <Button
                label={t('schedule.now')}
                variant="ghost"
                size="sm"
                onPress={() => setScheduledAt(null)}
              />
            </View>
          ) : (
            <Button
              label={t('schedule.cta')}
              variant="secondary"
              fullWidth
              disabled={!ready}
              onPress={() => setScheduleOpen(true)}
            />
          )}

          {selectedOption ? (
            <PromoField
              fareCents={
                selectedIsPuja && bidCents !== null
                  ? bidCents
                  : selectedFareCents
              }
              applied={appliedPromo}
              onApplied={setAppliedPromo}
              onCleared={() => setAppliedPromo(null)}
            />
          ) : null}
          {createMutation.isError ? (
            <Banner
              tone="danger"
              title={
                isKycRequiredError(createMutation.error)
                  ? t('quote.kycRequired')
                  : t('home.quoteError')
              }
            />
          ) : null}
          {/* Método de pago PARA ESTE VIAJE (antes del CTA): refleja la selección y abre el selector. */}
          {ready ? (
            <PaymentMethodRow
              method={tripPaymentMethod}
              onPress={() => setPaymentSheetOpen(true)}
              disabled={createMutation.isPending}
              autoActive={yapeAutoActive}
            />
          ) : null}
          <Button
            label={confirmLabel}
            variant="primary"
            fullWidth
            loading={createMutation.isPending}
            disabled={!canConfirm}
            onPress={() => createMutation.mutate()}
          />
          {!selectedId &&
          options.length === 0 &&
          !quoteQuery.isLoading ? null : !selectedId ? (
            <Text
              variant="footnote"
              color="inkSubtle"
              align="center"
              style={{marginTop: theme.spacing.sm}}>
              {t('quote.selectOption')}
            </Text>
          ) : null}
        </View>
      </View>

      <PaymentMethodSheet
        visible={paymentSheetOpen}
        selected={tripPaymentMethod}
        defaultMethod={defaultMethod}
        yapeAutoActive={yapeAutoActive}
        onClose={() => setPaymentSheetOpen(false)}
        onSelect={(method, remember) => {
          // Aplica a este viaje; solo si el usuario marcó "recordar", asciende a predeterminado.
          setTripPaymentMethod(method);
          if (remember) {
            setDefaultMethod(method);
          }
          setPaymentSheetOpen(false);
        }}
      />

      <ScheduleSheet
        visible={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        onConfirm={epochMs => {
          setScheduledAt(epochMs);
          setScheduleOpen(false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  backButton: {position: 'absolute'},
  // Panel FLOTANTE sobre el mapa full-bleed: anclado abajo, ocupa el ancho y deja ver el mapa a
  // través de las esquinas superiores redondeadas.
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    maxHeight: '64%',
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    marginBottom: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  optionsScroll: {flexGrow: 0},
  scheduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
});
