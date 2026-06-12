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
} from '@veo/api-client';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Banner, Button, RideOptionRow, Skeleton, StatusPill, Text, useTheme } from '@veo/ui-kit';
import { CHILD_MODE_FEE_CENTS } from '@veo/shared-types';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import type { RootStackParamList } from '../../../../navigation/types';
import { formatDateTime, formatDistance, formatDurationMinutes, formatPEN } from '../../../../shared/utils/format';
import { useChildModeStore } from '../../../childMode/presentation/stores/childModeStore';
import { usePaymentPrefsStore } from '../../../payments/presentation/stores/paymentPrefsStore';
import { PaymentMethodRow, PaymentMethodSheet, useIsYapeAutoActive } from '../../../payments/presentation';
import { PromoField, type AppliedPromo } from '../../../promos/presentation';
import { ScheduleSheet } from './ScheduleSheet';
import { initialBidCents, stepBidCents } from '../../../../shared/utils/bid';
import { uuidv4 } from '../../../../shared/utils/uuid';
import { isWaypointSet, type RoutePlace } from '../../../maps/domain/entities';
import { mapKycStatus } from '../../../kyc/domain/entities';
import { KycGate } from './KycGate';
import { BidPanel } from '../../../../shared/presentation/components/BidPanel';
import {
  offeringDisplayName,
  offeringGlyph,
} from '../../../../shared/presentation/components/offeringGlyphs';
import { RoutePointsList } from '../../../maps/presentation/components/RoutePointsList';
import { SpecialRequestChips } from '../../../maps/presentation/components/SpecialRequestChips';
import { VehicleIcon } from '../../../maps/presentation/components/VehicleIcon';
import { SelectionBump } from '../../../maps/presentation/components/motion';
import { useRideDraftStore } from '../../../maps/presentation/stores/rideDraftStore';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Convierte el punto de la API de mapas (lng) al `GeoPoint` de dominio (lon). */
function toGeoPoint(point: MapPoint): GeoPoint {
  return { lat: point.lat, lon: point.lng };
}

export interface QuotingBodyProps {
  /** El viaje se creó (POST /trips OK): la pantalla decide qué hacer (reaccionar a la fase / navegar). */
  onTripCreated: (trip: TripResource) => void;
  /** Viaje PROGRAMADO creado (no entra a dispatch ahora). */
  onScheduled: () => void;
  /** El BFF exige verificación facial (403 KYC) — la pantalla deriva al KYC. */
  onKycRequired: () => void;
  /**
   * Estado de verificación facial del pasajero (`kycStatus` de `GET /users/me`, ya cacheado en el Home).
   * Si NO está `approved`, el sheet muestra un GATE contextual ("verificá antes de pedir") en vez del
   * botón Confirmar — proactivo, no la emboscada del 403. El gate REAL sigue siendo server-side.
   */
  kycStatus?: string | null;
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
  kycStatus,
}: QuotingBodyProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();

  const quoteRide = useDependency(TOKENS.quoteRideUseCase);
  const createTrip = useDependency(TOKENS.createTripUseCase);
  const defaultMethod = usePaymentPrefsStore((s) => s.defaultMethod);
  // Para que el toggle "Recordar como predeterminado" del selector pueda ascender la elección de ESTE
  // viaje a predeterminado del perfil (TASK 2). No se toca salvo que el usuario lo pida explícitamente.
  const setDefaultMethod = usePaymentPrefsStore((s) => s.setDefault);
  const childMode = useChildModeStore();

  const origin = useRideDraftStore((s) => s.origin);
  const destination = useRideDraftStore((s) => s.destination);
  const waypoints = useRideDraftStore((s) => s.waypoints);
  const setEditing = useRideDraftStore((s) => s.setEditing);
  const addWaypoint = useRideDraftStore((s) => s.addWaypoint);
  const removeWaypoint = useRideDraftStore((s) => s.removeWaypoint);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<number | null>(null);
  const [bidCents, setBidCents] = useState<number | null>(null);
  const [specialRequests, setSpecialRequests] = useState<SpecialRequest[]>([]);
  // Método de pago PARA ESTE VIAJE: se siembra del default del perfil al montar (lazy init) y vive en
  // el quoting. Elegir otro acá NO pisa el default del perfil (ese se cambia en PaymentMethodsScreen).
  const [tripPaymentMethod, setTripPaymentMethod] = useState<MobilePaymentMethod>(() => defaultMethod);
  const [paymentSheetOpen, setPaymentSheetOpen] = useState(false);
  // ¿El cobro automático con Yape está activo? Solo para REFLEJAR una señal sutil en la fila (la app no
  // decide el cobro: es server-side). El query comparte caché con la card del perfil (sin doble fetch).
  const yapeAutoActive = useIsYapeAutoActive();

  const ready = Boolean(origin && destination);

  // Verificación facial (KYC): si NO está aprobada, mostramos el GATE contextual en vez del Confirmar.
  // El estado viene del perfil ya cacheado en el Home; KycCamera invalida ['profile'] al aprobar → al
  // volver, el gate desaparece solo. 'approved' = puede pedir; resto (unverified/pending/rejected) = gate.
  const kycApproved = mapKycStatus(kycStatus) === 'approved';

  const setWaypoints = useMemo<RoutePlace[]>(() => waypoints.filter(isWaypointSet), [waypoints]);
  const quoteWaypoints = useMemo<MapPoint[]>(() => setWaypoints.map((stop) => stop.point), [setWaypoints]);
  const waypointsKey = useMemo(
    () => quoteWaypoints.map((p) => `${p.lat},${p.lng}`).join('|'),
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
        ...(quoteWaypoints.length > 0 ? { waypoints: quoteWaypoints } : {}),
      }),
    enabled: ready,
    staleTime: 60_000,
  });

  useEffect(() => {
    const first = quoteQuery.data?.options[0];
    if (first && !selectedId) {
      setSelectedId(first.id);
    }
  }, [quoteQuery.data, selectedId]);

  const quote = quoteQuery.data;
  const isPuja = quote?.mode === 'PUJA';
  const bidFloorCents = quote?.bidFloorCents ?? 0;
  const suggestedCents = quote?.suggestedCents;

  // Re-ancla el bid cuando la RUTA cambia (agregar/quitar parada → nueva tarifa sugerida): el precio
  // OFRECIDO sigue al nuevo estimado, en vez de quedar clavado en el de la ruta anterior. Antes se
  // seteaba UNA sola vez (`bidCents === null`) → al agregar una parada el bid no se movía ("el precio no
  // se actualiza"). Se re-ancla SOLO cuando cambia `suggestedCents` (= cambió la ruta/distancia),
  // preservando los ajustes manuales del usuario MIENTRAS la ruta no cambie.
  const lastSuggestedRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!isPuja || !quote) return;
    if (suggestedCents !== lastSuggestedRef.current) {
      lastSuggestedRef.current = suggestedCents;
      setBidCents(initialBidCents(suggestedCents, bidFloorCents));
    }
  }, [isPuja, quote, suggestedCents, bidFloorCents]);

  const decrementBid = useCallback(
    () => setBidCents((b) => stepBidCents(b ?? bidFloorCents, -1, bidFloorCents)),
    [bidFloorCents],
  );
  const incrementBid = useCallback(
    () => setBidCents((b) => stepBidCents(b ?? bidFloorCents, 1, bidFloorCents)),
    [bidFloorCents],
  );

  // Reporta la ruta del quote al mapa persistente (la dibuja el AppMap de la pantalla unificada).
  const routeCoordinates = useMemo<[number, number][]>(() => {
    const geometry = quoteQuery.data?.geometry;
    return geometry ? (geometry.coordinates as [number, number][]) : [];
  }, [quoteQuery.data]);
  useEffect(() => {
    onRouteChange(routeCoordinates);
  }, [routeCoordinates, onRouteChange]);

  const selectedOption = useMemo(
    () => quoteQuery.data?.options.find((option) => option.id === selectedId) ?? null,
    [quoteQuery.data, selectedId],
  );
  const selectedFareCents = selectedOption?.priceCents ?? 0;

  // Modo de pricing EFECTIVO de la opción elegida: el de la opción (ADR 013 §1.3) con fallback al
  // top-level del quote (server viejo / ancla VEO Económico). El recargo de modo niño aplica SOLO en
  // FIJO (en PUJA el bid ES el precio): este flag decide si mostramos el desglose del recargo.
  const selectedIsFixed = (selectedOption?.mode ?? quote?.mode) === 'FIXED';
  const showChildFee = childMode.enabled && Boolean(selectedOption) && selectedIsFixed;
  const childTotalCents = selectedFareCents + CHILD_MODE_FEE_CENTS;

  const selectChanged = (id: string): void => {
    if (id !== selectedId) {
      setAppliedPromo(null);
    }
    setSelectedId(id);
  };

  // Editar un punto del trayecto: abre la búsqueda dedicada (Search) para fijar/editar ese extremo.
  // `flow: 'sheet'` → al fijar, Search hace goBack y VOLVEMOS a esta cotización in-sheet (no a la
  // pantalla legacy RouteQuote). El borrador (Zustand) ya quedó actualizado, así que el quote se recalcula.
  const editOrigin = useCallback(() => {
    setEditing({ kind: 'origin' });
    navigation.navigate('Search', { flow: 'sheet' });
  }, [navigation, setEditing]);
  const editDestination = useCallback(() => {
    setEditing({ kind: 'destination' });
    navigation.navigate('Search', { flow: 'sheet' });
  }, [navigation, setEditing]);
  const editWaypoint = useCallback(
    (index: number) => {
      setEditing({ kind: 'waypoint', index });
      navigation.navigate('Search', { flow: 'sheet' });
    },
    [navigation, setEditing],
  );
  const onAddWaypoint = useCallback(() => {
    addWaypoint();
    navigation.navigate('Search', { flow: 'sheet' });
  }, [addWaypoint, navigation]);

  const createMutation = useMutation({
    mutationFn: () =>
      createTrip.execute(
        {
          origin: toGeoPoint(origin!.point),
          destination: toGeoPoint(destination!.point),
          paymentMethod: tripPaymentMethod,
          ...(!isPuja && selectedId ? { category: selectedId } : {}),
          ...(!isPuja && selectedOption ? { vehicleType: selectedOption.vehicleType } : {}),
          ...(isPuja && bidCents !== null ? { bidCents } : {}),
          ...(isPuja && specialRequests.length > 0 ? { specialRequests } : {}),
          ...(quoteWaypoints.length > 0
            ? { waypoints: setWaypoints.map((stop) => toGeoPoint(stop.point)) }
            : {}),
          ...(scheduledAt !== null ? { scheduledFor: new Date(scheduledAt).toISOString() } : {}),
          ...(appliedPromo ? { promoCode: appliedPromo.code } : {}),
          ...(childMode.enabled ? { childMode: true, childCode: childMode.code || undefined } : {}),
        },
        idempotencyKey,
      ),
    onSuccess: (trip) => {
      childMode.reset();
      if (scheduledAt !== null) {
        onScheduled();
        return;
      }
      onTripCreated(trip);
    },
    onError: (error) => {
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
      }
    },
  });

  const options = quoteQuery.data?.options ?? [];
  const canConfirm =
    !createMutation.isPending &&
    ready &&
    (isPuja ? bidCents !== null && bidCents >= bidFloorCents : Boolean(selectedId));

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
    t('trip.etaMinutes', { minutes: formatDurationMinutes(option.etaSeconds) });

  // Subtítulo de la opción: etiqueta del tipo de vehículo (del registro de glyphs, ADR 013 §1.6).
  const optionDescription = (option: QuoteOption, cheapest: boolean): string => {
    const vehicle = t(offeringGlyph(option).vehicleLabelKey);
    return cheapest ? `${vehicle} · ${t('quote.cheapest')}` : vehicle;
  };

  const confirmLabel = createMutation.isPending
    ? t('quote.requesting')
    : scheduledAt !== null
      ? t('schedule.confirm')
      : isPuja && bidCents !== null
        ? t('puja.searchDriver', { price: formatPEN(bidCents) })
        : t('quote.confirm');

  return (
    <View style={{ gap: theme.spacing.md }}>
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
        <Text variant="title3">{isPuja ? t('puja.title') : t('quote.title')}</Text>
        {quoteQuery.data ? (
          <Text variant="footnote" color="inkMuted" tabular>
            {formatDistance(quoteQuery.data.distanceMeters)} ·{' '}
            {t('trip.etaMinutes', { minutes: formatDurationMinutes(quoteQuery.data.durationSeconds) })}
          </Text>
        ) : null}
      </View>

      {quoteQuery.isError ? (
        <Banner
          tone="danger"
          title={t('quote.error')}
          action={{ label: t('actions.retry'), onPress: () => quoteQuery.refetch() }}
        />
      ) : null}

      {quoteQuery.isLoading || (ready && !quoteQuery.data && !quoteQuery.isError) ? (
        <View style={{ gap: theme.spacing.sm }}>
          <Skeleton variant="rect" height={64} />
          <Skeleton variant="rect" height={64} />
          <Skeleton variant="rect" height={64} />
          <Text variant="footnote" color="inkSubtle" align="center" style={{ marginTop: theme.spacing.sm }}>
            {t('quote.calculating')}
          </Text>
        </View>
      ) : isPuja ? (
        bidCents !== null ? (
          <View style={{ gap: theme.spacing.lg }}>
            <BidPanel
              bidCents={bidCents}
              suggestedCents={suggestedCents}
              floorCents={bidFloorCents}
              onDecrement={decrementBid}
              onIncrement={incrementBid}
            />
            <SpecialRequestChips value={specialRequests} onChange={setSpecialRequests} />
          </View>
        ) : null
      ) : (
        <View style={{ gap: theme.spacing.sm }}>
          {options.map((option, index) => (
            <SelectionBump key={option.id} index={index} selected={option.id === selectedId}>
              <RideOptionRow
                name={offeringDisplayName(option)}
                price={formatPEN(option.priceCents)}
                eta={formatEta(option)}
                description={optionDescription(option, index === 0)}
                icon={<VehicleIcon icon={option.icon} vehicleType={option.vehicleType} />}
                selected={option.id === selectedId}
                onPress={() => selectChanged(option.id)}
              />
            </SelectionBump>
          ))}
        </View>
      )}

      {/* Transparencia del recargo Modo Niño (BR-T07): SOLO en precio FIJO se suma S/2.00 (en PUJA el
          bid ES el precio, sin recargo). Se muestra ANTES de confirmar para que el total no sorprenda.
          El monto sale de la constante compartida (@veo/shared-types), misma fuente que el server. */}
      {showChildFee ? (
        <View
          style={[
            styles.feeBreakdown,
            { borderTopColor: theme.colors.border, gap: theme.spacing.xs },
          ]}
        >
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

      {/* Resumen de programación o atajo para programar. */}
      {scheduledAt !== null ? (
        <View style={styles.scheduleRow}>
          <StatusPill
            label={t('schedule.scheduledFor', { when: formatDateTime(new Date(scheduledAt).toISOString()) })}
            tone="brand"
            dot
          />
          <Button label={t('schedule.now')} variant="ghost" size="sm" onPress={() => setScheduledAt(null)} />
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

      {selectedOption || (isPuja && bidCents !== null) ? (
        <PromoField
          fareCents={isPuja && bidCents !== null ? bidCents : selectedFareCents}
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
          title={isKycRequiredError(createMutation.error) ? t('quote.kycRequired') : t('home.quoteError')}
        />
      ) : null}

      {/* Método de pago PARA ESTE VIAJE (antes del CTA): refleja la selección actual y abre el selector.
          La elección viaja al conductor en la puja y define el cobro automático al completar. */}
      {ready && kycApproved ? (
        <PaymentMethodRow
          method={tripPaymentMethod}
          onPress={() => setPaymentSheetOpen(true)}
          disabled={createMutation.isPending}
          autoActive={yapeAutoActive}
        />
      ) : null}

      {ready && !kycApproved ? (
        // Gate de verificación CONTEXTUAL (mejor UX): el pasajero ve su ruta/precio y, en vez de confirmar
        // y comerse un 403, hace el paso único de seguridad ANTES. El 403 sigue como defensa (server-side).
        <KycGate status={mapKycStatus(kycStatus)} onVerify={onKycRequired} />
      ) : (
        <Button
          label={confirmLabel}
          variant="primary"
          fullWidth
          loading={createMutation.isPending}
          disabled={!canConfirm}
          onPress={() => createMutation.mutate()}
        />
      )}

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
        onConfirm={(epochMs) => {
          setScheduledAt(epochMs);
          setScheduleOpen(false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scheduleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  // Desglose del recargo de modo niño (precio FIJO): separado del bloque de opciones por un borde fino
  // (color del token `border`, aplicado inline). El `gap` también viene del token de spacing.
  feeBreakdown: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
  feeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
