import type { PaymentView } from '@veo/api-client';
import { Banner, Button, Card, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Clipboard, Image, StyleSheet, View } from 'react-native';
import { formatDateTime } from '../../../../shared/utils/format';
import { openExternalUrl } from '../../../../shared/utils/linking';

/**
 * ¿El pago trae instrucciones de checkout para completar el pago digital? (ProntoPaga). Cualquiera de
 * deepLink / checkoutUrl / qrCode / cip habilita la rama "Completa tu pago". Si TODOS son null/ausentes
 * (sandbox sin checkout), NO hay rama de checkout → el llamador cae a su propio estado "procesando".
 */
export function hasCheckout(payment: PaymentView): boolean {
  return Boolean(payment.deepLink || payment.checkoutUrl || payment.qrCode || payment.cip);
}

/** ¿El checkout ya venció? (`checkoutExpiresAt` en el pasado). Sin fecha, no lo damos por vencido. */
export function isCheckoutExpired(payment: PaymentView): boolean {
  if (!payment.checkoutExpiresAt) {
    return false;
  }
  const ts = Date.parse(payment.checkoutExpiresAt);
  return Number.isFinite(ts) && ts < Date.now();
}

export interface CheckoutInstructionsProps {
  /** Pago PENDING con checkout (ProntoPaga): trae al menos uno de deepLink/url/qr/cip. */
  payment: PaymentView;
  /** Reintenta el poll (tras pagar, el webhook pasa a CAPTURED) o regenera un checkout vencido. */
  onRetry: () => void;
  /** El poll está en vuelo (deshabilita/loadea el botón de reintento). */
  retrying: boolean;
  /**
   * Encabezado de la rama de checkout (título + cuerpo). Distinto según el origen del cobro: recibo del
   * viaje ("Completa tu pago") vs saldar una deuda ("Termina tu pago"). El COMPONENTE comparte el render
   * de los MEDIOS (deepLink/web/QR/CIP), que es lo que NO queremos copy-pastear entre el recibo y el sheet
   * de deuda. Si se omite, usa el copy canónico del recibo (`settlement.checkout.*`).
   */
  header?: React.ReactNode;
}

/**
 * MEDIOS de checkout de un pago digital PENDING (ProntoPaga), COMPARTIDOS entre el recibo del viaje
 * (`SettlementBody`) y el sheet de deuda (`DebtSheet`): el usuario completa el pago acá (deepLink Yape /
 * web / QR / CIP) y el poll del llamador, al confirmar el webhook, pasa a CAPTURED solo. Estado honesto
 * si venció (`checkoutExpiresAt` pasado): "el código venció" + reintentar. Extraído para NO duplicar el
 * render del checkout en dos pantallas (era la regla del dueño: un solo lenguaje de "cómo pagar").
 *
 * NO incluye el desglose del recibo (`ReceiptCard`): eso es responsabilidad de cada llamador, porque el
 * recibo y la deuda muestran montos distintos (total del viaje vs monto de la deuda concreta).
 */
export function CheckoutInstructions({
  payment,
  onRetry,
  retrying,
  header,
}: CheckoutInstructionsProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);
  // Copia del ENLACE de pago (deepLink) — estado propio para no confundirse con el "copiar CIP".
  const [payLinkCopied, setPayLinkCopied] = React.useState(false);
  // Falla al ABRIR un medio externo (openURL rechazó: Yape no instalada / esquema desconocido). Aviso
  // honesto + fallback. 'yape' = el deepLink no abrió; 'web' = la urlPay web tampoco. null = sin error.
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
          title={t('settlement.checkout.expiredTitle')}
          description={t('settlement.checkout.expiredBody')}
        />
        <Button
          label={t('actions.retry')}
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
      {header ?? (
        <>
          <Text variant="title3">{t('settlement.checkout.title')}</Text>
          <Text variant="callout" color="inkMuted">
            {t('settlement.checkout.body')}
          </Text>
        </>
      )}

      {/* deepLink → app del wallet (Yape). Botón primario. */}
      {payment.deepLink ? (
        <Button
          label={t('settlement.checkout.payWithYape')}
          variant="primary"
          fullWidth
          onPress={() => {
            void onOpenDeepLink();
          }}
        />
      ) : null}

      {/* Aviso HONESTO si Yape no abrió automáticamente (en sandbox el esquema del deepLink no está
          registrado; NO culpamos al usuario). Si hay urlPay web, el botón "Pagar desde el navegador" de
          abajo es el fallback. Si NO hay web, ofrecemos "Copiar enlace de pago" (Clipboard) como salida. */}
      {openError === 'yape' ? (
        <Banner
          tone="warn"
          title={t('settlement.checkout.openYapeFailedTitle')}
          description={t(
            payment.checkoutUrl
              ? 'settlement.checkout.openYapeFailedBody'
              : 'settlement.checkout.openYapeFailedBodyNoWeb',
          )}
        />
      ) : null}

      {/* Sin web y con el deepLink que no abrió: copiar el enlace de pago para abrirlo manualmente en
          Yape. Salida honesta (NADA que culpe al usuario), reusa el patrón Clipboard del CIP. */}
      {openError === 'yape' && !payment.checkoutUrl && payment.deepLink ? (
        <Button
          label={
            payLinkCopied
              ? t('settlement.checkout.payLinkCopied')
              : t('settlement.checkout.copyPayLink')
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

      {/* checkoutUrl → web hospedada / navegador. Es también el FALLBACK cuando el deepLink no abre. */}
      {payment.checkoutUrl ? (
        <Button
          label={t(
            openError === 'yape'
              ? 'settlement.checkout.payInBrowser'
              : 'settlement.checkout.payNow',
          )}
          variant={payment.deepLink ? 'secondary' : 'primary'}
          fullWidth
          onPress={() => {
            void onOpenWeb();
          }}
        />
      ) : null}

      {/* La web de pago tampoco abrió: aviso honesto, deja reintentar (el botón sigue presente). */}
      {openError === 'web' ? (
        <Banner
          tone="warn"
          title={t('settlement.checkout.openWebFailedTitle')}
          description={t('settlement.checkout.openWebFailedBody')}
        />
      ) : null}

      {/* qrCode → imagen (data-URI base64) con instrucción y accessibilityLabel. */}
      {payment.qrCode ? (
        <Card variant="outlined" padding="lg">
          <View style={{ gap: theme.spacing.md, alignItems: 'center' }}>
            <Image
              source={{ uri: payment.qrCode }}
              style={styles.qr}
              resizeMode="contain"
              accessible
              accessibilityLabel={t('settlement.checkout.qrAccessibility')}
            />
            <Text variant="footnote" color="inkMuted" align="center">
              {t('settlement.checkout.qrInstruction')}
            </Text>
          </View>
        </Card>
      ) : null}

      {/* cip → código CIP grande, copiable (Clipboard) + dónde pagarlo. */}
      {payment.cip ? (
        <Card variant="outlined" padding="lg">
          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="footnote" color="inkMuted">
              {t('settlement.checkout.cipLabel')}
            </Text>
            <Text variant="title2" tabular selectable accessibilityLabel={payment.cip}>
              {payment.cip}
            </Text>
            <Text variant="footnote" color="inkMuted">
              {t('settlement.checkout.cipInstruction')}
            </Text>
            <Button
              label={copied ? t('settlement.checkout.cipCopied') : t('settlement.checkout.copy')}
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
          {t('settlement.checkout.expiresAt', { date: formatDateTime(payment.checkoutExpiresAt) })}
        </Text>
      ) : null}
      <Text variant="footnote" color="inkMuted" align="center">
        {t('settlement.checkout.waitingHint')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  qr: { width: 220, height: 220, borderRadius: 12 },
});
