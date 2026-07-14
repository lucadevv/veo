import type { PaymentView } from '@veo/api-client';
import { Banner, Button, Card, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Clipboard, Image, StyleSheet, View } from 'react-native';
import { formatShortDate, formatTimeOfDay } from '../../../../shared/presentation/format';
import { openExternalUrl } from '../../../../shared/utils/linking';

/** ¿El checkout ya venció? (`checkoutExpiresAt` en el pasado). Sin fecha, no lo damos por vencido. */
export function isCheckoutExpired(payment: PaymentView): boolean {
  if (!payment.checkoutExpiresAt) {
    return false;
  }
  const ts = Date.parse(payment.checkoutExpiresAt);
  return Number.isFinite(ts) && ts < Date.now();
}

export interface DebtCheckoutInstructionsProps {
  /** Pago de LIQUIDACIÓN PENDING con checkout (ProntoPaga): trae al menos uno de deepLink/url/qr/cip. */
  payment: PaymentView;
  /** Reintenta el checkout: re-llama el settle (idempotente → mismo checkout, o uno nuevo si venció). */
  onRetry: () => void;
  /** El reintento/poll está en vuelo (deshabilita/loadea el botón). */
  retrying: boolean;
}

/**
 * MEDIOS de checkout del cobro de liquidación de la deuda (ProntoPaga), fiel al patrón del PASAJERO
 * (`CheckoutInstructions`): el conductor completa el pago acá (deepLink Yape / web Tarjeta / QR Plin / CIP)
 * y el poll del llamador, al confirmar la captura, desbloquea la cuenta. Estado honesto si venció.
 */
export function DebtCheckoutInstructions({
  payment,
  onRetry,
  retrying,
}: DebtCheckoutInstructionsProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);
  const [payLinkCopied, setPayLinkCopied] = React.useState(false);
  // Falla al ABRIR un medio externo (Yape no instalada / esquema desconocido / web no abrió). Aviso honesto.
  const [openError, setOpenError] = React.useState<'yape' | 'web' | null>(null);

  const onOpenDeepLink = React.useCallback(async () => {
    if (!payment.deepLink) {
      return;
    }
    const ok = await openExternalUrl(payment.deepLink);
    setOpenError(ok ? null : 'yape');
  }, [payment.deepLink]);

  const onOpenWeb = React.useCallback(async () => {
    if (!payment.checkoutUrl) {
      return;
    }
    const ok = await openExternalUrl(payment.checkoutUrl);
    setOpenError(ok ? null : 'web');
  }, [payment.checkoutUrl]);

  // Vencido → estado honesto, sin botones de pago que ya no sirven.
  if (isCheckoutExpired(payment)) {
    return (
      <View style={{ gap: theme.spacing.md }}>
        <Banner
          tone="warn"
          title={t('debt.checkout.expiredTitle')}
          description={t('debt.checkout.expiredBody')}
        />
        <Button
          label={t('common.retry')}
          variant="primary"
          fullWidth
          loading={retrying}
          onPress={onRetry}
        />
      </View>
    );
  }

  return (
    <View style={{ gap: theme.spacing.md }}>
      <Text variant="title3">{t('debt.checkout.title')}</Text>
      <Text variant="callout" color="inkMuted">
        {t('debt.checkout.body')}
      </Text>

      {/* deepLink → app del wallet (Yape). Botón primario. */}
      {payment.deepLink ? (
        <Button
          label={t('debt.checkout.payWithYape')}
          variant="primary"
          fullWidth
          onPress={() => {
            void onOpenDeepLink();
          }}
        />
      ) : null}

      {/* Aviso HONESTO si Yape no abrió (en sandbox el esquema no está registrado; NO culpamos al conductor). */}
      {openError === 'yape' ? (
        <Banner
          tone="warn"
          title={t('debt.checkout.openYapeFailedTitle')}
          description={t(
            payment.checkoutUrl
              ? 'debt.checkout.openYapeFailedBody'
              : 'debt.checkout.openYapeFailedBodyNoWeb',
          )}
        />
      ) : null}

      {/* Sin web y con el deepLink que no abrió: copiar el enlace para abrirlo manualmente en Yape. */}
      {openError === 'yape' && !payment.checkoutUrl && payment.deepLink ? (
        <Button
          label={
            payLinkCopied ? t('debt.checkout.payLinkCopied') : t('debt.checkout.copyPayLink')
          }
          variant="secondary"
          fullWidth
          onPress={() => {
            if (payment.deepLink) {
              Clipboard.setString(payment.deepLink);
              setPayLinkCopied(true);
            }
          }}
        />
      ) : null}

      {/* checkoutUrl → web hospedada (Tarjeta). También el FALLBACK cuando el deepLink no abre. */}
      {payment.checkoutUrl ? (
        <Button
          label={t(
            openError === 'yape' ? 'debt.checkout.payInBrowser' : 'debt.checkout.payNow',
          )}
          variant={payment.deepLink ? 'secondary' : 'primary'}
          fullWidth
          onPress={() => {
            void onOpenWeb();
          }}
        />
      ) : null}

      {openError === 'web' ? (
        <Banner
          tone="warn"
          title={t('debt.checkout.openWebFailedTitle')}
          description={t('debt.checkout.openWebFailedBody')}
        />
      ) : null}

      {/* qrCode → imagen (data-URI base64) con instrucción y accessibilityLabel (Plin). */}
      {payment.qrCode ? (
        <Card variant="outlined" padding="lg">
          <View style={{ gap: theme.spacing.md, alignItems: 'center' }}>
            <Image
              source={{ uri: payment.qrCode }}
              style={styles.qr}
              resizeMode="contain"
              accessible
              accessibilityLabel={t('debt.checkout.qrAccessibility')}
            />
            <Text variant="footnote" color="inkMuted" align="center">
              {t('debt.checkout.qrInstruction')}
            </Text>
          </View>
        </Card>
      ) : null}

      {/* cip → código CIP grande, copiable + dónde pagarlo (PagoEfectivo). */}
      {payment.cip ? (
        <Card variant="outlined" padding="lg">
          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="footnote" color="inkMuted">
              {t('debt.checkout.cipLabel')}
            </Text>
            <Text variant="title2" tabular selectable accessibilityLabel={payment.cip}>
              {payment.cip}
            </Text>
            <Text variant="footnote" color="inkMuted">
              {t('debt.checkout.cipInstruction')}
            </Text>
            <Button
              label={copied ? t('debt.checkout.cipCopied') : t('debt.checkout.copy')}
              variant="secondary"
              fullWidth
              onPress={() => {
                if (payment.cip) {
                  Clipboard.setString(payment.cip);
                  setCopied(true);
                }
              }}
            />
          </View>
        </Card>
      ) : null}

      {/* Vencimiento + hint de actualización automática. */}
      {payment.checkoutExpiresAt ? (
        <Text variant="footnote" color="inkMuted" align="center">
          {t('debt.checkout.expiresAt', {
            date: `${formatShortDate(payment.checkoutExpiresAt)} ${formatTimeOfDay(
              payment.checkoutExpiresAt,
            )}`,
          })}
        </Text>
      ) : null}
      <Text variant="footnote" color="inkMuted" align="center">
        {t('debt.checkout.waitingHint')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  qr: { width: 220, height: 220, borderRadius: 12 },
});
