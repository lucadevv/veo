import type {
  GeoPoint,
  MapPoint,
  MobilePaymentMethod,
  QuoteOption,
  SpecialRequest,
  TripResource,
} from '@veo/api-client';
import {
  activeTripIdFromError,
  isActiveTripExistsError,
  isDebtPendingError,
  isKycRequiredError,
  isOfferingUnavailableError,
} from '@veo/api-client';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useMutation, useQuery} from '@tanstack/react-query';
import {
  Banner,
  Button,
  hexAlpha,
  RideOptionRow,
  Skeleton,
  StatusPill,
  Text,
  useTheme,
} from '@veo/ui-kit';
import {CHILD_MODE_FEE_CENTS, isFixedMode, isPujaMode} from '@veo/shared-types';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import type {RootStackParamList} from '../../../../navigation/types';
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
import {ScheduleSheet} from './ScheduleSheet';
import {initialBidCents, stepBidCents} from '../../../../shared/utils/bid';
import {uuidv4} from '../../../../shared/utils/uuid';
import {isWaypointSet, type RoutePlace} from '../../../maps/domain/entities';
import {buildCreateTripInput} from '../../domain/buildCreateTripInput';
import {BidPanel} from '../../../../shared/presentation/components/BidPanel';
import {
  offeringDisplayName,
  offeringGlyph,
} from '../../../../shared/presentation/components/offeringGlyphs';
import {IconArrowRight, IconBolt} from './icons';
import {RoutePointsList} from '../../../maps/presentation/components/RoutePointsList';
import {SpecialRequestChips} from '../../../maps/presentation/components/SpecialRequestChips';
import {VehicleIcon} from '../../../maps/presentation/components/VehicleIcon';
import {SelectionBump} from '../../../maps/presentation/components/motion';
import {useRideDraftStore} from '../../../maps/presentation/stores/rideDraftStore';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Convierte el punto de la API de mapas (lng) al `GeoPoint` de dominio (lon). */
function toGeoPoint(point: MapPoint): GeoPoint {
  return {lat: point.lat, lon: point.lng};
}

export interface QuotingBodyProps {
  /** El viaje se creó (POST /trips OK): la pantalla decide qué hacer (reaccionar a la fase / navegar). */
  onTripCreated: (trip: TripResource) => void;
  /** Viaje PROGRAMADO creado (no entra a dispatch ahora). */
  onScheduled: () => void;
  /**
   * Defensa server-side residual (ADR-018): si el BFF alguna vez devolviera 403 KYC_REQUIRED, la pantalla
   * deriva a la verificación. El muro pre-viaje se retiró (el pasajero `unverified` YA puede pedir); esto
   * queda solo como reflejo del contrato, no como gate proactivo.
   */
  onKycRequired: () => void;
  /**
   * El BFF bloqueó crear porque el pasajero tiene una DEUDA pendiente (403 `DEBT_PENDING`). En vez de un
   * error genérico, la pantalla abre el `DebtSheet` para saldar y volver a pedir. El gate es server-side
   * (la app solo lo refleja).
   */
  onDebtPending: () => void;
  /**
   * El BFF rechazó crear porque el pasajero YA tiene un viaje vivo (409 ACTIVE_TRIP_EXISTS). La
   * pantalla re-entra a ESE viaje (rehidrata el sheet con el id) en vez de mostrar un error.
   */
  onActiveTripExists: (activeTripId: string) => void;
  /** Geometría de la ruta del quote (para que el AppMap persistente la dibuje). [] = sin ruta. */
  onRouteChange: (coordinates: [number, number][]) => void;
  /**
   * Señal para RE-INTENTAR el pedido solo (sin que el pasajero vuelva a tocar "Confirmar"): cada vez que
   * este número CAMBIA (y hay datos para crear), se re-dispara el create. Lo usa el flujo de deuda: tras
   * SALDAR en el `DebtSheet`, la pantalla incrementa el token y el viaje se pide de nuevo automáticamente.
   * El `undefined`/valor inicial NO dispara nada (solo los cambios posteriores).
   */
  requestAgainToken?: number;
}

/**
 * Cuerpo "cotización / PUJA" del sheet unificado (fase `quoting`). Encapsula TODA la lógica del pedido
 * —quote real, oferta PUJA (BidPanel) o categorías FIXED, solicitudes especiales, programar, promo,
 * modo niño, crear viaje (idempotente)— SIN mapa ni chrome (los aporta la pantalla unificada sobre el
 * mapa persistente). Reporta la ruta por `onRouteChange` y el resultado por callbacks (no navega).
 */
export function QuotingBody({
  onTripCreated,
  onScheduled,
  onKycRequired,
  onDebtPending,
  onActiveTripExists,
  onRouteChange,
  requestAgainToken,
}: QuotingBodyProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();

  const quoteRide = useDependency(TOKENS.quoteRideUseCase);
  const createTrip = useDependency(TOKENS.createTripUseCase);
  const defaultMethod = usePaymentPrefsStore(s => s.defaultMethod);
  // Para que el toggle "Recordar como predeterminado" del selector pueda ascender la elección de ESTE
  // viaje a predeterminado del perfil (TASK 2). No se toca salvo que el usuario lo pida explícitamente.
  const setDefaultMethod = usePaymentPrefsStore(s => s.setDefault);
  const childMode = useChildModeStore();

  const origin = useRideDraftStore(s => s.origin);
  const destination = useRideDraftStore(s => s.destination);
  const waypoints = useRideDraftStore(s => s.waypoints);
  const setEditing = useRideDraftStore(s => s.setEditing);
  const addWaypoint = useRideDraftStore(s => s.addWaypoint);
  const removeWaypoint = useRideDraftStore(s => s.removeWaypoint);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<number | null>(null);
  const [bidCents, setBidCents] = useState<number | null>(null);
  const [specialRequests, setSpecialRequests] = useState<SpecialRequest[]>([]);
  // Método de pago PARA ESTE VIAJE: se siembra del default del perfil al montar (lazy init) y vive en
  // el quoting. Elegir otro acá NO pisa el default del perfil (ese se cambia en PaymentMethodsScreen).
  const [tripPaymentMethod, setTripPaymentMethod] =
    useState<MobilePaymentMethod>(() => defaultMethod);
  const [paymentSheetOpen, setPaymentSheetOpen] = useState(false);
  // ¿El cobro automático con Yape está activo? Solo para REFLEJAR una señal sutil en la fila (la app no
  // decide el cobro: es server-side). El query comparte caché con la card del perfil (sin doble fetch).
  const yapeAutoActive = useIsYapeAutoActive();

  const ready = Boolean(origin && destination);

  const setWaypoints = useMemo<RoutePlace[]>(
    () => waypoints.filter(isWaypointSet),
    [waypoints],
  );
  const quoteWaypoints = useMemo<MapPoint[]>(
    () => setWaypoints.map(stop => stop.point),
    [setWaypoints],
  );
  const waypointsKey = useMemo(
    () => quoteWaypoints.map(p => `${p.lat},${p.lng}`).join('|'),
    [quoteWaypoints],
  );

  // IK · key de idempotencia por intento (se regenera al cambiar parámetros del pedido).
  const idempotencyKey = useMemo(
    () => uuidv4(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- función de estos parámetros del pedido
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

  // Selecciona la primera oferta al llegar el quote, Y RE-SELECCIONA si la elegida ya no está en la lista
  // (re-quote que devuelve menos ofertas, o el admin apagó la elegida → B1c la filtra). Sin esta segunda
  // rama, `selectedId` quedaría stale (apuntando a una oferta inexistente) → `selectedOption` null →
  // createTrip mandaría una category apagada → 409 OFFERING_UNAVAILABLE en loop. Acá se auto-corrige.
  useEffect(() => {
    const options = quoteQuery.data?.options ?? [];
    const first = options[0];
    if (!first) return;
    const stillValid =
      selectedId !== null && options.some(o => o.id === selectedId);
    if (!stillValid) {
      setSelectedId(first.id);
      setAppliedPromo(null); // la selección cambió → el cupón previsualizado ya no es fiable
    }
  }, [quoteQuery.data, selectedId]);

  const quote = quoteQuery.data;
  // Oferta seleccionada: la UI REACTIVA se proyecta de ELLA, no de un modo global. El selector se muestra
  // SIEMPRE; el panel de abajo (puja vs precio fijo) y el bid dependen de la oferta elegida (server-driven).
  const selectedOption = useMemo(
    () => quote?.options.find(option => option.id === selectedId) ?? null,
    [quote, selectedId],
  );
  // Modo EFECTIVO de la oferta elegida (ADR 013 §1.3: el modo POR oferta; fallback al top-level del quote
  // para server viejo). Predicados de DOMINIO — sin string mágico (§4-ter).
  const selectedIsPuja = isPujaMode(selectedOption?.mode ?? quote?.mode);
  const selectedIsFixed = isFixedMode(selectedOption?.mode ?? quote?.mode);
  // Piso + sugerido PER-OFERTA (A2): cada oferta PUJA trae lo suyo; fallback al top-level (server viejo).
  const selectedBidFloorCents =
    selectedOption?.bidFloorCents ?? quote?.bidFloorCents ?? 0;
  const selectedSuggestedCents =
    selectedOption?.suggestedCents ?? quote?.suggestedCents;

  // Re-ancla el bid cuando cambia el sugerido de la oferta ELEGIDA: al cambiar la RUTA (agregar/quitar
  // parada → nueva tarifa) O al cambiar de oferta (Moto→Económico tienen sugeridos distintos), el precio
  // OFRECIDO sigue al nuevo sugerido en vez de quedar clavado. Se re-ancla SOLO cuando cambia
  // `selectedSuggestedCents`, preservando los ajustes manuales mientras la oferta y la ruta no cambien.
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

  // Reporta la ruta del quote al mapa persistente (la dibuja el AppMap de la pantalla unificada).
  const routeCoordinates = useMemo<[number, number][]>(() => {
    const geometry = quoteQuery.data?.geometry;
    return geometry ? (geometry.coordinates as [number, number][]) : [];
  }, [quoteQuery.data]);
  useEffect(() => {
    onRouteChange(routeCoordinates);
  }, [routeCoordinates, onRouteChange]);

  const selectedFareCents = selectedOption?.priceCents ?? 0;
  // DEUDA: (backend) el recargo de modo niño (CHILD_MODE_FEE_CENTS local) se muestra como monto real DENTRO de la cotización (camino de cobro) — 2da superficie de la misma deuda de ChildModeScreen: pedir el fee server-driven.
  // El recargo de modo niño aplica SOLO en FIJO (en PUJA el bid ES el precio): decide si mostrar el desglose.
  const showChildFee =
    childMode.enabled && Boolean(selectedOption) && selectedIsFixed;
  const childTotalCents = selectedFareCents + CHILD_MODE_FEE_CENTS;

  // Lote C3 · PREVIEW del crédito de referido, SOLO en FIJO (en PUJA el precio es el bid, no `priceCents`).
  // `creditAppliedCents` lo computó el SERVER (min(saldo, priceCents), §INTEGRACIONES); acá solo se MUESTRA.
  // El "pagás" suma figuras server/constantes (tarifa + recargo − crédito): es un PREVIEW, el recibo
  // muestra el aplicado real al cobrar (si hay promo, el crédito real puede ser menor).
  const selectedCreditCents = selectedIsFixed
    ? (selectedOption?.creditAppliedCents ?? 0)
    : 0;
  const payableAfterCreditCents = Math.max(
    0,
    (showChildFee ? childTotalCents : selectedFareCents) - selectedCreditCents,
  );

  const selectChanged = (id: string): void => {
    if (id !== selectedId) {
      setAppliedPromo(null);
    }
    setSelectedId(id);
  };

  // Editar un punto del trayecto: abre la búsqueda dedicada (Search) para fijar/editar ese extremo.
  // `flow: 'sheet'` → al fijar, Search hace goBack y VOLVEMOS a esta cotización in-sheet. El borrador
  // (Zustand) ya quedó actualizado, así que el quote se recalcula.
  const editOrigin = useCallback(() => {
    setEditing({kind: 'origin'});
    navigation.navigate('Search', {flow: 'sheet'});
  }, [navigation, setEditing]);
  const editDestination = useCallback(() => {
    setEditing({kind: 'destination'});
    navigation.navigate('Search', {flow: 'sheet'});
  }, [navigation, setEditing]);
  const editWaypoint = useCallback(
    (index: number) => {
      setEditing({kind: 'waypoint', index});
      navigation.navigate('Search', {flow: 'sheet'});
    },
    [navigation, setEditing],
  );
  const onAddWaypoint = useCallback(() => {
    addWaypoint();
    navigation.navigate('Search', {flow: 'sheet'});
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
        idempotencyKey,
      ),
    onSuccess: trip => {
      childMode.reset();
      if (scheduledAt !== null) {
        onScheduled();
        return;
      }
      onTripCreated(trip);
    },
    onError: error => {
      if (isKycRequiredError(error)) {
        onKycRequired();
        return;
      }
      // 403 DEBT_PENDING: el pasajero tiene una deuda y NO puede pedir. En vez de un error genérico,
      // la pantalla abre el DebtSheet (saldar → volver a pedir). Gate server-side; la app lo refleja.
      if (isDebtPendingError(error)) {
        onDebtPending();
        return;
      }
      // 409 "ya tenés un viaje en curso": en vez de un error, re-entramos a ESE viaje (la UI refleja
      // el gate server-side). El id viene en los details del 409.
      const activeTripId = activeTripIdFromError(error);
      if (activeTripId) {
        onActiveTripExists(activeTripId);
        return;
      }
      // 409 OFFERING_UNAVAILABLE (ADR 013 · Fase B): el admin apagó la oferta entre el quote y el create.
      // Refrescamos el quote → la oferta apagada desaparece de la lista (B1c filtra por enabled); el banner
      // de abajo muestra el mensaje claro. La UI refleja el catálogo del backend, no decide.
      if (isOfferingUnavailableError(error)) {
        void quoteQuery.refetch();
      }
    },
  });

  const options = quoteQuery.data?.options ?? [];
  // "Más barato" va en la opción de MENOR precio firme, no en la primera: el server no garantiza
  // orden por precio, así que `index === 0` etiquetaba mal (bug). PUJA no tiene precio firme → se excluye.
  const cheapestFixedId =
    options
      .filter((o) => !isPujaMode(o.mode ?? quote?.mode))
      .reduce<(typeof options)[number] | null>(
        (min, o) => (min === null || o.priceCents < min.priceCents ? o : min),
        null,
      )?.id ?? null;
  const canConfirm =
    !createMutation.isPending &&
    ready &&
    Boolean(selectedId) &&
    (selectedIsPuja
      ? bidCents !== null && bidCents >= selectedBidFloorCents
      : true);

  // RE-INTENTO automático tras saldar la deuda: cuando el token cambia (no en el primer render), re-dispara
  // el create solo si hay datos válidos y no hay otro pedido en vuelo. El `createMutation` se referencia por
  // su forma estable (mutate/isPending) — no lo metemos en deps para no re-disparar por cada render de RQ.
  const lastRequestTokenRef = useRef<number | undefined>(requestAgainToken);
  useEffect(() => {
    if (requestAgainToken === lastRequestTokenRef.current) {
      return;
    }
    lastRequestTokenRef.current = requestAgainToken;
    if (requestAgainToken !== undefined && canConfirm) {
      createMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dispara SOLO ante el cambio del token
  }, [requestAgainToken]);

  const formatEta = (option: QuoteOption): string =>
    t('trip.etaMinutes', {minutes: formatDurationMinutes(option.etaSeconds)});

  // Subtítulo de la opción: etiqueta del tipo de vehículo (del registro de glyphs, ADR 013 §1.6).
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
    <View style={{gap: theme.spacing.md}}>
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

      <View style={styles.titleRow}>
        <Text variant="title3">{t('quote.title')}</Text>
        {quoteQuery.data ? (
          <Text variant="footnote" color="inkMuted" tabular>
            {formatDistance(quoteQuery.data.distanceMeters)} ·{' '}
            {t('trip.etaMinutes', {
              minutes: formatDurationMinutes(quoteQuery.data.durationSeconds),
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
        // UI REACTIVA (server-driven): el selector de ofertas se muestra SIEMPRE (elegís Moto/Eco/Confort/
        // XL en cualquier modo). Debajo de la elegida aparece el panel que CORRESPONDE A SU modo: si la
        // oferta resuelve PUJA → proponés tu precio (piso/sugerido PROPIOS de la oferta); si es FIJO → el
        // precio firme ya está en la fila y el desglose va más abajo. Nada de un modo global que decide todo.
        <View style={{gap: theme.spacing.sm}}>
          {options.map((option, index) => {
            const optionIsPuja = isPujaMode(option.mode ?? quote?.mode);
            const isSelected = option.id === selectedId;
            return (
              <SelectionBump
                key={option.id}
                index={index}
                selected={isSelected}>
                {optionIsPuja && !isSelected ? (
                  // Per pen qAT2P: la oferta PUJA sin seleccionar se presenta como la card
                  // affordance "Pon tu precio" (no una fila con precio firme que no existe).
                  // Tocarla la selecciona → el BidPanel se abre debajo (misma máquina de selección).
                  <PujaOptionCard onPress={() => selectChanged(option.id)} />
                ) : (
                  <RideOptionRow
                    name={offeringDisplayName(option)}
                    price={formatPEN(option.priceCents)}
                    eta={formatEta(option)}
                    description={optionDescription(
                      option,
                      option.id === cheapestFixedId,
                    )}
                    icon={
                      <VehicleIcon
                        icon={option.icon}
                        vehicleType={option.vehicleType}
                      />
                    }
                    selected={isSelected}
                    onPress={() => selectChanged(option.id)}
                  />
                )}
              </SelectionBump>
            );
          })}

          {selectedIsPuja && selectedOption && bidCents !== null ? (
            <View style={{gap: theme.spacing.lg, marginTop: theme.spacing.xs}}>
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

      {/* Transparencia del recargo Modo Niño (BR-T07): SOLO en precio FIJO se suma S/2.00 (en PUJA el
          bid ES el precio, sin recargo). Se muestra ANTES de confirmar para que el total no sorprenda.
          El monto sale de la constante compartida (@veo/shared-types), misma fuente que el server. */}
      {showChildFee ? (
        <View
          style={[
            styles.feeBreakdown,
            {borderTopColor: theme.colors.border, gap: theme.spacing.xs},
          ]}>
          <View style={styles.feeRow}>
            <Text variant="footnote" color="inkMuted">
              {t('childMode.feeLine')}
            </Text>
            <Text variant="footnote" color="inkMuted" tabular>
              +{formatPEN(CHILD_MODE_FEE_CENTS)}
            </Text>
          </View>
          <View style={styles.feeRow}>
            <Text variant="subhead">{t('quote.total')}</Text>
            <Text variant="subhead" tabular>
              {formatPEN(childTotalCents)}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Lote C3 · PREVIEW del crédito de referido (solo FIJO): el descuento que se aplicará y lo que
          pagás. `creditAppliedCents` es server-computed; el recibo confirma el aplicado REAL al cobrar. */}
      {selectedCreditCents > 0 ? (
        <View
          style={[
            styles.feeBreakdown,
            {borderTopColor: theme.colors.border, gap: theme.spacing.xs},
          ]}>
          <View style={styles.feeRow}>
            <Text variant="footnote" color="inkMuted">
              {t('quote.referralCredit')}
            </Text>
            <Text variant="footnote" color="inkMuted" tabular>
              −{formatPEN(selectedCreditCents)}
            </Text>
          </View>
          <View style={styles.feeRow}>
            <Text variant="subhead">{t('quote.youPay')}</Text>
            <Text variant="subhead" tabular>
              {formatPEN(payableAfterCreditCents)}
            </Text>
          </View>
        </View>
      ) : null}

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
            selectedIsPuja && bidCents !== null ? bidCents : selectedFareCents
          }
          applied={appliedPromo}
          onApplied={setAppliedPromo}
          onCleared={() => setAppliedPromo(null)}
        />
      ) : null}

      {/* El 409 "ya tenés un viaje en curso" y el 403 de deuda NO son errores a mostrar acá: el primero
          re-entra al viaje (onActiveTripExists), el segundo abre el DebtSheet (onDebtPending). */}
      {createMutation.isError &&
      !isActiveTripExistsError(createMutation.error) &&
      !isDebtPendingError(createMutation.error) ? (
        <Banner
          tone="danger"
          title={
            isKycRequiredError(createMutation.error)
              ? t('quote.kycRequired')
              : isOfferingUnavailableError(createMutation.error)
                ? t('quote.offeringUnavailable')
                : t('home.quoteError')
          }
        />
      ) : null}

      {/* Método de pago PARA ESTE VIAJE (antes del CTA): refleja la selección actual y abre el selector.
          La elección viaja al conductor en la puja y define el cobro automático al completar. */}
      {ready ? (
        <PaymentMethodRow
          method={tripPaymentMethod}
          onPress={() => setPaymentSheetOpen(true)}
          disabled={createMutation.isPending}
          autoActive={yapeAutoActive}
        />
      ) : null}

      {/* CTA de pedido (ADR-018): sin muro de KYC. El pasajero `unverified` pide directo; el botón sigue
          gateado solo por `canConfirm` (ruta lista + oferta/puja válida). */}
      <Button
        label={confirmLabel}
        variant="primary"
        fullWidth
        loading={createMutation.isPending}
        disabled={!canConfirm}
        onPress={() => createMutation.mutate()}
      />

      <PaymentMethodSheet
        visible={paymentSheetOpen}
        selected={tripPaymentMethod}
        defaultMethod={defaultMethod}
        yapeAutoActive={yapeAutoActive}
        onClose={() => setPaymentSheetOpen(false)}
        onSelect={(method, remember) => {
          // SIEMPRE: aplica a este viaje (tripPaymentMethod). Solo si el usuario marcó "recordar",
          // además asciende a predeterminado del perfil (no pisamos su preferencia en silencio).
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

interface PujaOptionCardProps {
  onPress: () => void;
}

/**
 * Card affordance de la PUJA sin seleccionar (design/veo.pen qAT2P "Poné tu precio"): la oferta en modo
 * puja no tiene precio firme que mostrar en una fila, así que se presenta como invitación a negociar
 * (rayo + "Pon tu precio" + acción "Ofrecer"). Tocarla la selecciona y el BidPanel se abre debajo —
 * misma máquina de selección que las filas fijas, solo cambia la piel.
 */
function PujaOptionCard({onPress}: PujaOptionCardProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t('puja.affordanceTitle')}. ${t('puja.affordanceSub')}`}
      onPress={onPress}
      style={({pressed}) => [
        styles.pujaCard,
        {
          backgroundColor: pressed
            ? theme.colors.surfaceElevated
            : theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.md,
          gap: theme.spacing.lg,
        },
      ]}>
      <View
        style={[
          styles.pujaGlyph,
          {backgroundColor: hexAlpha(theme.colors.brand, 0.15)},
        ]}>
        <IconBolt color={theme.colors.brand} size={20} />
      </View>
      <View style={styles.pujaBody}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {t('puja.affordanceTitle')}
        </Text>
        <Text variant="footnote" color="inkMuted" numberOfLines={1}>
          {t('puja.affordanceSub')}
        </Text>
      </View>
      <View style={styles.pujaAction}>
        <Text variant="subhead" color="brand">
          {t('puja.affordanceAction')}
        </Text>
        <IconArrowRight color={theme.colors.brand} size={16} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pujaCard: {flexDirection: 'row', alignItems: 'center', borderWidth: 1},
  pujaGlyph: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pujaBody: {flex: 1, gap: 2},
  pujaAction: {flexDirection: 'row', alignItems: 'center', gap: 4},
  scheduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  // Desglose del recargo de modo niño (precio FIJO): separado del bloque de opciones por un borde fino
  // (color del token `border`, aplicado inline). El `gap` también viene del token de spacing.
  feeBreakdown: {borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8},
  feeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});
