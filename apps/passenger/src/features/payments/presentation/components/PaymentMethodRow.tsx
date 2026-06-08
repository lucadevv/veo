import type { MobilePaymentMethod } from '@veo/api-client';
import { StatusPill, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { PaymentMethodLogo } from '../../../../shared/assets/payment-methods';

export interface PaymentMethodRowProps {
  /** Método elegido PARA ESTE VIAJE (inicializado del default del perfil). */
  method: MobilePaymentMethod;
  /** Abre el selector (bottom-sheet). */
  onPress: () => void;
  disabled?: boolean;
  /**
   * El cobro automático con Yape está ACTIVO (afiliación Yape On File). Cuando el método es YAPE,
   * mostramos una señal sutil ("automático"): la app NO decide el cobro (es server-side), solo lo
   * refleja para que el usuario sepa que ese viaje se cobrará solo al terminar.
   */
  autoActive?: boolean;
}

/**
 * Row COMPACTA de método de pago en el flujo de pedir (antes del CTA). Muestra la selección ACTUAL
 * (label "Método de pago" + nombre es-PE) y deriva al selector con un chevron "Cambiar". Jerarquía
 * SECUNDARIA al CTA primario (sin fondo de relleno, texto callout), hit-target ≥44pt. Solo refleja y
 * dispara: el estado vive en el quoting (no pisa el default del perfil).
 */
export function PaymentMethodRow({
  method,
  onPress,
  disabled = false,
  autoActive = false,
}: PaymentMethodRowProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  // Señal sutil solo cuando el método es YAPE y el cobro automático está activo (reflejo, no decisión).
  // Es el Yape VINCULADO (On-File). El one-shot (Yape sin afiliación) NO lleva esta señal (TASK 4).
  const isYapeAuto = autoActive && method === 'YAPE';
  const showAutoBadge = isYapeAuto;
  // Nombre distinguido LÉXICAMENTE (TASK 4): "Yape · automático" cuando hay afiliación; "Yape" a secas
  // (one-shot, QR al final) cuando no. El resto de métodos usan su nombre canónico.
  const methodName = isYapeAuto ? t('payments.nameYapeAuto') : t(`payments.method.${method}`);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t('payments.rowLabel')}: ${t(`payments.method.${method}`)}`}
      accessibilityHint={t('actions.change')}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: 56,
          gap: theme.spacing.md,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
          borderRadius: theme.radii.md,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface,
          opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        },
      ]}
    >
      {/* Logo circular consistente (el componente dibuja su propio círculo). */}
      <PaymentMethodLogo method={method} size={36} />

      <View style={styles.body}>
        <Text variant="footnote" color="inkMuted" numberOfLines={1}>
          {t('payments.rowLabel')}
        </Text>
        <View style={[styles.nameRow, { gap: theme.spacing.xs }]}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {methodName}
          </Text>
          {showAutoBadge ? (
            <StatusPill label={t('payments.autoBadge')} tone="success" dot />
          ) : null}
        </View>
      </View>

      <Text variant="subhead" color="accent">
        {t('actions.change')}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  body: { flex: 1, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
});
