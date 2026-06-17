import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import {formatPEN} from '../../../../shared/utils/format';

export interface DebtStripProps {
  /**
   * `debt` = hay una DEUDA real (cobro en DEBT, bloquea pedir): franja warn con el monto + "Resolver".
   * `pendingAction` = hay un PAGO POR COMPLETAR (PENDING con checkout vivo, NO bloquea): franja info sin
   * monto + "Continuar" → abre el checkout directo. El home prioriza la deuda (es lo accionable urgente).
   */
  kind: 'debt' | 'pendingAction';
  /** Monto a mostrar (solo en `debt`). En `pendingAction` no mostramos monto: no es una cuenta a saldar. */
  amountCents: number;
  onPress: () => void;
}

/**
 * Señal PASIVA del home idle, sin castigo. Dos variantes:
 *  - DEUDA (warn sobrio): "Tienes un pago pendiente · S/ 23.00 — Resolver". Toca → DebtSheet (saldar).
 *  - PAGO POR COMPLETAR (info): "Tienes un pago por completar — Continuar". Toca → DebtSheet abre DIRECTO
 *    el checkout del cobro fresco (resuelve el dead-end del pago que quedó a medias).
 * El pasajero decide cuándo; la franja nunca bloquea desde el home.
 */
export function DebtStrip({
  kind,
  amountCents,
  onPress,
}: DebtStripProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const isDebt = kind === 'debt';
  // DEUDA → warn (sobrio, urgente). PAGO POR COMPLETAR → accent (el verde de la marca: invita, no alarma).
  const accentColor = isDebt ? theme.colors.warn : theme.colors.accent;
  const title = isDebt ? t('debt.homeBannerTitle') : t('debt.homePendingTitle');
  const action = isDebt
    ? t('debt.homeBannerAction')
    : t('debt.homePendingAction');
  const a11y = isDebt
    ? `${title} ${formatPEN(amountCents)}. ${action}`
    : `${title}. ${action}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      onPress={onPress}
      style={[
        styles.debtStrip,
        {
          backgroundColor: theme.colors.surface,
          borderColor: accentColor,
          borderRadius: theme.radii.md,
        },
      ]}>
      <View style={[styles.debtDot, {backgroundColor: accentColor}]} />
      <Text variant="subhead" numberOfLines={1} style={styles.debtLabel}>
        {title}
        {isDebt ? (
          <>
            {'  ·  '}
            <Text variant="bodyStrong" tabular>
              {formatPEN(amountCents)}
            </Text>
          </>
        ) : null}
      </Text>
      <Text variant="subhead" color="accent" numberOfLines={1}>
        {action}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Franja pasiva de deuda: borde warn sobrio, punto + label + acción. Sin fondo alarmante (no castiga).
  debtStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
  },
  debtDot: {width: 7, height: 7, borderRadius: 999},
  debtLabel: {flex: 1},
});
