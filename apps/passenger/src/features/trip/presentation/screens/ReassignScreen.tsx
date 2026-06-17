import {
  type RouteProp,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useMutation, useQuery} from '@tanstack/react-query';
import {
  Button,
  Card,
  MapShell,
  RoutePin,
  SafeScreen,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {AppMap} from '../../../../shared/presentation/components/AppMap';
import {ErrorState} from '../../../../shared/presentation/components/ScreenStates';
import {formatPEN} from '../../../../shared/utils/format';
import type {RootStackParamList} from '../../../../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Params = RouteProp<RootStackParamList, 'Reassign'>;

/**
 * Reasignación (estado REASSIGNING · design-handoff "Reassign"): el conductor asignado canceló antes
 * del recojo. El backend RE-ABRE el board de ofertas (ADR 010 · B1) al mismo precio y sin cargo para
 * el pasajero; esta pantalla comunica eso ("buscando otro conductor") y lleva al tablero de ofertas
 * para que el pasajero elija al nuevo conductor.
 *
 * Es una pantalla de ESTADO/UI sobre un flujo de backend REAL (REASSIGNING + board): no inventa un
 * conductor ni una asignación automática. El monto mostrado es la tarifa real del viaje (`fareCents`).
 */
export function ReassignScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const {tripId} = useRoute<Params>().params;

  const tripRepository = useDependency(TOKENS.tripRepository);
  const cancelBid = useDependency(TOKENS.cancelBidUseCase);

  const tripQuery = useQuery({
    queryKey: ['trip', tripId, 'active'],
    queryFn: () => tripRepository.getActiveTrip(tripId),
  });

  // Cancelar la puja de verdad (cierra el board server-side) antes de volver al Home. Idempotente; si
  // falla la red igual liberamos al pasajero al Home (el watchdog del backend cierra el viaje).
  const cancelMutation = useMutation({
    mutationFn: () => cancelBid.execute(tripId),
    onSettled: () => navigation.navigate('Home'),
  });

  if (tripQuery.isError) {
    return (
      <SafeScreen>
        <ErrorState onRetry={() => tripQuery.refetch()} />
      </SafeScreen>
    );
  }

  const fareCents = tripQuery.data?.fareCents ?? null;

  return (
    <SafeScreen padded={false}>
      <View style={styles.mapArea}>
        <MapShell>
          <AppMap origin={null} destination={null} interactive={false} />
        </MapShell>
        <View
          style={[
            StyleSheet.absoluteFill,
            {backgroundColor: theme.colors.overlay},
          ]}
          pointerEvents="none"
        />
      </View>

      <View
        style={[
          styles.sheet,
          {backgroundColor: theme.colors.bg, padding: theme.spacing.xl},
        ]}>
        <View style={styles.center}>
          <RoutePin variant="user" pulse size={26} />
          <Text
            variant="title3"
            align="center"
            style={{marginTop: theme.spacing.lg}}>
            {t('reassign.title')}
          </Text>
          <Text
            variant="callout"
            color="inkMuted"
            align="center"
            style={{marginTop: theme.spacing.sm}}>
            {fareCents !== null
              ? t('reassign.body', {price: formatPEN(fareCents)})
              : t('reassign.bodyNoPrice')}
          </Text>
        </View>

        <Card
          variant="filled"
          padding="lg"
          style={{marginTop: theme.spacing.xl}}>
          <Text variant="footnote" color="inkMuted">
            {t('reassign.note')}
          </Text>
        </Card>

        <View style={{flex: 1}} />

        <View style={{gap: theme.spacing.sm}}>
          <Button
            label={t('reassign.continue')}
            variant="primary"
            fullWidth
            onPress={() => navigation.replace('OffersBoard', {tripId})}
          />
          <Button
            label={t('reassign.cancel')}
            variant="ghost"
            fullWidth
            loading={cancelMutation.isPending}
            onPress={() => cancelMutation.mutate()}
          />
        </View>
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  mapArea: {flex: 1},
  sheet: {flex: 1.2},
  center: {alignItems: 'center'},
});
