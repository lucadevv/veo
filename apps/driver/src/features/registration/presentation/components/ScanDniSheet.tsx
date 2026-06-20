import React, { useEffect } from 'react';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner, BottomSheet, Button, Text, useTheme } from '@veo/ui-kit';
import { IconCheck } from '../../../../shared/presentation/icons';
import { hexAlpha } from './color';
import { useScanDni, type DniAutofillResult } from '../hooks/useScanDni';

/**
 * Sheet de captura del DNI por ESCANEO (sub-lote 3B). Acción del paso 1 (Datos Personales): escanea el
 * anverso + reverso en una sesión, corre el OCR del frente y PRELLENA de forma NO destructiva los datos
 * personales del wizard (solo campos vacíos), y sube el DNI como documento de 2 caras (FRONT + BACK).
 *
 * Estados HONESTOS (vía `useScanDni`): nunca se marca éxito sin que el escaneo y la subida hayan resuelto
 * bien. Degradación honesta: el escáner no disponible avisa y deja el tipeo manual; el reverso ausente se
 * avisa (el conductor reescanea) y los campos OCR ausentes quedan manuales. Reusa por DI el escáner, el
 * parser `parseDni` y el caso de uso de subida — sin duplicar lógica ni conocer el módulo nativo.
 */
export interface ScanDniSheetProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Notifica a la pantalla qué campos personales se PRELLENARON desde el OCR del DNI, para que muestre
   * el marcador "Extraído de tu DNI — confirma" junto a cada uno (y lo limpie cuando el conductor edite).
   * Best-effort: solo se invoca tras una captura que prellenó al menos un campo.
   */
  onAutofill?: (result: DniAutofillResult) => void;
}

/** Mensajes de "Extraído de tu DNI" por campo (para el resumen de lo prellenado). */
function autofilledSummaryKeys(autofilled: DniAutofillResult): string[] {
  const keys: string[] = [];
  if (autofilled.fullName) {
    keys.push('registration.personal.nameLabel');
  }
  if (autofilled.dni) {
    keys.push('registration.personal.dniLabel');
  }
  if (autofilled.birthdate) {
    keys.push('registration.personal.birthdateLabel');
  }
  return keys;
}

export function ScanDniSheet({ visible, onClose, onAutofill }: ScanDniSheetProps): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  const dni = useScanDni();

  // Limpia el flujo cada vez que el sheet se abre (captura fresca, sin arrastrar un escaneo previo).
  useEffect(() => {
    if (visible) {
      dni.reset();
    }
    // `dni.reset` es estable por render del hook; solo reaccionamos a la apertura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const isScanning = dni.state === 'scanning';
  const isUploading = dni.state === 'uploading';
  const isSuccess = dni.state === 'success';
  const isCaptured = dni.state === 'captured';
  const isError = dni.state === 'error';
  const busy = isScanning || isUploading;

  const summaryKeys = autofilledSummaryKeys(dni.autofilled);

  /** Escanea y notifica a la pantalla los campos prellenados (si los hubo) para los marcadores. */
  const runScan = async (): Promise<void> => {
    const outcome = await dni.scan();
    if (outcome) {
      const { autofilled } = outcome;
      if (autofilled.dni || autofilled.fullName || autofilled.birthdate) {
        onAutofill?.(autofilled);
      }
    }
  };

  // CTA principal: escanear si aún no hay captura; subir si ya se capturó; cerrar si terminó.
  const onPrimary = (): void => {
    if (isSuccess) {
      onClose();
      return;
    }
    if (isCaptured || isError) {
      // Si ya hay caras, el primario sube; si el error fue del escaneo (sin caras), reescanea.
      if (dni.front) {
        void dni.submit();
      } else {
        void runScan();
      }
      return;
    }
    void runScan();
  };

  const primaryLabel = isSuccess
    ? t('common.close')
    : dni.front
      ? t('registration.personal.scanDni.upload')
      : t('registration.personal.scanDni.cta');

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('registration.personal.scanDni.title')}
      footer={
        <View style={styles.footer}>
          <Button
            label={isSuccess ? t('common.close') : t('common.cancel')}
            variant="secondary"
            onPress={onClose}
            disabled={isUploading}
          />
          <Button
            label={primaryLabel}
            variant="primary"
            loading={busy}
            disabled={busy}
            onPress={onPrimary}
          />
        </View>
      }
    >
      <View style={[styles.body, { gap: theme.spacing.lg }]}>
        <Text variant="footnote" color="inkSubtle">
          {t('registration.personal.scanDni.hint')}
        </Text>

        {/* Preview de las DOS caras (anverso + reverso). El reverso muestra un placeholder hasta capturarlo. */}
        <View style={[styles.facesRow, { gap: theme.spacing.md }]}>
          <FacePreview
            label={t('registration.personal.scanDni.front')}
            uri={dni.front?.uri ?? null}
            scanning={isScanning}
          />
          <FacePreview
            label={t('registration.personal.scanDni.back')}
            uri={dni.back?.uri ?? null}
            scanning={isScanning}
          />
        </View>

        {isUploading ? (
          <View style={[styles.statusRow, { gap: theme.spacing.sm }]}>
            <ActivityIndicator color={theme.colors.accent} />
            <Text variant="footnote" color="ink">
              {t('registration.documents.uploading')}
            </Text>
          </View>
        ) : null}

        {isSuccess ? (
          <View style={[styles.statusRow, { gap: theme.spacing.sm }]}>
            <IconCheck size={20} color={theme.colors.success} strokeWidth={2.6} />
            <Text variant="footnote" color="success">
              {t('registration.documents.uploadSuccess')}
            </Text>
          </View>
        ) : null}

        {/* Resumen NO destructivo: qué campos se prellenaron desde el OCR (pide confirmarlos en el form). */}
        {isCaptured && summaryKeys.length > 0 ? (
          <Banner
            tone="info"
            title={t('registration.personal.scanDni.extracted')}
            description={summaryKeys.map((key) => t(key)).join(' · ')}
          />
        ) : null}

        {/* Honestidad: si solo vino el anverso, lo decimos (el conductor puede reescanear el reverso). */}
        {isCaptured && !dni.hasBack ? (
          <Banner
            tone="warn"
            title={t('registration.personal.scanDni.backMissing')}
            description={t('registration.personal.scanDni.backMissingHint')}
          />
        ) : null}

        {/* Degradación honesta: escáner no disponible → tipeo manual (y galería en el sheet de documentos). */}
        {dni.unavailable ? (
          <Banner
            tone="warn"
            title={t('registration.documents.scanUnavailable')}
            description={t('registration.personal.scanDni.manualFallback')}
          />
        ) : null}

        {/* Mensaje accionable (cancelación/fallo de escaneo/subida): clave i18n bajo registration.documents.*. */}
        {dni.message ? (
          <Banner
            tone={isError ? 'danger' : 'warn'}
            title={t('errors.generic')}
            description={t(messageKey(dni.message))}
          />
        ) : null}
      </View>
    </BottomSheet>
  );
}

/** Mapea la clave corta del hook a su ruta i18n completa (sin strings mágicos desperdigados). */
function messageKey(message: string): string {
  switch (message) {
    case 'scanCancelled':
      return 'registration.documents.scanCancelled';
    case 'scanFailed':
      return 'registration.documents.scanFailed';
    case 'uploadFailed':
      return 'registration.personal.scanDni.uploadFailed';
    default:
      return 'errors.generic';
  }
}

/** Preview de una cara del DNI: imagen capturada o placeholder con su etiqueta (anverso/reverso). */
function FacePreview({
  label,
  uri,
  scanning,
}: {
  label: string;
  uri: string | null;
  scanning: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.faceCol}>
      <View
        style={[
          styles.facePreview,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderColor: uri ? hexAlpha(theme.colors.accent, 0.5) : theme.colors.border,
            borderRadius: theme.radii.md,
          },
        ]}
      >
        {uri ? (
          <Image source={{ uri }} style={styles.faceImage} resizeMode="cover" />
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
      <Text variant="caption" color="inkSubtle" align="center">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: 8 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  facesRow: { flexDirection: 'row' },
  faceCol: { flex: 1, gap: 6 },
  facePreview: { height: 120, borderWidth: 1, overflow: 'hidden', justifyContent: 'center' },
  faceImage: { width: '100%', height: '100%' },
  faceEmpty: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
});
