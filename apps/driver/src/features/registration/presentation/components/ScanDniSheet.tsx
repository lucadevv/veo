import React, { useEffect } from 'react';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner, BottomSheet, Button, Text, useTheme } from '@veo/ui-kit';
import { IconCheck } from '../../../../shared/presentation/icons';
import { scanMessageI18nKey } from '../../../documents/domain';
import { hexAlpha } from './color';
import { useScanDni } from '../hooks/useScanDni';

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
}

export function ScanDniSheet({ visible, onClose }: ScanDniSheetProps): React.JSX.Element {
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
  // `ready` = caras guardadas para subir DESPUÉS del PATCH /personal (el escaneo NO sube en el momento:
  // el presign del DNI exige que el driver ya exista, y eso ocurre recién en el continue del paso 1).
  const isReady = dni.state === 'ready';
  const isCaptured = dni.state === 'captured';
  const isError = dni.state === 'error';
  const busy = isScanning;

  // Campo CRÍTICO del DNI: el número. Si el OCR no lo leyó (binario nativo sin OCR, foto borrosa, etc.) NO
  // mostramos un "capturado ✓" que finge éxito: caemos al fallback honesto de reescaneo. La señal es el
  // número en el store tras la captura (lo escribe el prellenado no destructivo de `useScanDni`).
  const hasReadDniNumber = dni.personal.dni.trim().length > 0;

  /** Escanea el DNI (el hook corre el OCR y prellena el store de forma no destructiva). */
  const runScan = async (): Promise<void> => {
    await dni.scan();
  };

  // CTA principal: escanear si aún no hay captura; CONFIRMAR (guardar las caras para subir tras el PATCH)
  // si ya se capturó CON el número leído; REESCANEAR si la captura no leyó el número (gating crítico) o si
  // el escaneo falló sin caras. NUNCA sube aquí (eso pasa en el continue del paso 1).
  const canConfirm = isCaptured && dni.front != null && hasReadDniNumber;
  const onPrimary = (): void => {
    if (isReady) {
      onClose();
      return;
    }
    if (canConfirm) {
      // Hay caras Y el número crítico se leyó: el primario las CONFIRMA (guarda en el store).
      dni.submit();
      return;
    }
    // Sin captura, captura sin número crítico, o error de escaneo → (re)escanear. NUNCA confirmamos un DNI
    // sin su número: sería un éxito fingido. Honestidad de estado.
    void runScan();
  };

  const primaryLabel = isReady
    ? t('common.close')
    : canConfirm
      ? t('registration.personal.scanDni.confirm')
      : dni.front
        ? t('registration.personal.scanDni.rescan')
        : t('registration.personal.scanDni.cta');

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('registration.personal.scanDni.title')}
      footer={
        <View style={styles.footer}>
          <Button
            label={isReady ? t('common.close') : t('common.cancel')}
            variant="secondary"
            onPress={onClose}
            disabled={busy}
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

        {/* Listo: las caras quedaron guardadas; se subirán al confirmar los datos personales (tras el PATCH
            que crea el driver). NO decimos "subido" porque aún no se subió — honestidad de estado. */}
        {isReady ? (
          <View style={[styles.statusRow, { gap: theme.spacing.sm }]}>
            <IconCheck size={20} color={theme.colors.success} strokeWidth={2.6} />
            <Text variant="footnote" color="success">
              {t('registration.personal.scanDni.readyToUpload')}
            </Text>
          </View>
        ) : null}

        {/* "DNI capturado ✓" MINIMALISTA: solo tilde + título. NO listamos valores (nombre/dni/nacimiento):
            las miniaturas de arriba ya muestran el documento. Se muestra SOLO cuando el número crítico se
            leyó (captura realmente válida). */}
        {isCaptured && hasReadDniNumber ? (
          <View style={[styles.statusRow, { gap: theme.spacing.sm }]}>
            <IconCheck size={20} color={theme.colors.success} strokeWidth={2.6} />
            <Text variant="footnote" color="success">
              {t('registration.personal.scanDni.capturedTitle')}
            </Text>
          </View>
        ) : null}

        {/* Fallback HONESTO del campo CRÍTICO: se capturó la foto pero el OCR NO leyó el número de DNI →
            reescaneo (NO una tarjeta vacía que finge éxito). Se gatilla por la captura, no por los campos
            OCR: un OCR que no leyó NADA igual cae acá en vez de quedar mudo. */}
        {isCaptured && !hasReadDniNumber ? (
          <Banner
            tone="warn"
            title={t('registration.personal.scanDni.criticalMissingTitle')}
            description={t('registration.personal.scanDni.criticalMissingBody')}
          />
        ) : null}

        {/* Honestidad: si solo vino el anverso, lo decimos (el conductor puede reescanear el reverso). Solo
            relevante cuando la captura SÍ leyó el número (si no, ya pedimos reescaneo por el crítico). */}
        {isCaptured && hasReadDniNumber && !dni.hasBack ? (
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

        {/* Mensaje accionable (cancelación/fallo de escaneo): el motivo TIPADO (`ScanMessage`) se mapea a
            su clave i18n con el mapper exhaustivo del dominio — sin comparar el valor contra literales. */}
        {dni.message ? (
          <Banner
            tone={isError ? 'danger' : 'warn'}
            title={t('errors.generic')}
            description={t(scanMessageI18nKey(dni.message))}
          />
        ) : null}
      </View>
    </BottomSheet>
  );
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
