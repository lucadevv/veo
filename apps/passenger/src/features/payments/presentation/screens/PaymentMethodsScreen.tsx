import type {MobilePaymentMethod} from '@veo/api-client';
import {affiliationStatus} from '@veo/api-client';
import {Button, SafeScreen, StatusPill, Text, useTheme} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ActivityIndicator, View} from 'react-native';
import {
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {ScreenHeader} from '../../../../shared/presentation/components/ScreenHeader';
import {EnterView} from '../components/motion';
import {PaymentInstrumentRow} from '../components/PaymentInstrumentRow';
import {YapeLinkSheet} from '../components/YapeLinkSheet';
import {YapeManageSheet} from '../components/YapeManageSheet';
import {useYapeAffiliation} from '../hooks/useYapeAffiliation';
import {
  PAYMENT_METHODS,
  usePaymentPrefsStore,
} from '../stores/paymentPrefsStore';

/**
 * ORDEN DE PANTALLA per design/veo.pen Ofbr6: Efectivo primero, luego Yape, Plin (y después el resto
 * del enum). DERIVADO de la fuente canónica `PAYMENT_METHODS` (cero listas paralelas): solo se mueve
 * CASH al frente; el resto conserva el orden canónico (YAPE, PLIN, CARD, PAGOEFECTIVO).
 */
const DISPLAY_METHODS: readonly MobilePaymentMethod[] = [
  'CASH',
  ...PAYMENT_METHODS.filter(m => m !== 'CASH'),
];

/**
 * Métodos de pago · UNA pantalla per design/veo.pen Ofbr6: cada método es una CARD separada con la
 * metáfora de selección del pen (predeterminado = borde brand + check circular; el resto radio vacío,
 * en vez de la pill "Predeterminado"). Yape conserva COMPLETO su flujo de afiliación: sin vincular
 * invita ("Vincular" → sheet mínimo), vinculado muestra teléfono + "pago automático" y abre el sheet
 * de gestión. Tap en cualquier card = setear default.
 *
 * HUECO DE CONTRATO: el bff no expone métodos guardados; los métodos son el enum `mobilePaymentMethod`
 * y el default es una preferencia local. El cobro real ocurre al terminar el viaje (server-side).
 * El "Agregar método" del pen NO se implementa: el enum es cerrado (gap de producto reportado).
 * DEUDA: (backend) "Agregar método/tarjeta" (del .pen) no se implementa: el bff no expone instrumentos guardados y MobilePaymentMethod es enum cerrado. Falta backend de instrumentos (p.ej. /cards) + tarjeta F4 del roadmap.
 */
export function PaymentMethodsScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const defaultMethod = usePaymentPrefsStore(s => s.defaultMethod);
  const setDefault = usePaymentPrefsStore(s => s.setDefault);

  const affiliationQuery = useYapeAffiliation();

  const [linkSheetOpen, setLinkSheetOpen] = useState(false);
  const [manageSheetOpen, setManageSheetOpen] = useState(false);

  // ── 4 estados reales (degradación honesta) ──────────────────────────────────────────────────────
  // El estado de la afiliación Yape decide la fila principal ("Vincular" vs "vinculado"). NO podemos
  // pintarla hasta SABER el estado real: mientras carga → skeleton; si la consulta FALLÓ → error con
  // reintento. JAMÁS interpretamos un error de red como "no afiliado" (eso mostraría "Vincular" como si
  // el usuario hubiera perdido su Yape). El `status:'NONE'` legítimo solo llega en el caso SUCCESS.
  if (affiliationQuery.isLoading) {
    return (
      <SafeScreen>
        <ScreenHeader title={t('screens.paymentMethods')} />
        <LoadingState lines={5} />
      </SafeScreen>
    );
  }

  if (affiliationQuery.isError || !affiliationQuery.data) {
    return (
      <SafeScreen>
        <ScreenHeader title={t('screens.paymentMethods')} />
        <ErrorState
          message={t('payments.loadError')}
          onRetry={() => affiliationQuery.refetch()}
        />
      </SafeScreen>
    );
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
      ? t('payments.auto.linkedLine', {phone: phoneMasked})
      : t('payments.auto.linkedLineNoPhone')
    : isProcess
      ? t('payments.auto.processLine')
      : t('payments.line.YAPE');

  return (
    <SafeScreen scroll>
      {/* Header in-body (patrón ScreenHeader del pen): el subtítulo propio se pliega al header. */}
      <View style={{marginBottom: theme.spacing.lg}}>
        <ScreenHeader
          title={t('screens.paymentMethods')}
          subtitle={t('payments.subtitle')}
        />
      </View>

      {/* Cards por método en el ORDEN del pen (Efectivo, Yape, Plin, …). Yape conserva su flujo. */}
      <View style={{gap: theme.spacing.md}}>
        {DISPLAY_METHODS.map((method, index) =>
          method === 'YAPE' ? (
            <EnterView key={method} index={index} offsetY={6}>
              <PaymentInstrumentRow
                method="YAPE"
                name={t('payments.method.YAPE')}
                line={yapeLine}
                emphasized={isLinked}
                isDefault={defaultMethod === 'YAPE'}
                // Mientras la afiliación está EN PROCESO la fila no participa de la selección
                // (spinner a la derecha, sin radio que sugiera un tap que no hace nada).
                selectable={!isProcess}
                accessibilityHint={
                  isLinked
                    ? t('payments.auto.manageTitle')
                    : t('payments.auto.link')
                }
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
                    <StatusPill
                      label={t('payments.autoBadge')}
                      tone="success"
                      dot
                    />
                  ) : undefined
                }
              />
            </EnterView>
          ) : (
            <EnterView key={method} index={index} offsetY={6}>
              <PaymentInstrumentRow
                method={method}
                name={t(`payments.method.${method}`)}
                line={t(`payments.line.${method}`)}
                isDefault={defaultMethod === method}
                accessibilityHint={t('payments.setDefault')}
                onPress={() => setDefault(method)}
              />
            </EnterView>
          ),
        )}
      </View>

      {/* La aclaración del MODELO de cobro (antes en el subtítulo) sobrevive como nota al pie. */}
      <Text
        variant="footnote"
        color="inkSubtle"
        style={{marginTop: theme.spacing.lg}}>
        {t('payments.chargeNote')}
      </Text>

      <YapeLinkSheet
        visible={linkSheetOpen}
        onClose={() => setLinkSheetOpen(false)}
      />
      <YapeManageSheet
        visible={manageSheetOpen}
        onClose={() => setManageSheetOpen(false)}
      />
    </SafeScreen>
  );
}
