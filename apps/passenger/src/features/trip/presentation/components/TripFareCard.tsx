import type {MobilePaymentMethod} from '@veo/api-client';
import {Card, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {PaymentMethodLogo} from '../../../../shared/assets/payment-methods/PaymentMethodLogo';
import {formatPEN} from '../../../../shared/utils/format';

/** Métodos con logo canónico. El `paymentMethod` del viaje es string; validamos antes de usar el logo. */
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'YAPE',
  'PLIN',
  'CASH',
  'CARD',
  'PAGOEFECTIVO',
]);

function asPaymentMethod(method: string): MobilePaymentMethod | null {
  const upper = method.toUpperCase();
  return KNOWN_METHODS.has(upper) ? (upper as MobilePaymentMethod) : null;
}

export interface TripFareCardProps {
  fareCents: number;
  /** Método de pago del viaje (enum del bff como string). Se pinta con su logo canónico si se reconoce. */
  paymentMethod: string;
}

/**
 * Tarifa total + método de pago del viaje. Usa el `PaymentMethodLogo` CANÓNICO (mismo círculo de marca
 * que las filas de pago) en vez del texto crudo "YAPE", para que el detalle se vea coherente con el
 * resto de la app y no "legacy". La tarifa va en grande y tabular (es el dato que el pasajero busca).
 */
export function TripFareCard({
  fareCents,
  paymentMethod,
}: TripFareCardProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const method = asPaymentMethod(paymentMethod);

  return (
    <Card variant="outlined" padding="lg">
      <View style={styles.row}>
        <Text variant="callout" color="inkMuted">
          {t('home.fare')}
        </Text>
        <Text variant="title2" tabular>
          {/* Guard de tarifa 0: un viaje sin tarifa conocida (aún sin liquidar / cancelado sin cargo)
              mostraba "S/ 0.00" como si fuera un cobro real → em-dash honesto (dato no disponible). */}
          {fareCents > 0 ? formatPEN(fareCents) : '—'}
        </Text>
      </View>
      <View
        style={[
          styles.row,
          styles.method,
          {
            marginTop: theme.spacing.md,
            borderTopColor: theme.colors.border,
            paddingTop: theme.spacing.md,
          },
        ]}>
        <Text variant="callout" color="inkMuted">
          {t('home.paymentMethod')}
        </Text>
        <View style={styles.methodValue}>
          {method ? <PaymentMethodLogo method={method} size={26} /> : null}
          <Text variant="bodyStrong">
            {method ? t(`payments.method.${method}`) : paymentMethod}
          </Text>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  method: {borderTopWidth: StyleSheet.hairlineWidth},
  methodValue: {flexDirection: 'row', alignItems: 'center', gap: 8},
});
