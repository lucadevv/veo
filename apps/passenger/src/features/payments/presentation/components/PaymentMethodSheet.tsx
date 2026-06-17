import type {MobilePaymentMethod} from '@veo/api-client';
import {BottomSheet, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {View} from 'react-native';
import {PAYMENT_METHODS} from '../stores/paymentPrefsStore';
import {PaymentMethodPicker} from './PaymentMethodPicker';

export interface PaymentMethodSheetProps {
  visible: boolean;
  /** Método actualmente elegido PARA ESTE VIAJE (no el predeterminado del perfil). */
  selected: MobilePaymentMethod;
  /**
   * El método PREDETERMINADO del perfil ("con qué pagas siempre"). Su fila se marca con "Tu
   * predeterminado" para que SIEMPRE se vea cuál es, independiente de lo elegido para este viaje (TASK 2).
   */
  defaultMethod: MobilePaymentMethod;
  /**
   * ¿La afiliación Yape (On-File) está ACTIVA? Distingue LÉXICAMENTE la fila YAPE (TASK 4): activa →
   * "Yape · automático" (se cobra solo); inactiva → "Yape" a secas (pagas con QR al terminar). NO badge
   * "Automático" en el one-shot.
   */
  yapeAutoActive?: boolean;
  onClose: () => void;
  /**
   * Elige el método para este viaje y cierra. `remember` = el toggle "Recordar como predeterminado":
   * si es true, el llamador hace `setDefault(method)`; si no, la elección aplica SOLO a este viaje.
   */
  onSelect: (method: MobilePaymentMethod, remember: boolean) => void;
}

/**
 * Selector de método de pago PARA ESTE VIAJE (al pedir). Bottom-sheet que delega la lista al componente
 * CANÓNICO `PaymentMethodPicker` (variante `full`): mismas filas, mismo logo circular, mismos labels
 * es-PE que el resto de superficies de pago. El sheet solo aporta el marco (título, subtítulo) y conecta
 * el modelo de 3 conceptos (TASK 2):
 *  - la fila del PREDETERMINADO lleva la marca "Tu predeterminado" (`defaultMethod` → default-pill),
 *  - elegir otra fila aplica SOLO a este viaje (el caller no pisa el predeterminado salvo `remember`),
 *  - el toggle "Recordar como mi método predeterminado" (`rememberToggle`) permite ascender la elección.
 * La fila YAPE se distingue léxicamente según la afiliación (TASK 4): "Yape · automático" vs "Yape".
 *
 * La FUENTE de métodos es única: `PAYMENT_METHODS` (store). El sheet pasa la lista completa al picker.
 */
export function PaymentMethodSheet({
  visible,
  selected,
  defaultMethod,
  yapeAutoActive = false,
  onClose,
  onSelect,
}: PaymentMethodSheetProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('payments.selectTitle')}>
      <View style={{gap: theme.spacing.lg}}>
        <Text variant="callout" color="inkMuted">
          {t('payments.selectSubtitle')}
        </Text>

        {/* Remontamos el picker por apertura (`key={visible}`) para que el toggle "recordar" arranque
            SIEMPRE apagado: una decisión por apertura, nunca arrastra el estado anterior (sería un
            cambio silencioso de la preferencia). */}
        <PaymentMethodPicker
          key={visible ? 'open' : 'closed'}
          variant="full"
          methods={PAYMENT_METHODS}
          selected={selected}
          defaultMethod={defaultMethod}
          yapeAutoActive={yapeAutoActive}
          rememberToggle
          onSelect={onSelect}
        />
      </View>
    </BottomSheet>
  );
}
