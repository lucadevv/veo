import type {PaymentView} from '@veo/api-client';
import {useQuery} from '@tanstack/react-query';
import {Card, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {formatPEN} from '../../../../shared/utils/format';
import {
  interpretPaymentOutcome,
  isCashPayment,
} from '../../../payments/domain/paymentOutcome';
import {SuccessCheck} from '../../../payments/presentation/components/motion';
import {EnterView} from './motion';

interface TripPaymentConfirmationProps {
  tripId: string;
  /**
   * Solo se pollea/renderiza durante el viaje EN CURSO: el cobro DIGITAL del pre-pago dispara al INICIAR
   * (server-initiated con Yape On-File), así que la confirmación tiene sentido recién en `inProgress`.
   */
  visible: boolean;
}

/**
 * Confirmación IN-APP del cobro automático durante el viaje EN CURSO. El pre-pago cobra lo DIGITAL al
 * INICIAR (Yape On-File server-initiated), pero el push del cobro NO llega al simulador iOS (Apple no
 * entrega push remoto al sim) — y aun en device se pierde fácil. Esta card le da al pasajero la certeza
 * DENTRO de la app, con la MISMA estética de éxito del cierre (el check animado `SuccessCheck`), sin
 * depender del push. Pollea `GET /payments/by-trip` y refleja el estado REAL. Auto-gateado (null si no
 * aplica): EFECTIVO → null (paga al bajar); digital CAPTURED → card de éxito; PENDING/checkout →
 * "Procesando tu pago…"; deuda/failed/refund → null (lo maneja la pantalla de CIERRE).
 */
export function TripPaymentConfirmation({
  tripId,
  visible,
}: TripPaymentConfirmationProps): React.JSX.Element | null {
  const theme = useTheme();
  const {t} = useTranslation();
  const getPaymentByTrip = useDependency(TOKENS.getPaymentByTripUseCase);

  const {data: payment} = useQuery<PaymentView | null, Error>({
    queryKey: ['payment', tripId, 'by-trip'],
    queryFn: () => getPaymentByTrip.execute(tripId),
    enabled: visible,
    // Poll suave MIENTRAS el cobro no resuelve (el consumer Kafka / webhook puede demorar); resuelto → se
    // apaga (comparte la queryKey con el recibo del cierre → sin doble fetch al completar).
    refetchInterval: query => {
      const p = query.state.data;
      if (!p) return 3000;
      const kind = interpretPaymentOutcome(p).kind;
      return kind === 'processing' || kind === 'checkoutPending' ? 3000 : false;
    },
  });

  if (!visible || !payment) return null;
  if (isCashPayment(payment)) return null;

  const kind = interpretPaymentOutcome(payment).kind;
  const settled = kind === 'settled';
  const processing = kind === 'processing' || kind === 'checkoutPending';
  if (!settled && !processing) return null;

  // PROCESANDO: cobro en vuelo (consumer/webhook). Nota sobria, sin el check todavía.
  if (processing) {
    return (
      <Card variant="outlined" padding="md">
        <Text variant="footnote" color="inkMuted">
          {t('trip.paymentAutoProcessing')}
        </Text>
      </Card>
    );
  }

  // CAPTURADO: la MISMA estética de éxito del cierre — check animado + título + monto·método.
  return (
    <EnterView>
      <Card variant="outlined" padding="md">
        <View style={[styles.row, {gap: theme.spacing.md}]}>
          <SuccessCheck size={40} />
          <View style={styles.body}>
            <Text variant="bodyStrong">{t('trip.paymentAutoTitle')}</Text>
            <Text variant="footnote" color="inkMuted" numberOfLines={1}>
              {t('trip.paymentAutoBody', {
                amount: formatPEN(payment.amountCents),
                method: t(`payments.method.${payment.method.toUpperCase()}`),
              })}
            </Text>
          </View>
        </View>
      </Card>
    </EnterView>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center'},
  body: {flex: 1, gap: 2},
});
