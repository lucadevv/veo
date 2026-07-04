import React, { useEffect } from 'react';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner, BottomSheet, Button, Text, useTheme } from '@veo/ui-kit';
import { IconCheck } from '../../../../shared/presentation/icons';
import { DOCUMENT_CARD_ASPECT_RATIO, scanMessageI18nKey } from '../../../documents/domain';
import {
  deriveDocumentPhase,
  type DocumentFacePhases,
  type DocumentSendPhase,
} from '../state/registrationStore';
import { hexAlpha } from './color';
import { useScanLicense } from '../hooks/useScanLicense';

/**
 * Sheet de captura de la LICENCIA de conducir (paso 1 · flujo EAGER a imagen del frame `C/ScanLicencia`):
 * ESPEJO del `ScanDniSheet`. Escanea anverso + reverso, lee número + vencimiento por OCR y, al confirmar,
 * dispara la subida INMEDIATA con estados POR CARA (subiendo azul → enviado verde / error rojo) + el
 * `onboard`. Como la licencia se registra DESPUÉS del DNI (el driver lo crea el PATCH del DNI), si aún no
 * existe el conductor el envío devuelve `needs-dni` y el sheet avisa "primero escaneá tu DNI".
 *
 * Sin bloque de duplicado (solo el DNI tiene check de unicidad). Estados HONESTOS vía `useScanLicense` +
 * las fases por-cara del store.
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
  onRescan,
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
  const rescan = (): void => {
    onRescan();
    license.reset();
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
    <View style={styles.footer}>
      <Button label={t('common.close')} variant="secondary" onPress={onClose} />
      <Button
        label={t('registration.actions.retryUpload')}
        variant="primary"
        onPress={onConfirm}
      />
    </View>
  ) : isReady ? (
    <Button label={t('common.close')} variant="primary" fullWidth onPress={onClose} />
  ) : (
    <View style={styles.footer}>
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
      <View style={[styles.body, { gap: theme.spacing.lg }]}>
        {needsDni ? null : (
          <Text variant="footnote" color="inkSubtle">
            {t('registration.documents.scanLicense.hint')}
          </Text>
        )}

        {/* Preview de las 2 caras con borde por estado de ENVÍO (azul=subiendo, verde=enviado, rojo=error). */}
        <View style={[styles.facesRow, { gap: theme.spacing.md }]}>
          <FacePreview
            label={t('registration.documents.scanLicense.front')}
            uri={license.front?.uri ?? null}
            scanning={isScanning}
            phase={isReady ? facePhases.front : 'idle'}
            dimmed={needsDni}
          />
          <FacePreview
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
          <ExtractBlock
            licenseNumber={license.licenseNumber ?? ''}
            expiresAt={license.expiresAt ?? ''}
          />
        ) : null}

        {!needsDni && isCaptured && !license.criticalMissing ? (
          <StatusLine tone="success" text={t('registration.documents.scanLicense.readyEager')} />
        ) : null}

        {isSending ? (
          <View style={{ gap: theme.spacing.sm }}>
            <SendingBar />
            <View style={[styles.statusRow, { gap: theme.spacing.sm }]}>
              <ActivityIndicator color={theme.colors.accent} />
              <View style={styles.statusCol}>
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
          <StatusLine tone="success" text={t('registration.documents.scanLicense.sent')} />
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

/** Línea de estado (tilde + texto) del tono dado. */
function StatusLine({ tone, text }: { tone: 'success'; text: string }): React.JSX.Element {
  const theme = useTheme();
  const color = theme.colors[tone];
  return (
    <View style={[styles.statusRow, { gap: theme.spacing.sm }]}>
      <IconCheck size={20} color={color} strokeWidth={2.6} />
      <Text variant="footnote" style={{ color }}>
        {text}
      </Text>
    </View>
  );
}

/** Formatea una fecha/ISO a `DD/MM/AAAA` (toma la parte de fecha). Devuelve el crudo si no parsea. */
function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!match) {
    return iso;
  }
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/** Bloque "Esto leímos de tu licencia": número + vencimiento (read-only, valores en mono). */
function ExtractBlock({
  licenseNumber,
  expiresAt,
}: {
  licenseNumber: string;
  expiresAt: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View
      style={[
        styles.extract,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
          gap: theme.spacing.sm,
        },
      ]}
    >
      <Text variant="footnote" color="ink" style={styles.extractTitle}>
        {t('registration.documents.scanLicense.extracted')}
      </Text>
      <ExtractRow
        label={t('registration.documents.scanLicense.fieldNumber')}
        value={licenseNumber}
        mono
      />
      <ExtractRow
        label={t('registration.documents.scanLicense.fieldExpiry')}
        value={formatDate(expiresAt)}
        mono
      />
    </View>
  );
}

/** Fila etiqueta ↔ valor del bloque de extracción (valor mono para número/fecha). */
function ExtractRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.extractRow}>
      <Text variant="footnote" color="inkSubtle">
        {label}
      </Text>
      <Text variant="callout" color="ink" style={mono ? styles.monoValue : undefined}>
        {value}
      </Text>
    </View>
  );
}

/** Barra de progreso indeterminada del estado "subiendo" (como el frame C/ScanLicencia). */
function SendingBar(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.barTrack, { backgroundColor: theme.colors.surfaceElevated }]}>
      <View style={[styles.barFill, { backgroundColor: theme.colors.accent }]} />
    </View>
  );
}

/** Preview de una cara: imagen o placeholder. Borde por estado de ENVÍO (azul/verde/rojo). */
function FacePreview({
  label,
  uri,
  scanning,
  phase,
  dimmed,
}: {
  label: string;
  uri: string | null;
  scanning: boolean;
  phase: DocumentSendPhase;
  dimmed: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  const phaseColor =
    phase === 'sent'
      ? theme.colors.success
      : phase === 'sending'
        ? theme.colors.accent
        : phase === 'error'
          ? theme.colors.danger
          : null;
  const borderColor = phaseColor
    ? hexAlpha(phaseColor, 0.5)
    : uri
      ? hexAlpha(theme.colors.accent, 0.5)
      : theme.colors.border;
  const stateLabel =
    phase === 'sent'
      ? t('registration.documents.state.sent')
      : phase === 'sending'
        ? t('registration.documents.state.sending')
        : phase === 'error'
          ? t('registration.documents.state.sendError')
          : null;

  return (
    <View style={[styles.faceCol, dimmed ? styles.dimmed : undefined]}>
      <View
        style={[
          styles.facePreview,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderColor,
            borderRadius: theme.radii.md,
          },
        ]}
      >
        {uri ? (
          <Image source={{ uri }} style={styles.faceImage} resizeMode="contain" />
        ) : (
          <View style={styles.faceEmpty}>
            {scanning ? (
              <ActivityIndicator color={theme.colors.accent} />
            ) : (
              <Text variant="caption" color="inkSubtle">
                {label}
              </Text>
            )}
          </View>
        )}
      </View>
      <Text variant="caption" color={stateLabel ? undefined : 'inkSubtle'} align="center">
        {stateLabel ? `${label} · ${stateLabel}` : label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: 8 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  facesRow: { flexDirection: 'row' },
  faceCol: { flex: 1, gap: 6 },
  dimmed: { opacity: 0.5 },
  facePreview: {
    aspectRatio: DOCUMENT_CARD_ASPECT_RATIO,
    borderWidth: 1,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  faceImage: { width: '100%', height: '100%' },
  faceEmpty: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusCol: { flex: 1, gap: 2 },
  extract: { borderWidth: 1, padding: 14 },
  extractTitle: { fontWeight: '600' },
  extractRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  monoValue: { fontFamily: 'Menlo', letterSpacing: 0.5 },
  barTrack: { height: 4, borderRadius: 999, overflow: 'hidden', width: '100%' },
  barFill: { height: 4, width: '45%', borderRadius: 999 },
});
