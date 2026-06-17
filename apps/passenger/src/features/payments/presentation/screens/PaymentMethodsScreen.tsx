import type { MobilePaymentMethod } from '@veo/api-client';
import { affiliationStatus } from '@veo/api-client';
import { Button, Card, SafeScreen, StatusPill, Text, useTheme } from '@veo/ui-kit';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View } from 'react-native';
import { ScreenStateFallback } from '../../../../shared/presentation/components/ScreenStates';
import { EnterView } from '../components/motion';
import { PaymentInstrumentRow } from '../components/PaymentInstrumentRow';
import { YapeLinkSheet } from '../components/YapeLinkSheet';
import { YapeManageSheet } from '../components/YapeManageSheet';
import { useYapeAffiliation } from '../hooks/useYapeAffiliation';
import { PAYMENT_METHODS, usePaymentPrefsStore } from '../stores/paymentPrefsStore';

/** Resto de instrumentos (Yape se pinta aparte, primero, por su flujo propio). */
const OTHER_METHODS: readonly MobilePaymentMethod[] = PAYMENT_METHODS.filter((m) => m !== 'YAPE');

/**
 * Métodos de pago · UNA pantalla, patrón INSTRUMENTOS (estilo PedidosYa). Lista única de filas: glifo +
 * nombre + UNA línea de experiencia + estado/acción a la derecha. Yape va PRIMERO (es LA principal): sin
 * vincular invita ("Vincular" → sheet mínimo), vinculado muestra teléfono + "pago automático" y abre el
 * sheet de gestión. El resto describe el momento del cobro. Tap en cualquier fila = setear default.
 *
 * HUECO DE CONTRATO: el bff no expone métodos guardados; los métodos son el enum `mobilePaymentMethod`
 * y el default es una preferencia local. El cobro real ocurre al terminar el viaje (server-side).
 */
export function PaymentMethodsScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const defaultMethod = usePaymentPrefsStore((s) => s.defaultMethod);
  const setDefault = usePaymentPrefsStore((s) => s.setDefault);

  const affiliationQuery = useYapeAffiliation();

  const [linkSheetOpen, setLinkSheetOpen] = useState(false);
  const [manageSheetOpen, setManageSheetOpen] = useState(false);

  const defaultPill = t('payments.defaultPill');

  // ── 4 estados reales (degradación honesta) ──────────────────────────────────────────────────────
  // El estado de la afiliación Yape decide la fila principal ("Vincular" vs "vinculado"). NO podemos
  // pintarla hasta SABER el estado real: mientras carga → skeleton; si la consulta FALLÓ → error con
  // reintento. JAMÁS interpretamos un error de red como "no afiliado" (eso mostraría "Vincular" como si
  // el usuario hubiera perdido su Yape). El `status:'NONE'` legítimo solo llega en el caso SUCCESS.
  if (affiliationQuery.isLoading) {
    return <ScreenStateFallback loading loadingLines={5} />;
  }

  if (affiliationQuery.isError || !affiliationQuery.data) {
    return <ScreenStateFallback errorMessage={t('payments.loadError')} onRetry={() => affiliationQuery.refetch()} />;
  }

  // SUCCESS: `data` está garantizado. `status` es el valor REAL del bff ('NONE' = genuinamente sin
  // afiliar, NO un fallback ante error). Acá sí derivamos la presentación de la fila Yape.
  const yapeStatus = affiliationQuery.data.status.toUpperCase();
  const phoneMasked = affiliationQuery.data.phoneMasked ?? null;
  const isLinked = yapeStatus === affiliationStatus.enum.ACTIVE;
  const isProcess = yapeStatus === affiliationStatus.enum.PROCESS;

  // ── Fila Yape: línea + acción/estado según el status de la afiliación ───────────────────────────
  const yapeLine = isLinked
    ? phoneMasked
      ? t('payments.auto.linkedLine', { phone: phoneMasked })
      : t('payments.auto.linkedLineNoPhone')
    : isProcess
      ? t('payments.auto.processLine')
      : t('payments.line.YAPE');

  return (
    <SafeScreen scroll>
      <Text variant="callout" color="inkMuted" style={{ marginBottom: theme.spacing.lg }}>
        {t('payments.subtitle')}
      </Text>

      <Card variant="outlined" padding="sm">
        <View style={{ gap: theme.spacing.sm }}>
          {/* Yape · PRIMERO (instrumento principal). */}
          <EnterView index={0} offsetY={6}>
            <PaymentInstrumentRow
              method="YAPE"
              name={t('payments.method.YAPE')}
              line={yapeLine}
              emphasized={isLinked}
              isDefault={defaultMethod === 'YAPE'}
              defaultLabel={defaultPill}
              accessibilityHint={isLinked ? t('payments.auto.manageTitle') : t('payments.auto.link')}
              onPress={
                isLinked
                  ? () => setManageSheetOpen(true)
                  : isProcess
                    ? undefined
                    : () => setLinkSheetOpen(true)
              }
              action={
                isProcess ? (
                  <ActivityIndicator color={theme.colors.accent} />
                ) : !isLinked ? (
                  <Button
                    label={t('payments.auto.link')}
                    variant="primary"
                    size="sm"
                    onPress={() => setLinkSheetOpen(true)}
                  />
                ) : undefined
              }
              trailing={
                isLinked && defaultMethod !== 'YAPE' ? (
                  <StatusPill label={t('payments.autoBadge')} tone="success" dot />
                ) : undefined
              }
            />
          </EnterView>

          {/* Resto de instrumentos · tap = setear default. */}
          {OTHER_METHODS.map((method, index) => (
            <EnterView key={method} index={index + 1} offsetY={6}>
              <PaymentInstrumentRow
                method={method}
                name={t(`payments.method.${method}`)}
                line={t(`payments.line.${method}`)}
                isDefault={defaultMethod === method}
                defaultLabel={defaultPill}
                accessibilityHint={t('payments.setDefault')}
                onPress={() => setDefault(method)}
              />
            </EnterView>
          ))}
        </View>
      </Card>

      <YapeLinkSheet visible={linkSheetOpen} onClose={() => setLinkSheetOpen(false)} />
      <YapeManageSheet visible={manageSheetOpen} onClose={() => setManageSheetOpen(false)} />
    </SafeScreen>
  );
}
