import type {PaymentView} from '@veo/api-client';
import {useQuery} from '@tanstack/react-query';
import {hexAlpha, Text, useTheme} from '@veo/ui-kit';
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
import {IconCheck} from './icons';

interface TripPaymentConfirmationProps {
  tripId: string;
  /**
   * Solo se pollea/renderiza durante el viaje EN CURSO: el cobro DIGITAL del pre-pago dispara al INICIAR
   * (server-initiated con Yape On-File), así que la confirmación tiene sentido recién en `inProgress`.
   */
  visible: boolean;
}

/**
 * Indicador IN-APP del cobro automático durante el viaje EN CURSO. El pre-pago cobra lo DIGITAL al INICIAR
 * (Yape On-File server-initiated), pero el push del cobro NO llega al simulador iOS (Apple no entrega push
 * remoto al sim) — y aun en device es una señal que se pierde fácil. Este badge le da al pasajero la
 * confirmación DENTRO de la app, sin depender del push: pollea `GET /payments/by-trip` y refleja el estado
 * REAL del cobro. Auto-gateado (renderiza null si no aplica):
 *  - EFECTIVO → null (se paga al bajar, no hay cobro automático que confirmar).
 *  - digital CAPTURED → "Pago confirmado · S/X" (check verde sutil).
 *  - digital PENDING/checkout → "Procesando tu pago…" (mientras el consumer/webhook resuelve).
 *  - debt/failed/refunded → null (lo maneja la pantalla de CIERRE, no el viaje en curso).
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

  return (
    <View
      style={[
        styles.row,
        {
          gap: theme.spacing.xs,
          paddingVertical: theme.spacing.xs,
          paddingHorizontal: theme.spacing.sm,
          borderRadius: theme.radii.md,
          backgroundColor: hexAlpha(
            settled ? theme.colors.success : theme.colors.inkMuted,
            0.1,
          ),
        },
      ]}>
      {settled ? <IconCheck color={theme.colors.success} size={16} /> : null}
      <Text
        variant="footnote"
        color={settled ? 'successText' : 'inkMuted'}
        style={styles.label}
        numberOfLines={1}>
        {settled
          ? t('trip.paymentAutoConfirmed', {amount: formatPEN(payment.amountCents)})
          : t('trip.paymentAutoProcessing')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center'},
  label: {flex: 1},
});
