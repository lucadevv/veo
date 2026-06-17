import type { OfferView } from '@veo/api-client';
import { type RouteProp, useIsFocused, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Avatar, Banner, Button, Card, StatusPill, Text, useTheme } from '@veo/ui-kit';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StatusBar, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import type { RootStackParamList } from '../../../../navigation/types';
import { formatDurationMinutes, formatPEN } from '../../../../shared/utils/format';
import { EmptyState, ErrorState, LoadingState } from '../../../../shared/presentation/components/ScreenStates';
import { AppMap } from '../../../../shared/presentation/components/AppMap';
import { mergeOffers } from '../../domain/offers';
import { IconStarFilled } from '../components/icons';
import { usePassengerTripSocket } from '../hooks/usePassengerTripSocket';
import { useCurrentLocation } from '../hooks/useCurrentLocation';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * LEGACY: solo flujo PROGRAMADO/reasignación (`Reassign`, `RouteQuote`, `NoOffers` legacy). El flujo
 * NORMAL de la puja vive ENTERO en el sheet de `RequestFlowScreen` (fase `offers` = `OffersBody`); NO
 * debe pasar por esta pantalla. No borrar todavía: Reassign y el camino programado aún la referencian.
 *
 * PUJA · board de ofertas EN VIVO (handoff `Offers`). Fusiona el snapshot REST (`GET /trips/:id/offers`)
 * con las ofertas que entran por socket (`offer:made`) y deja al pasajero ELEGIR: "Elegir" acepta el
 * precio (→ match → viaje activo) o "Ver" abre la contraoferta. La UI refleja; el gate de ownership +
 * estado lo aplica el servidor.
 *
 * BE-1: el BFF enriquece cada oferta con nombre/rating/vehículo del conductor (gRPC a identity/rating/fleet)
 * para el "elegí por rating" del diseño. Degradación honesta: si un downstream cae, ese campo queda null y
 * la card cae al label genérico "Conductor" (nunca dato inventado).
 */
export function OffersBoardScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const { tripId } = useRoute<RouteProp<RootStackParamList, 'OffersBoard'>>().params;

  const listOffers = useDependency(TOKENS.listOffersUseCase);
  const acceptOffer = useDependency(TOKENS.acceptOfferUseCase);
  const cancelBid = useDependency(TOKENS.cancelBidUseCase);
  const tripRepository = useDependency(TOKENS.tripRepository);
  const live = usePassengerTripSocket(tripId);
  // R1/R2 · solo la pantalla ENFOCADA navega por status: si Counter está montado encima, el board (debajo,
  // aún montado con su socket+poll) NO debe disparar su propia navegación → evita el doble-replace.
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  // Tu ubicación para el mapa del board ("estás acá, buscando"). Los taxis cercanos en vivo son un
  // feed aparte (no existe aún + 0 conductores online) → honestamente no se muestran todavía.
  const { point: myLocation } = useCurrentLocation();
  // Alto medido del sheet de ofertas → el botón "recentrarme" del mapa flota POR ENCIMA del panel.
  const [sheetHeight, setSheetHeight] = useState(0);

  const offersQuery = useQuery({
    queryKey: ['trip', tripId, 'offers'],
    queryFn: () => listOffers.execute(tripId),
    enabled: Boolean(tripId),
    // Respaldo del socket: si un evento se pierde, el snapshot se refresca solo.
    refetchInterval: 5000,
  });

  // Respaldo de ESTADO: si el socket se cae justo cuando la puja expira / el conductor cancela, el poll
  // REST detecta igual el EXPIRED/REASSIGNING/match y dispara la navegación (no deja al pasajero colgado).
  const stateQuery = useQuery({
    queryKey: ['trip', tripId, 'state'],
    queryFn: () => tripRepository.getTripState(tripId),
    enabled: Boolean(tripId),
    refetchInterval: 5000,
  });

  // Estado efectivo: el socket (baja latencia) o, si cayó, el último snapshot REST.
  const status = live.status ?? stateQuery.data?.status ?? null;
  // Contrato nuevo `{ board, offers }`: las ofertas viven en `.offers` (vacías si el board ≠ OPEN).
  const offers = mergeOffers(offersQuery.data?.offers ?? [], live.incomingOffers, live.withdrawnDriverIds);

  // Una sola navegación de salida: tanto el onSuccess del accept como el effect de status pueden querer
  // salir; el ref evita el doble `replace` (race accept ↔ trip:update ASSIGNED).
  const navigatedRef = useRef(false);
  const goOnce = useCallback(
    (fn: () => void): void => {
      if (navigatedRef.current) return;
      navigatedRef.current = true;
      fn();
    },
    [],
  );

  const acceptMutation = useMutation({
    mutationFn: (driverId: string) => acceptOffer.execute(tripId, driverId),
    onSuccess: () => goOnce(() => navigation.replace('TripActive', { tripId })),
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelBid.execute(tripId),
    onSuccess: () => goOnce(() => navigation.navigate('Home')),
  });

  const expired = status === 'EXPIRED';

  useEffect(() => {
    // Solo navega la pantalla ENFOCADA (R1/R2): si Counter está encima, el board espera a re-enfocarse.
    if (!isFocused) return;
    // Reacciona al estado EFECTIVO (socket o, si cayó, poll REST): así un EXPIRED/REASSIGNING/match que
    // llega solo por REST (socket caído) igual navega y no deja al pasajero colgado.
    if (status === 'ASSIGNED' || status === 'ACCEPTED') {
      goOnce(() => navigation.replace('TripActive', { tripId }));
    } else if (status === 'EXPIRED') {
      goOnce(() => navigation.replace('NoOffers', { tripId }));
    } else if (status === 'FAILED' || status === 'CANCELLED' || status === 'COMPLETED') {
      // Estados TERMINALES con el board abierto (watchdog/cancelación): no dejar al pasajero colgado en
      // un board que ya no recibe ofertas → al detalle del viaje, que muestra el estado final.
      goOnce(() => navigation.replace('TripActive', { tripId }));
    }
  }, [status, isFocused, navigation, tripId, goOnce]);

  const onChoose = (offer: OfferView): void => {
    // No permitir elegir mientras un accept está en curso (evita aceptar 2 ofertas distintas).
    if (acceptMutation.isPending) return;
    if (offer.kind === 'COUNTER') {
      navigation.navigate('Counter', { tripId, driverId: offer.driverId });
    } else {
      acceptMutation.mutate(offer.driverId);
    }
  };

  const renderBody = (): React.JSX.Element => {
    if (offersQuery.isError) {
      return <ErrorState onRetry={() => offersQuery.refetch()} />;
    }
    if (offersQuery.isLoading && offers.length === 0) {
      return <LoadingState lines={3} />;
    }
    if (offers.length === 0) {
      return expired ? (
        <EmptyState title={t('offers.noneTitle')} subtitle={t('offers.noneBody')} />
      ) : (
        <EmptyState title={t('offers.waitingTitle')} subtitle={t('offers.waitingBody')} />
      );
    }
    return (
      <View style={{ gap: theme.spacing.sm }}>
        {offers.map((offer) => (
          <OfferCard
            key={offer.driverId}
            offer={offer}
            onChoose={() => onChoose(offer)}
            choosing={acceptMutation.isPending}
          />
        ))}
      </View>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* MAPA full-bleed de fondo: tu ubicación mientras se busca conductor. */}
      <View style={StyleSheet.absoluteFill}>
        <AppMap
          center={myLocation}
          userPoint={myLocation}
          interactive
          showRecenter
          bottomInset={sheetHeight}
        />
      </View>

      {/* Panel flotante con las ofertas en vivo / estado de búsqueda + acciones. */}
      <View
        onLayout={(e) => setSheetHeight(e.nativeEvent.layout.height)}
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.bg,
            borderTopLeftRadius: theme.radii.xl,
            borderTopRightRadius: theme.radii.xl,
            borderColor: theme.colors.border,
            paddingBottom: insets.bottom + theme.spacing.md,
          },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: theme.colors.borderStrong }]} />

        <View style={[styles.header, { paddingHorizontal: theme.spacing.xl, marginBottom: theme.spacing.sm }]}>
          <View style={{ flex: 1 }}>
            <Text variant="title3">{t('offers.title', { count: offers.length })}</Text>
            <Text variant="footnote" color="inkMuted">
              {t('offers.chooseHint')}
            </Text>
          </View>
          <StatusPill
            label={live.connected ? t('offers.live') : t('offers.reconnecting')}
            tone={live.connected ? 'brand' : 'neutral'}
            dot
            live={live.connected && !expired}
          />
        </View>

        <ScrollView
          style={styles.bodyScroll}
          contentContainerStyle={{ paddingHorizontal: theme.spacing.xl, gap: theme.spacing.md, paddingBottom: theme.spacing.md }}
          showsVerticalScrollIndicator={false}
        >
          {renderBody()}
        </ScrollView>

        <View style={{ paddingHorizontal: theme.spacing.xl, gap: theme.spacing.sm }}>
          {acceptMutation.isError || cancelMutation.isError ? (
            <Banner tone="danger" title={t('offers.actionError')} />
          ) : null}

          <Button
            label={t('offers.cancel')}
            variant="ghost"
            fullWidth
            loading={cancelMutation.isPending}
            disabled={acceptMutation.isPending}
            onPress={() => cancelMutation.mutate()}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * Tarjeta de una oferta. BE-1: muestra rating + vehículo REALES (enriquecidos por el BFF); el avatar y
 * el label "Conductor" siguen genéricos hasta BE-1b (el nombre necesita el cambio de proto). Si el
 * enriquecimiento falló/falta (rating/vehicle null), degrada honesto (no muestra ese dato).
 */
function OfferCard({
  offer,
  onChoose,
  choosing,
}: {
  offer: OfferView;
  onChoose: () => void;
  choosing: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const acceptsPrice = offer.kind === 'ACCEPT_PRICE';

  return (
    <Card
      variant="outlined"
      padding="md"
      style={acceptsPrice ? { borderColor: theme.colors.accent } : undefined}
    >
      <View style={styles.row}>
        <Avatar size="md" />
        <View style={{ flex: 1, gap: theme.spacing.xxs }}>
          <View style={styles.nameRow}>
            <Text variant="bodyStrong">{offer.driverName ?? t('offers.driver')}</Text>
            {offer.rating != null ? (
              <View style={styles.ratingRow}>
                <IconStarFilled color={theme.colors.warn} size={13} />
                <Text variant="footnote" color="warn" tabular>
                  {offer.rating.toFixed(2)}
                </Text>
              </View>
            ) : null}
          </View>
          {offer.vehicle ? (
            <Text variant="footnote" color="inkMuted">
              {`${offer.vehicle.make} ${offer.vehicle.model} · ${offer.vehicle.color}`}
            </Text>
          ) : null}
          <Text variant="footnote" color={acceptsPrice ? 'safe' : 'inkMuted'}>
            {acceptsPrice ? t('offers.acceptsPrice') : t('offers.proposesOther')} ·{' '}
            {t('offers.etaMin', { minutes: formatDurationMinutes(offer.etaSeconds) })}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
          <Text variant="title3" color={acceptsPrice ? 'accent' : 'ink'} tabular>
            {formatPEN(offer.priceCents)}
          </Text>
          <Button
            label={acceptsPrice ? t('offers.choose') : t('offers.view')}
            variant="primary"
            size="sm"
            loading={choosing && acceptsPrice}
            disabled={choosing}
            onPress={onChoose}
          />
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Panel flotante anclado abajo sobre el mapa (mismo lenguaje que RouteQuote).
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '70%',
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 12 },
  bodyScroll: { flexGrow: 0 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});
