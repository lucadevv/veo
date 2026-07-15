import {
  type RouteProp,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Banner,
  Button,
  DriverCard,
  hexAlpha,
  SafeScreen,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React, {useCallback, useEffect, useRef} from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import type {RootStackParamList} from '../../../../navigation/types';
import {formatPEN} from '../../../../shared/utils/format';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {IconArrowRight} from '../components/icons';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * PUJA · detalle de una CONTRAOFERTA (handoff `Counter`). Muestra la oferta original del pasajero
 * (tachada) frente a la contraoferta del conductor, y deja: ACEPTAR (→ match → viaje activo) o ESPERAR
 * otra oferta (vuelve al board). El "re-ofertar" con su stepper llega en el próximo lote (necesita el
 * piso de zona, que post-creación hay que re-resolver). Avatar genérico: el contrato no trae nombre.
 *
 * Reactivo al ESTADO del viaje: mientras el pasajero mira la contraoferta, el viaje puede EXPIRAR,
 * REASIGNARSE (el conductor canceló) o matchear con otro → no debe quedar mirando una contraoferta muerta.
 * Usa el poll REST de estado (`stateQuery`, 5s) — NO abre su propio socket: el board sigue montado debajo
 * con el suyo, y un 2º socket al mismo viaje sería un leak (R1/R2). `offersQuery` refrescado detecta que el
 * conductor retiró su oferta.
 *
 * M1 · NAVEGACIÓN DELEGADA: Counter NUNCA hace `replace` — TODAS las salidas son `goBack()` al board, que
 * (re-enfocado, con socket vivo y el mismo status) es la ÚNICA autoridad de ruteo. Si Counter reemplazara,
 * el board quedaría montado debajo con su socket + polls durante todo el viaje (leak) y un "back" desde
 * el viaje activo aterrizaría en un board muerto. Al ACEPTAR, se siembra el query compartido de estado con
 * ASSIGNED (optimista; el server lo confirma por socket/poll) para que el board rutee al instante, sin gap.
 */
export function CounterScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const {tripId, driverId} =
    useRoute<RouteProp<RootStackParamList, 'Counter'>>().params;

  const queryClient = useQueryClient();
  const listOffers = useDependency(TOKENS.listOffersUseCase);
  const acceptOffer = useDependency(TOKENS.acceptOfferUseCase);
  const tripRepository = useDependency(TOKENS.tripRepository);

  const offersQuery = useQuery({
    queryKey: ['trip', tripId, 'offers'],
    queryFn: () => listOffers.execute(tripId),
    enabled: Boolean(tripId),
    // Respaldo: detecta que el conductor RETIRÓ su contraoferta entre el board y esta pantalla.
    refetchInterval: 5000,
  });
  const tripQuery = useQuery({
    queryKey: ['trip', tripId, 'active'],
    queryFn: () => tripRepository.getActiveTrip(tripId),
    enabled: Boolean(tripId),
  });
  // Respaldo de ESTADO: si el socket cae justo cuando el viaje expira/reasigna/matchea, el poll REST
  // dispara igual la navegación de salida (no deja al pasajero mirando una contraoferta muerta).
  const stateQuery = useQuery({
    queryKey: ['trip', tripId, 'state'],
    queryFn: () => tripRepository.getTripState(tripId),
    enabled: Boolean(tripId),
    refetchInterval: 5000,
  });
  const status = stateQuery.data?.status ?? null;

  // Una sola salida (M1): el onSuccess del accept, el effect de status y el botón Esperar pueden competir;
  // un doble goBack() popearía TAMBIÉN el board. goOnce garantiza un único pop.
  const navigatedRef = useRef(false);
  const goOnce = useCallback((fn: () => void): void => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    fn();
  }, []);

  const acceptMutation = useMutation({
    mutationFn: () => acceptOffer.execute(tripId, driverId),
    onSuccess: () =>
      goOnce(() => {
        // Siembra el estado compartido como ASSIGNED (el accept ⇒ match): el board re-enfocado rutea a
        // el viaje activo AL INSTANTE, sin esperar el próximo poll/evento. El server lo confirma enseguida.
        queryClient.setQueryData(['trip', tripId, 'state'], {
          id: tripId,
          status: 'ASSIGNED',
        });
        navigation.goBack();
      }),
  });

  useEffect(() => {
    // M1 · cualquier estado que invalide la contraoferta → volver al board (única autoridad de ruteo): él
    // ve el MISMO status (socket en vivo + su propio poll) y decide (match→flujo unificado, EXPIRED→NoOffers,
    // REASSIGNING→se queda re-abierto, terminal→flujo unificado). Counter no replica ese mapa: solo se corre.
    if (
      status === 'ASSIGNED' ||
      status === 'ACCEPTED' ||
      status === 'REASSIGNING' ||
      status === 'EXPIRED' ||
      status === 'FAILED' ||
      status === 'CANCELLED' ||
      status === 'COMPLETED'
    ) {
      goOnce(() => navigation.goBack());
    }
  }, [status, navigation, goOnce]);

  // Contrato nuevo `{ board, offers }`: buscamos en `.offers`. Si el board cerró (EXPIRED/CANCELLED/…)
  // viene `[]` → `offer` undefined → cae al estado "el conductor retiró su oferta" (sin zombie).
  const offer = offersQuery.data?.offers.find(o => o.driverId === driverId);
  // La oferta original del pasajero = la tarifa congelada del viaje (su bid).
  const originalBidCents = tripQuery.data?.fareCents;

  if (offersQuery.isError || tripQuery.isError) {
    return (
      <SafeScreen>
        <ErrorState
          onRetry={() => {
            void offersQuery.refetch();
            void tripQuery.refetch();
          }}
        />
      </SafeScreen>
    );
  }
  if (offersQuery.isLoading || tripQuery.isLoading) {
    return (
      <SafeScreen>
        <LoadingState lines={2} />
      </SafeScreen>
    );
  }
  // El conductor retiró su oferta (o caducó) entre el board y esta pantalla.
  if (!offer) {
    return (
      <SafeScreen>
        <EmptyState
          title={t('counter.goneTitle')}
          subtitle={t('counter.goneBody')}
        />
        <Button
          label={t('counter.back')}
          variant="secondary"
          fullWidth
          onPress={() => goOnce(() => navigation.goBack())}
        />
      </SafeScreen>
    );
  }

  // Nombre de pila para el header personalizado (pen u1306: "José te contraofertó").
  const firstName = offer.driverName?.trim().split(/\s+/)[0] ?? null;

  return (
    <SafeScreen>
      <View style={{gap: theme.spacing.md, flex: 1}}>
        {/* Header per design/veo.pen u1306: quién contraofertó + invitación a cerrar. */}
        <View style={{gap: theme.spacing.xxs}}>
          <Text variant="title2">
            {firstName
              ? t('counter.title', {name: firstName})
              : t('counter.titleNoName')}
          </Text>
          <Text variant="callout" color="inkMuted">
            {t('counter.subtitle')}
          </Text>
        </View>

        {/* MISMA identidad canónica que FIXED/OffersBody (DriverCard: avatar gradiente, 5 estrellas, placa
            mono). El "propone otro" va en el footer; el precio comparado vive en los tiles de abajo. */}
        <DriverCard
          name={offer.driverName ?? t('offers.driver')}
          rating={offer.rating ?? undefined}
          vehicle={
            offer.vehicle
              ? `${offer.vehicle.make} ${offer.vehicle.model} · ${offer.vehicle.color}`
              : undefined
          }
          plate={offer.vehicle?.plate}
          footer={
            <Text variant="footnote" color="inkMuted">
              {t('counter.proposedOther')}
            </Text>
          }
        />

        {/* Comparación HORIZONTAL per pen u1306: tile "Tu oferta" (tachada) → flecha → tile "Su
            precio" en warn (propone otro). El mismo dato de antes, en la disposición del diseño. */}
        <View style={[styles.compareTiles, {gap: theme.spacing.sm}]}>
          <View
            style={[
              styles.compareTile,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.lg,
                padding: theme.spacing.lg,
              },
            ]}>
            <Text variant="caption" color="inkSubtle">
              {t('counter.yourOffer')}
            </Text>
            <Text
              variant="title3"
              color="inkSubtle"
              tabular
              style={styles.strike}>
              {originalBidCents !== undefined
                ? formatPEN(originalBidCents)
                : '—'}
            </Text>
          </View>
          <IconArrowRight color={theme.colors.inkSubtle} size={18} />
          <View
            style={[
              styles.compareTile,
              {
                backgroundColor: hexAlpha(theme.colors.warn, 0.15),
                borderColor: theme.colors.warn,
                borderRadius: theme.radii.lg,
                padding: theme.spacing.lg,
              },
            ]}>
            <Text variant="caption" color="warn">
              {t('counter.theirPrice')}
            </Text>
            <Text variant="title3" color="warn" tabular>
              {formatPEN(offer.priceCents)}
            </Text>
          </View>
        </View>

        <View style={{flex: 1}} />

        {acceptMutation.isError ? (
          <Banner tone="danger" title={t('counter.acceptError')} />
        ) : null}
        <Button
          label={t('counter.accept', {price: formatPEN(offer.priceCents)})}
          variant="primary"
          fullWidth
          loading={acceptMutation.isPending}
          onPress={() => acceptMutation.mutate()}
        />
        <Button
          label={t('counter.wait')}
          variant="secondary"
          fullWidth
          disabled={acceptMutation.isPending}
          onPress={() => goOnce(() => navigation.goBack())}
        />
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  compareTiles: {flexDirection: 'row', alignItems: 'center'},
  compareTile: {flex: 1, gap: 4, borderWidth: 1},
  strike: {textDecorationLine: 'line-through'},
});
