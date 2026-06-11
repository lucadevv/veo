import React, {useState} from 'react';
import {FlatList, RefreshControl, StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {SafeScreen, Skeleton, useTheme} from '@veo/ui-kit';
import type {RootStackParamList} from '../../../../navigation/types';
import {StateView} from '../../../../shared/presentation/components/StateView';
import {TopBar} from '../../../../shared/presentation/components/TopBar';
import {toErrorMessage} from '../../../../shared/presentation/errors';
import {isOnShift} from '../../../shift/domain';
import {useShiftState} from '../../../shift/presentation/hooks/useShift';
import type {OpenBid} from '../../domain';
import {useOpenBids} from '../hooks/useBids';
import {BidCard} from '../components/BidCard';
import {CounterOfferSheet} from '../components/CounterOfferSheet';

type Props = NativeStackScreenProps<RootStackParamList, 'Bids'>;

/**
 * Pantalla de PUJAS abiertas (marketplace "proponé tu precio", lado conductor). Lista las pujas OPEN
 * cercanas que el conductor elegible puede ofertar; tap → sheet para aceptar la tarifa o contraofertar.
 * Gate de turno: sin turno activo NO se consulta el backend (respondería []/403), se muestra el gate.
 * Cuatro estados: cargando · lista · vacío · error. Degradación honesta (sin data inventada).
 */
export const BidsScreen = ({navigation}: Props): React.JSX.Element => {
  const {t} = useTranslation();
  const theme = useTheme();
  const shift = useShiftState();
  const onShift = shift.data ? isOnShift(shift.data.status) : false;
  const bids = useOpenBids(onShift);
  const [selected, setSelected] = useState<OpenBid | null>(null);

  // La puja abierta en el sheet desapareció de la lista viva (otro conductor la tomó / venció / se canceló):
  // el board ya no está OPEN-cercano. Se lo pasamos al sheet para mostrar "ya no disponible" sin yank abrupto.
  const selectedGone =
    selected !== null && bids.data !== undefined && !bids.data.some(b => b.tripId === selected.tripId);

  const header = <TopBar title={t('trips.bid.screenTitle')} onBack={() => navigation.goBack()} />;

  let content: React.ReactNode;
  if (!onShift) {
    content = (
      <StateView
        title={t('trips.bid.offline')}
        action={{label: t('trips.bid.goOnline'), onPress: () => navigation.goBack()}}
      />
    );
  } else if (bids.isLoading) {
    content = (
      <View style={styles.list}>
        <Skeleton height={132} />
        <Skeleton height={132} />
        <Skeleton height={132} />
      </View>
    );
  } else if (bids.isError) {
    content = (
      <StateView
        title={t('errors.generic')}
        description={toErrorMessage(bids.error, t)}
        action={{label: t('common.retry'), onPress: () => bids.refetch()}}
      />
    );
  } else if (!bids.data || bids.data.length === 0) {
    content = <StateView title={t('trips.bid.empty')} description={t('trips.bid.emptyHint')} />;
  } else {
    content = (
      <FlatList
        data={bids.data}
        keyExtractor={item => item.tripId}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={bids.isRefetching}
            onRefresh={() => bids.refetch()}
            tintColor={theme.colors.accent}
          />
        }
        renderItem={({item}) => <BidCard bid={item} onPress={() => setSelected(item)} />}
      />
    );
  }

  return (
    <SafeScreen padded header={header}>
      {content}
      <CounterOfferSheet bid={selected} gone={selectedGone} onClose={() => setSelected(null)} />
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  list: {gap: 12, paddingVertical: 16},
});
