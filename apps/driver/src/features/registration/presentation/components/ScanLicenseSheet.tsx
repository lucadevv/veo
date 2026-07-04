import React, { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner, BottomSheet, Button, Text, useTheme } from '@veo/ui-kit';
import { scanMessageI18nKey } from '../../../documents/domain';
import { deriveDocumentPhase, type DocumentFacePhases } from '../state/registrationStore';
import { useScanLicense } from '../hooks/useScanLicense';
import {
  ScanExtractRow,
  ScanFacePreview,
  ScanSendingBar,
  ScanStatusLine,
  formatDocumentDate,
  scanSheetStyles as s,
} from './scanSheetParts';

/**
 * Sheet de captura de la LICENCIA de conducir (paso 1 · flujo EAGER a imagen del frame `C/ScanLicencia`):
 * ESPEJO del `ScanDniSheet`. Escanea anverso + reverso, lee número + vencimiento por OCR y, al confirmar,
 * dispara la subida INMEDIATA con estados POR CARA (subiendo azul → enviado verde / error rojo) + el
 * `onboard`. Como la licencia se registra DESPUÉS del DNI (el driver lo crea el PATCH del DNI), si aún no
 * existe el conductor el envío devuelve `needs-dni` y el sheet avisa "primero escaneá tu DNI".
 *
 * Sin bloque de duplicado (solo el DNI tiene check de unicidad). Estados HONESTOS vía `useScanLicense` +
 * las fases por-cara del store. Reusa las piezas visuales canónicas de `scanSheetParts`.
 */
export interface ScanLicenseSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Fases de envío POR CARA de la licencia (del store): azul=subiendo, verde=enviado, rojo=error. */
  facePhases: DocumentFacePhases;
  /** La licencia se intentó ANTES que el DNI (driver aún no creado): pinta el aviso "primero el DNI". */
  needsDni: boolean;
  /** Confirma la captura y dispara la subida EAGER (subir licencia por cara + onboard). La orquesta la pantalla. */
  onConfirm: () => void;
  /** Limpia el aviso `needsDni` al reescanear. */
  onRescan: () => void;
}

export function ScanLicenseSheet({
  visible,
  onClose,
  facePhases,
  needsDni,
  onConfirm,
}: ScanLicenseSheetProps): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  const license = useScanLicense();

  useEffect(() => {
    if (visible) {
      license.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const documentPhase = deriveDocumentPhase(facePhases);
  const isScanning = license.state === 'scanning';
  const isCaptured = license.state === 'captured';
  const isReady = license.state === 'ready';
  const isError = license.state === 'error';
  const busy = isScanning;

  const isSending = isReady && documentPhase === 'sending';
  const isSent = isReady && documentPhase === 'sent';
  const sendFailed = isReady && documentPhase === 'error';

  // Válido para confirmar: hay anverso Y el OCR leyó los críticos (número + vencimiento).
  const canConfirm = isCaptured && license.front != null && !license.criticalMissing;
  const onPrimary = (): void => {
    if (canConfirm) {
      license.submit();
      onConfirm();
      return;
    }
    void license.scan();
  };

  const primaryLabel = canConfirm
    ? t('registration.documents.scanLicense.useLicense')
    : license.front
      ? t('registration.actions.rescan')
      : t('registration.personal.scanDni.cta');

  const footer = needsDni ? (
    <Button label={t('common.close')} variant="primary" fullWidth onPress={onClose} />
  ) : isSending ? (
    <Button
      label={t('registration.documents.sheetBackground')}
      variant="secondary"
      fullWidth
      onPress={onClose}
    />
  ) : sendFailed ? (
    <View style={s.footer}>
      <Button label={t('common.close')} variant="secondary" onPress={onClose} />
      <Button label={t('registration.actions.retryUpload')} variant="primary" onPress={onConfirm} />
    </View>
  ) : isReady ? (
    <Button label={t('common.close')} variant="primary" fullWidth onPress={onClose} />
  ) : (
    <View style={s.footer}>
      <Button label={t('common.cancel')} variant="secondary" onPress={onClose} disabled={busy} />
      <Button
        label={primaryLabel}
        variant="primary"
        loading={busy}
        disabled={busy}
        onPress={onPrimary}
      />
    </View>
  );

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('registration.documents.scanLicense.title')}
      footer={footer}
    >
      <View style={[s.body, { gap: theme.spacing.lg }]}>
        {needsDni ? null : (
          <Text variant="footnote" color="inkSubtle">
            {t('registration.documents.scanLicense.hint')}
          </Text>
        )}

        {/* Preview de las 2 caras con borde por estado de ENVÍO (azul=subiendo, verde=enviado, rojo=error). */}
        <View style={[s.facesRow, { gap: theme.spacing.md }]}>
          <ScanFacePreview
            label={t('registration.documents.scanLicense.front')}
            uri={license.front?.uri ?? null}
            scanning={isScanning}
            phase={isReady ? facePhases.front : 'idle'}
            dimmed={needsDni}
          />
          <ScanFacePreview
            label={t('registration.documents.scanLicense.back')}
            uri={license.back?.uri ?? null}
            scanning={isScanning}
            phase={isReady ? facePhases.back : 'idle'}
            dimmed={needsDni}
          />
        </View>

        {/* Aviso: la licencia se intentó antes que el DNI. Se registra DESPUÉS del DNI (que crea el driver). */}
        {needsDni ? (
          <Banner
            tone="warn"
            title={t('registration.documents.scanLicense.needsDniTitle')}
            description={t('registration.documents.scanLicense.needsDniBody')}
          />
        ) : null}

        {/* "Esto leímos de tu licencia": número + vencimiento leídos por OCR. Antes de enviar, con crítico OK. */}
        {!needsDni && isCaptured && !license.criticalMissing ? (
          <View
            style={[
              s.extract,
              {
                backgroundColor: theme.colors.surfaceElevated,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.md,
                gap: theme.spacing.sm,
              },
            ]}
          >
            <Text variant="footnote" color="ink" style={s.extractTitle}>
              {t('registration.documents.scanLicense.extracted')}
            </Text>
            <ScanExtractRow
              label={t('registration.documents.scanLicense.fieldNumber')}
              value={license.licenseNumber ?? ''}
              mono
            />
            <ScanExtractRow
              label={t('registration.documents.scanLicense.fieldExpiry')}
              value={formatDocumentDate(license.expiresAt ?? '')}
              mono
            />
          </View>
        ) : null}

        {!needsDni && isCaptured && !license.criticalMissing ? (
          <ScanStatusLine
            tone="success"
            text={t('registration.documents.scanLicense.readyEager')}
          />
        ) : null}

        {isSending ? (
          <View style={{ gap: theme.spacing.sm }}>
            <ScanSendingBar />
            <View style={[s.statusRow, { gap: theme.spacing.sm }]}>
              <ActivityIndicator color={theme.colors.accent} />
              <View style={s.statusCol}>
                <Text variant="footnote" color="accent">
                  {t('registration.documents.state.sending')}
                </Text>
                <Text variant="caption" color="inkSubtle">
                  {t('registration.documents.sendingNote')}
                </Text>
              </View>
            </View>
          </View>
        ) : null}

        {isSent ? (
          <ScanStatusLine tone="success" text={t('registration.documents.scanLicense.sent')} />
        ) : null}

        {sendFailed ? (
          <Banner
            tone="danger"
            title={t('registration.documents.licenseUploadFailed')}
            description={t('registration.personal.scanDni.sendErrorHint')}
          />
        ) : null}

        {/* Fallback HONESTO: faltó número o vencimiento → reescaneo (no un envío que finge éxito). */}
        {!needsDni && isCaptured && license.criticalMissing ? (
          <Banner
            tone="warn"
            title={t('registration.documents.criticalMissingTitle')}
            description={t('registration.documents.criticalMissingBody')}
          />
        ) : null}

        {license.unavailable ? (
          <Banner
            tone="warn"
            title={t('registration.documents.scanUnavailable')}
            description={t('registration.documents.galleryFallback')}
          />
        ) : null}

        {license.message ? (
          <Banner
            tone={isError ? 'danger' : 'warn'}
            title={t('errors.generic')}
            description={t(scanMessageI18nKey(license.message))}
          />
        ) : null}
      </View>
    </BottomSheet>
  );
}
