import type {MobilePaymentMethod, PaymentView} from '@veo/api-client';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useMutation} from '@tanstack/react-query';
import {
  Banner,
  Button,
  Card,
  ListItem,
  SafeScreen,
  StatusPill,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {formatPEN} from '../../../../shared/utils/format';
import type {RootStackParamList} from '../../../../navigation/types';
import {isPaymentSettled} from '../../domain/paymentOutcome';
import {EnterView, SuccessCheck} from '../components/motion';
import {
  PAYMENT_METHODS,
  usePaymentPrefsStore,
} from '../stores/paymentPrefsStore';

type Params = RouteProp<RootStackParamList, 'Payment'>;
type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * Pago del viaje (`POST /payments/charge`, idempotente). Permite elegir el método y una propina
 * opcional. Para efectivo (CASH) el pasajero confirma el pago tras el cargo (`/payments/:id/cash/confirm`).
 */
export function PaymentScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<Params>();
  const {tripId, amountCents, driverId} = params;

  const chargeTrip = useDependency(TOKENS.chargeTripUseCase);
  const confirmCash = useDependency(TOKENS.confirmCashUseCase);
  const defaultMethod = usePaymentPrefsStore(s => s.defaultMethod);

  const [method, setMethod] = useState<MobilePaymentMethod>(defaultMethod);
  const [tip, setTip] = useState('');

  const tipCents = (() => {
    const parsed = Number.parseFloat(tip.replace(',', '.'));
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
  })();

  const chargeMutation = useMutation<PaymentView, Error, void>({
    mutationFn: () =>
      chargeTrip.execute({
        tripId,
        grossCents: amountCents,
        method,
        ...(tipCents > 0 ? {tipCents} : {}),
      }),
  });

  const confirmMutation = useMutation<PaymentView, Error, string>({
    mutationFn: (paymentId: string) => confirmCash.execute(paymentId),
  });

  const payment = confirmMutation.data ?? chargeMutation.data;
  const isCash = method === 'CASH';
  // La pregunta "¿el cobro ya saldó?" es del DOMINIO (`isPaymentSettled`): efectivo aún no capturado
  // y sin confirmación del pasajero → falta su lado de la confirmación bilateral (BR-P03).
  const cashPending =
    payment != null &&
    isCash &&
    !isPaymentSettled(payment) &&
    !confirmMutation.data;

  if (payment && !cashPending) {
    return (
      <SafeScreen
        footer={
          <Button
            label={t('actions.close')}
            fullWidth
            onPress={() => navigation.goBack()}
          />
        }>
        <View
          style={{gap: theme.spacing.lg, flex: 1, justifyContent: 'center'}}>
          <SuccessCheck />
          <EnterView delay={140}>
            <Banner
              tone="success"
              title={isCash ? t('payments.cashConfirmed') : t('payments.paid')}
            />
          </EnterView>
          <EnterView delay={200}>
            <Card variant="elevated" padding="lg">
              {/* Desglose real del pago (datos del PaymentView): tarifa acordada (grossCents),
                  propina (tipCents) y total (amountCents). La propina solo se muestra si la hubo. */}
              <View style={styles.breakdownRow}>
                <Text variant="callout" color="inkMuted">
                  {t('payments.breakdownFare')}
                </Text>
                <Text variant="callout" tabular>
                  {formatPEN(payment.grossCents)}
                </Text>
              </View>
              {payment.tipCents > 0 ? (
                <View style={styles.breakdownRow}>
                  <Text variant="callout" color="inkMuted">
                    {t('payments.breakdownTip')}
                  </Text>
                  <Text variant="callout" tabular>
                    {formatPEN(payment.tipCents)}
                  </Text>
                </View>
              ) : null}
              <View
                style={[styles.divider, {backgroundColor: theme.colors.border}]}
              />
              <View style={styles.breakdownRow}>
                <Text variant="bodyStrong">{t('payments.breakdownTotal')}</Text>
                <Text variant="title3" tabular>
                  {formatPEN(payment.amountCents)}
                </Text>
              </View>
            </Card>
          </EnterView>
          {driverId ? (
            <EnterView delay={260}>
              <Button
                label={t('payments.rateTrip')}
                variant="secondary"
                fullWidth
                onPress={() => navigation.replace('Rating', {tripId, driverId})}
              />
            </EnterView>
          ) : null}
        </View>
      </SafeScreen>
    );
  }

  return (
    <SafeScreen
      scroll
      footer={
        cashPending && payment ? (
          <Button
            label={t('payments.confirmCash')}
            fullWidth
            loading={confirmMutation.isPending}
            onPress={() => confirmMutation.mutate(payment.id)}
          />
        ) : (
          <Button
            label={
              chargeMutation.isPending
                ? t('payments.paying')
                : t('payments.payNow')
            }
            variant="accent"
            fullWidth
            loading={chargeMutation.isPending}
            onPress={() => chargeMutation.mutate()}
          />
        )
      }>
      <Card variant="elevated" padding="lg">
        <Text variant="callout" color="inkMuted">
          {t('payments.amount')}
        </Text>
        <Text variant="display" tabular>
          {formatPEN(amountCents + tipCents)}
        </Text>
      </Card>

      {chargeMutation.isError ? (
        <Banner
          tone="danger"
          title={t('payments.payError')}
          style={{marginTop: theme.spacing.md}}
        />
      ) : null}

      {/* Confirmación de efectivo fallida (`/payments/:id/cash/confirm`): antes el toque quedaba mudo
          (spinner que vuelve sin nada). Banner honesto → el mismo botón "Confirmar efectivo" reintenta. */}
      {confirmMutation.isError ? (
        <Banner
          tone="danger"
          title={t('payments.cashConfirmError')}
          style={{marginTop: theme.spacing.md}}
        />
      ) : null}

      <Text
        variant="title3"
        style={{marginTop: theme.spacing.xl, marginBottom: theme.spacing.sm}}>
        {t('payments.methodsTitle')}
      </Text>
      <Card variant="elevated" padding="sm">
        {PAYMENT_METHODS.map(item => (
          <ListItem
            key={item}
            title={t(`payments.method.${item}`)}
            trailing={
              item === method ? (
                <StatusPill label={t('payments.default')} tone="accent" dot />
              ) : undefined
            }
            onPress={() => setMethod(item)}
          />
        ))}
      </Card>

      <View style={{marginTop: theme.spacing.lg}}>
        <TextField
          label={t('payments.tip')}
          keyboardType="decimal-pad"
          value={tip}
          onChangeText={setTip}
        />
      </View>

      {isCash ? (
        <Banner
          tone="info"
          title={t('payments.cashNote')}
          style={{marginTop: theme.spacing.lg}}
        />
      ) : null}
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  divider: {height: 1, marginVertical: 8},
});
