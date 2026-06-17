import {
  type RouteProp,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useMutation, useQuery} from '@tanstack/react-query';
import {Button, SafeScreen, Text, useTheme} from '@veo/ui-kit';
import React, {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import type {RootStackParamList} from '../../../../navigation/types';
import {BidPanel} from '../../../../shared/presentation/components/BidPanel';
import {
  EmptyState,
  ScreenStateFallback,
} from '../../../../shared/presentation/components/ScreenStates';
import {formatPEN} from '../../../../shared/utils/format';
import {BID_STEP_CENTS, stepBidCents} from '../../../../shared/utils/bid';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * PUJA · sin ofertas (estado EXPIRED, ADR 010 #12 · H6.4). La puja cerró sin que ningún conductor
 * aceptara: el pasajero RE-PUJA más alto para reabrir el board. El piso del stepper es su OFERTA ACTUAL
 * (`fareCents` del viaje) — re-pujar es ofrecer MÁS; no se puede bajar. El servidor re-valida estado
 * (REBIDDABLE) + piso de zona. Reusa el `BidPanel` canónico (mismo stepper que el quote).
 */
export function NoOffersScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const {tripId} = useRoute<RouteProp<RootStackParamList, 'NoOffers'>>().params;

  const tripRepository = useDependency(TOKENS.tripRepository);
  const rebid = useDependency(TOKENS.rebidUseCase);
  const cancelBid = useDependency(TOKENS.cancelBidUseCase);

  const tripQuery = useQuery({
    queryKey: ['trip', tripId, 'active'],
    queryFn: () => tripRepository.getActiveTrip(tripId),
    enabled: Boolean(tripId),
  });

  // Oferta actual = piso de la re-puja. La nueva oferta arranca un sol por encima (nudge a subir).
  const currentBidCents = tripQuery.data?.fareCents;
  const [bidCents, setBidCents] = useState<number | null>(null);

  useEffect(() => {
    if (currentBidCents !== undefined && bidCents === null) {
      setBidCents(currentBidCents + BID_STEP_CENTS);
    }
  }, [currentBidCents, bidCents]);

  const rebidMutation = useMutation({
    mutationFn: (amount: number) => rebid.execute(tripId, amount),
    onSuccess: () => navigation.replace('OffersBoard', {tripId}),
  });

  // Cancelar la puja de verdad (cierra el board server-side) antes de volver al Home. Idempotente; si
  // falla la red igual liberamos al pasajero al Home (el watchdog del backend cierra el viaje EXPIRED).
  const cancelMutation = useMutation({
    mutationFn: () => cancelBid.execute(tripId),
    onSettled: () => navigation.navigate('Home'),
  });

  if (tripQuery.isError) {
    return <ScreenStateFallback onRetry={() => tripQuery.refetch()} />;
  }
  if (
    tripQuery.isLoading ||
    currentBidCents === undefined ||
    bidCents === null
  ) {
    return <ScreenStateFallback loading loadingLines={2} />;
  }

  return (
    <SafeScreen>
      <View style={{gap: theme.spacing.lg, flex: 1}}>
        <EmptyState
          title={t('noOffers.title')}
          subtitle={t('noOffers.body', {price: formatPEN(currentBidCents)})}
        />

        <BidPanel
          bidCents={bidCents}
          floorCents={currentBidCents}
          onDecrement={() =>
            setBidCents(b =>
              stepBidCents(b ?? currentBidCents, -1, currentBidCents),
            )
          }
          onIncrement={() =>
            setBidCents(b =>
              stepBidCents(b ?? currentBidCents, 1, currentBidCents),
            )
          }
        />

        <View style={{flex: 1}} />

        <Button
          label={t('noOffers.rebid', {price: formatPEN(bidCents)})}
          variant="primary"
          fullWidth
          loading={rebidMutation.isPending}
          onPress={() => rebidMutation.mutate(bidCents)}
        />
        <Button
          label={t('noOffers.cancel')}
          variant="ghost"
          fullWidth
          loading={cancelMutation.isPending}
          disabled={rebidMutation.isPending}
          onPress={() => cancelMutation.mutate()}
        />
        {rebidMutation.isError ? (
          <Text variant="footnote" color="danger" align="center">
            {t('noOffers.error')}
          </Text>
        ) : null}
      </View>
    </SafeScreen>
  );
}
