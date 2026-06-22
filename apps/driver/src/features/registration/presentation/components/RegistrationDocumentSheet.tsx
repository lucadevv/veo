import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ExtractedDocumentData, OcrEngineValue } from '@veo/api-client';
import { Banner, BottomSheet, Button, Text, useTheme } from '@veo/ui-kit';
import {
  ImagePickError,
  isDocumentScannerError,
  isParsableDocumentType,
  parseDocument,
  type ImageSource,
  type PickedImage,
  type ScannedDocument,
} from '../../../documents/domain';
import {
  ocrEngineForPlatform,
  ocrTimestampNow,
  scannedImageToPickedImage,
} from '../../../documents/data';
import {
  IconCamera,
  IconCheck,
  IconImage,
  IconScan,
} from '../../../../shared/presentation/icons';
import { hexAlpha } from './color';
import {
  REGISTRATION_DOCUMENT_FORM_CONFIG,
  type RegistrationDocumentFormType,
} from './registrationDocumentForm';
import {
  isCriticalFieldMissing,
  readoutFromParsed,
  type CapturedReadout,
} from './documentCaptureReadout';

/**
 * Estado de la subida del binario del documento. Honestidad de estado (sin éxito falso):
 *  - `idle`: aún no se eligió archivo.
 *  - `picking`: el selector nativo (cámara/galería) está abierto.
 *  - `ready`: hay un archivo elegido y previsualizado, listo para subir (el CTA se habilita).
 *  - `uploading`: presign + PUT + registro en curso (CTA con spinner, captura bloqueada).
 *  - `success`: el binario se subió y el documento quedó registrado/en revisión.
 *  - `error`: falló alguna etapa; se muestra el motivo y se permite reintentar.
 */
export type DocumentUploadState = 'idle' | 'picking' | 'ready' | 'uploading' | 'success' | 'error';

/**
 * Estado LOCAL de la captura que gestiona el sheet (la pantalla solo impone uploading/success/error).
 * Añade `scanning` (escáner nativo abierto) a los estados previos de selección. Se mantiene separado
 * del `DocumentUploadState` público para no exponer un estado que la pantalla no controla.
 */
export type DocumentCaptureLocalState = 'idle' | 'picking' | 'scanning' | 'captured';

/**
 * Resultado del flujo "Capturado ✓" (Lote 1 · sin formularios): metadatos LEÍDOS por OCR (no tipeados) +
 * el archivo + la data OCR mapeada al contrato. El sheet ya NO tiene campos editables: el número y el
 * vencimiento salen del parser, y `extractedData`/`ocrEngine`/`ocrAt` viajan al backend para trazabilidad.
 */
export interface RegistrationDocumentInput {
  /**
   * Número leído por OCR (licencia/SOAT/tarjeta). Solo presente cuando el tipo es numerado Y el OCR lo
   * leyó (el gating crítico garantiza que para los tipos numerados que llegan al envío hay número). Para
   * los tipos sin número (foto del vehículo) se OMITE — coherente con `addDocumentRequest` (opcional por tipo).
   */
  documentNumber?: string;
  /** Vencimiento en ISO-8601 si el OCR lo leyó (licencia/SOAT). Ausente si el documento no vence o no se leyó. */
  expiresAtIso?: string;
  /** Archivo local capturado/elegido. El binario se sube ANTES de registrar. */
  file: PickedImage;
  /** Data OCR mapeada a la variante del contrato (`ExtractedDocumentData`). Solo si el OCR la produjo. */
  extractedData?: ExtractedDocumentData;
  /** Motor de OCR que la produjo (enum cerrado). Solo si hay `extractedData`. */
  ocrEngine?: OcrEngineValue;
  /** Instante de la extracción OCR (ISO-8601). Solo si hay `extractedData`. */
  ocrAt?: string;
}

export interface RegistrationDocumentSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Nombre legible del documento (título del sheet). */
  documentLabel: string;
  /**
   * Tipo CANÓNICO del documento que se está capturando (`FleetDocumentType` del subconjunto del alta).
   * Selecciona la configuración contextual (`REGISTRATION_DOCUMENT_FORM_CONFIG`) y el parser de OCR.
   */
  documentType: RegistrationDocumentFormType;
  /**
   * Estado de la subida controlado por la pantalla (refleja la mutación de subida+registro). El sheet
   * gestiona `idle`/`picking`/`scanning`/`captured` por su cuenta y la pantalla impone `uploading`/`success`/`error`.
   */
  uploadState: DocumentUploadState;
  /** Mensaje de error (de la subida/registro) a mostrar en un Banner. */
  errorMessage?: string;
  /**
   * Selección del archivo desde la GALERÍA (fallback secundario, solo modo foto / escáner no disponible).
   * Cancelar resuelve `null`; los fallos accionables lanzan `ImagePickError`.
   */
  onPick: (source: ImageSource) => Promise<PickedImage | null>;
  /**
   * Escaneo del documento con la cámara nativa (bordes + auto-captura + OCR on-device). Es la acción
   * PRINCIPAL del modo `'document'`. Resuelve con `{ images, textLines }`: el sheet toma `images[0]` como
   * archivo y `textLines[0]` para el parser. Lanza `DocumentScannerError`: `E_CANCELLED`, `E_UNAVAILABLE`,
   * `E_SCAN_FAILED`. Opcional: el modo `'photo'` (foto del vehículo) usa la cámara normal, sin escáner.
   */
  onScan?: () => Promise<ScannedDocument>;
  /**
   * Dispara la subida+registro con el archivo + la data OCR. El sheet lo invoca AUTOMÁTICAMENTE tras un
   * escaneo válido (sin paso de formulario): es un flujo "escaneá y listo".
   */
  onSubmit: (input: RegistrationDocumentInput) => void;
}

/**
 * Hoja de captura "escaneá y listo" (Lote 1 · onboarding SIN formularios). El conductor escanea el
 * documento; el OCR lee número/vencimiento; se muestra una tarjeta "Capturado ✓" READ-ONLY (los datos
 * leídos como TEXTO, no inputs) con la miniatura, y se ENVÍA AUTOMÁTICAMENTE (sube el binario + registra
 * con `extractedData`/`ocrEngine`/`ocrAt`). SIN campos editables ni validación manual.
 *
 * Fallback HONESTO: si el OCR no leyó el campo CRÍTICO del tipo (licencia/SOAT → número), NO se envía: se
 * muestra "no pudimos leer X, reescaneá" + la acción de re-escaneo. Nunca se inventa un campo ni se marca
 * un éxito que no ocurrió.
 */
export function RegistrationDocumentSheet({
  visible,
  onClose,
  documentLabel,
  documentType,
  uploadState,
  errorMessage,
  onPick,
  onScan,
  onSubmit,
}: RegistrationDocumentSheetProps): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();

  const formConfig = REGISTRATION_DOCUMENT_FORM_CONFIG[documentType];
  const isPhoto = formConfig.captureMode === 'photo';
  const hasNumber = formConfig.hasNumber;
  const hasExpiry = formConfig.hasExpiry;

  const [file, setFile] = useState<PickedImage | null>(null);
  const [readout, setReadout] = useState<CapturedReadout | null>(null);
  const [localState, setLocalState] = useState<DocumentCaptureLocalState>('idle');
  const [pickError, setPickError] = useState<string | null>(null);
  const [scanUnavailable, setScanUnavailable] = useState(false);
  // Campo crítico ausente tras el parse: el OCR no leyó lo que el documento NECESITA → reescaneo (no form).
  const [missingCritical, setMissingCritical] = useState(false);

  // Reinicia el flujo cada vez que el sheet se abre (cambia de documento).
  useEffect(() => {
    if (visible) {
      setFile(null);
      setReadout(null);
      setLocalState('idle');
      setPickError(null);
      setScanUnavailable(false);
      setMissingCritical(false);
    }
  }, [visible]);

  // El estado efectivo: la pantalla manda mientras sube/termina/falla; si no, manda el local.
  const effectiveState: DocumentUploadState | DocumentCaptureLocalState =
    uploadState === 'uploading' || uploadState === 'success' || uploadState === 'error'
      ? uploadState
      : localState;

  const isUploading = effectiveState === 'uploading';
  const isSuccess = effectiveState === 'success';
  const isScanning = effectiveState === 'scanning';
  const isPicking = effectiveState === 'picking';
  const isCaptured = effectiveState === 'captured';
  const captureDisabled = isUploading || isSuccess || isScanning || isPicking;

  /**
   * Dispara la subida+registro con el archivo leído + la data OCR mapeada. Solo se llama cuando el campo
   * crítico está presente (gating previo). Adjunta `extractedData`/`ocrEngine`/`ocrAt` SOLO si el OCR
   * produjo data (degradación honesta: un documento sin data se sube sin esos campos).
   */
  const submitCaptured = (picked: PickedImage, data: CapturedReadout): void => {
    onSubmit({
      // Solo se manda `documentNumber` si el tipo es numerado Y el OCR lo leyó (coherencia con el contrato:
      // el campo es opcional por tipo; mandar '' es frágil aunque hoy aguante por truthiness downstream).
      ...(hasNumber && data.number ? { documentNumber: data.number } : {}),
      ...(hasExpiry && data.expiry ? { expiresAtIso: data.expiry } : {}),
      file: picked,
      ...(data.extractedData
        ? {
            extractedData: data.extractedData,
            ocrEngine: ocrEngineForPlatform(),
            ocrAt: ocrTimestampNow(),
          }
        : {}),
    });
  };

  /**
   * Procesa el resultado del escaneo: parsea, mapea a `CapturedReadout` y aplica el GATING del campo
   * crítico. Si el tipo es numerado (licencia/SOAT/tarjeta) y el OCR NO leyó el número → fallback honesto
   * (reescaneo, sin formulario). Si el campo crítico está → tarjeta "Capturado ✓" + auto-submit.
   */
  const processScan = (picked: PickedImage, lines: readonly string[]): void => {
    if (!isParsableDocumentType(documentType) || lines.length === 0) {
      // Sin parser/sin texto: no podemos leer el campo crítico → reescaneo honesto.
      setFile(picked);
      setReadout(null);
      setMissingCritical(hasNumber);
      setLocalState('captured');
      return;
    }
    const parsed = parseDocument(documentType, lines);
    const data = readoutFromParsed(parsed);
    setFile(picked);
    setReadout(data);
    // Gating del campo CRÍTICO (lógica PURA compartida): el tipo numerado EXIGE número. Sin él, no enviamos.
    const critical = isCriticalFieldMissing(documentType, data);
    setMissingCritical(critical);
    setLocalState('captured');
    if (!critical) {
      // "Escaneá y listo": auto-envío sin paso de formulario.
      submitCaptured(picked, data);
    }
  };

  /** Reintenta el escaneo (desde el fallback de campo crítico o desde la tarjeta). Limpia el estado leído. */
  const resetCapture = (): void => {
    setFile(null);
    setReadout(null);
    setMissingCritical(false);
    setLocalState('idle');
    setPickError(null);
  };

  /**
   * Acción PRINCIPAL: abre el escáner nativo. Al obtener la imagen, la procesa (parse + gating + auto-submit).
   * Degradación HONESTA por código tipado: `E_CANCELLED` (no error), `E_UNAVAILABLE` (cae a galería),
   * `E_SCAN_FAILED`/desconocido (banner accionable).
   */
  const handleScan = async (): Promise<void> => {
    if (captureDisabled || !onScan) {
      return;
    }
    setPickError(null);
    setScanUnavailable(false);
    setMissingCritical(false);
    setLocalState('scanning');
    try {
      const { images, textLines } = await onScan();
      const first = images[0];
      if (!first) {
        setLocalState('idle');
        setPickError(t('registration.documents.scanFailed'));
        return;
      }
      processScan(scannedImageToPickedImage(first), textLines[0] ?? []);
    } catch (e) {
      setLocalState('idle');
      if (isDocumentScannerError(e, 'E_CANCELLED')) {
        setPickError(t('registration.documents.scanCancelled'));
        return;
      }
      if (isDocumentScannerError(e, 'E_UNAVAILABLE')) {
        setScanUnavailable(true);
        return;
      }
      setPickError(t('registration.documents.scanFailed'));
    }
  };

  /**
   * Captura por FOTO (modo foto del vehículo) o galería (fallback del escáner). La foto del vehículo NO se
   * parsea (no tiene campos): se sube directo. La galería en modo documento tampoco trae texto OCR, así
   * que se trata como captura sin lectura → para tipos numerados, fallback de campo crítico (reescaneo).
   */
  const pickFrom = (source: ImageSource) => async (): Promise<void> => {
    if (captureDisabled) {
      return;
    }
    setPickError(null);
    setMissingCritical(false);
    setLocalState('picking');
    try {
      const picked = await onPick(source);
      if (!picked) {
        setLocalState(file ? 'captured' : 'idle');
        return;
      }
      if (isPhoto) {
        // Foto libre del vehículo: sin OCR, se envía directo (sin número ni vencimiento).
        setFile(picked);
        setReadout(null);
        setLocalState('captured');
        submitCaptured(picked, { extractedData: null });
        return;
      }
      // Galería en modo documento: no hay texto OCR del picker → no podemos leer el campo crítico.
      processScan(picked, []);
    } catch (e) {
      setLocalState(file ? 'captured' : 'idle');
      setPickError(
        e instanceof ImagePickError && e.reason === 'permission'
          ? t('registration.documents.permissionDenied')
          : t('registration.documents.captureFailed'),
      );
    }
  };

  // El footer cambia según el momento: capturando → solo cerrar; tras éxito → cerrar.
  const footer = (
    <View style={styles.footer}>
      <Button
        label={isSuccess ? t('common.close') : t('common.cancel')}
        variant={isSuccess ? 'primary' : 'secondary'}
        onPress={onClose}
        disabled={isUploading}
      />
    </View>
  );

  return (
    <BottomSheet visible={visible} onClose={onClose} title={documentLabel} footer={footer}>
      <View style={[styles.body, { gap: theme.spacing.lg }]}>
        {/* Preview / placeholder del archivo capturado. */}
        <View
          style={[
            styles.preview,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderColor: file ? hexAlpha(theme.colors.accent, 0.5) : theme.colors.border,
              borderRadius: theme.radii.lg,
            },
          ]}
        >
          {file ? (
            <Image source={{ uri: file.uri }} style={styles.previewImage} resizeMode="cover" />
          ) : (
            <View style={[styles.previewEmpty, { gap: theme.spacing.sm }]}>
              {isPhoto ? (
                <IconCamera size={28} color={theme.colors.inkSubtle} strokeWidth={1.8} />
              ) : (
                <IconScan size={28} color={theme.colors.inkSubtle} strokeWidth={1.8} />
              )}
              <Text variant="footnote" color="inkSubtle">
                {t(isPhoto ? 'registration.documents.photo.noFile' : 'registration.documents.noFile')}
              </Text>
            </View>
          )}
          {isScanning ? (
            <View style={[styles.previewOverlay, { backgroundColor: theme.colors.overlay }]}>
              <ActivityIndicator color={theme.colors.accent} />
              <Text variant="footnote" color="ink">
                {t('registration.documents.scanning')}
              </Text>
            </View>
          ) : null}
          {isUploading ? (
            <View style={[styles.previewOverlay, { backgroundColor: theme.colors.overlay }]}>
              <ActivityIndicator color={theme.colors.accent} />
              <Text variant="footnote" color="ink">
                {t('registration.documents.uploading')}
              </Text>
            </View>
          ) : null}
          {isSuccess ? (
            <View style={[styles.previewOverlay, { backgroundColor: theme.colors.overlay }]}>
              <IconCheck size={32} color={theme.colors.success} strokeWidth={2.6} />
              <Text variant="footnote" color="success">
                {t(
                  isPhoto
                    ? 'registration.documents.photo.uploadSuccess'
                    : 'registration.documents.uploadSuccess',
                )}
              </Text>
            </View>
          ) : null}
        </View>

        {/* TARJETA "Capturado ✓" READ-ONLY: los datos leídos por OCR como TEXTO (no inputs). Solo cuando
            hay captura válida con campo crítico presente (modo documento) y no estamos en error de subida. */}
        {isCaptured && !missingCritical && !isPhoto ? (
          <CapturedCard
            number={readout?.number}
            numberLabel={t(formConfig.numberLabelKey ?? 'registration.documents.numberLabel')}
            expiry={hasExpiry ? readout?.expiry : undefined}
            expiryLabel={t('registration.documents.expiryLabel')}
          />
        ) : null}

        {/* Fallback HONESTO del campo crítico: el OCR no leyó el número → reescaneo (NO un formulario). */}
        {missingCritical && effectiveState !== 'uploading' && effectiveState !== 'success' ? (
          <Banner
            tone="warn"
            title={t('registration.documents.criticalMissing.title')}
            description={t('registration.documents.criticalMissing.body')}
          />
        ) : null}

        {/* Acción de captura según el modo. En estado "capturado" válido el envío es automático: el botón
            pasa a ser "volver a escanear". El botón de galería es el camino secundario del modo documento. */}
        {!isSuccess ? (
          <View style={[styles.captureCol, { gap: theme.spacing.sm }]}>
            {isPhoto ? (
              <PrimaryCaptureButton
                label={
                  file
                    ? t('registration.actions.retake')
                    : t('registration.documents.photo.take')
                }
                hint={t('registration.documents.photo.hint')}
                icon={<IconCamera size={20} color={theme.colors.accent} strokeWidth={1.8} />}
                onPress={pickFrom('camera')}
                disabled={captureDisabled}
                busy={isPicking}
              />
            ) : (
              <PrimaryCaptureButton
                label={
                  file || missingCritical
                    ? t('registration.actions.rescan')
                    : t('registration.documents.scan')
                }
                hint={t('registration.documents.scanHint')}
                icon={<IconScan size={20} color={theme.colors.accent} strokeWidth={1.8} />}
                onPress={() => {
                  // Desde un estado capturado/crítico, reescanear limpia primero el readout previo.
                  if (file || missingCritical) {
                    resetCapture();
                  }
                  void handleScan();
                }}
                disabled={captureDisabled}
                busy={isScanning}
              />
            )}
            {!isPhoto ? (
              <CaptureButton
                label={t('registration.documents.fromGallery')}
                icon={<IconImage size={18} color={theme.colors.ink} strokeWidth={1.8} />}
                onPress={pickFrom('library')}
                disabled={captureDisabled}
                busy={isPicking}
              />
            ) : null}
          </View>
        ) : null}

        {scanUnavailable ? (
          <Banner
            tone="warn"
            title={t('registration.documents.scanUnavailable')}
            description={t('registration.documents.fromGallery')}
          />
        ) : null}

        {pickError ? (
          <Banner tone="warn" title={t('errors.generic')} description={pickError} />
        ) : null}
        {effectiveState === 'error' && errorMessage ? (
          <Banner tone="danger" title={t('errors.generic')} description={errorMessage} />
        ) : null}

        <Text variant="footnote" color="inkSubtle">
          {t(
            isPhoto
              ? 'registration.documents.photo.reviewNote'
              : 'registration.documents.reviewNote',
          )}
        </Text>
      </View>
    </BottomSheet>
  );
}

/**
 * Tarjeta "Capturado ✓" READ-ONLY: muestra los datos que el OCR LEYÓ como TEXTO (no inputs), con un check
 * de éxito. Es el corazón del flujo sin-formularios: el conductor VE lo que se leyó, no lo edita. Usa solo
 * tokens del tema (colores/espaciado/radios + `hexAlpha` para el tinte de éxito).
 */
function CapturedCard({
  number,
  numberLabel,
  expiry,
  expiryLabel,
}: {
  number?: string;
  numberLabel: string;
  expiry?: string;
  expiryLabel: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View
      style={[
        styles.capturedCard,
        {
          backgroundColor: hexAlpha(theme.colors.success, 0.1),
          borderColor: hexAlpha(theme.colors.success, 0.4),
          borderRadius: theme.radii.lg,
          padding: theme.spacing.md,
          gap: theme.spacing.sm,
        },
      ]}
    >
      <View style={[styles.capturedHeader, { gap: theme.spacing.xs }]}>
        <IconCheck size={20} color={theme.colors.success} strokeWidth={2.6} />
        <Text variant="headline" color="success">
          {t('registration.documents.captured.title')}
        </Text>
      </View>
      {number ? <ReadonlyRow label={numberLabel} value={number} /> : null}
      {expiry ? <ReadonlyRow label={expiryLabel} value={expiry} /> : null}
      <Text variant="footnote" color="inkSubtle">
        {t('registration.documents.captured.hint')}
      </Text>
    </View>
  );
}

/** Fila READ-ONLY etiqueta + valor (texto, NO input). */
function ReadonlyRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.readonlyRow, { gap: theme.spacing.xs }]}>
      <Text variant="footnote" color="inkSubtle">
        {label}
      </Text>
      <Text variant="body" color="ink">
        {value}
      </Text>
    </View>
  );
}

/**
 * Botón PRINCIPAL de captura: destacado (tinte de acento), con ícono, etiqueta y pista corta. Usa solo
 * tokens del tema. El ícono lo provee el llamador para no acoplar el botón al modo.
 */
function PrimaryCaptureButton({
  label,
  hint,
  icon,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  hint: string;
  icon: React.ReactNode;
  onPress: () => void;
  disabled: boolean;
  busy: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.scanButton,
        {
          backgroundColor: hexAlpha(theme.colors.accent, 0.12),
          borderColor: hexAlpha(theme.colors.accent, 0.6),
          borderRadius: theme.radii.md,
          paddingVertical: theme.spacing.md,
          paddingHorizontal: theme.spacing.md,
          gap: theme.spacing.sm,
          opacity: disabled && !busy ? 0.5 : pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={[styles.scanButtonRow, { gap: theme.spacing.sm }]}>
        {busy ? <ActivityIndicator color={theme.colors.accent} /> : icon}
        <Text variant="headline" color="accent">
          {label}
        </Text>
      </View>
      <Text variant="footnote" color="inkSubtle" align="center">
        {hint}
      </Text>
    </Pressable>
  );
}

/** Botón de captura (galería) con ícono + estado ocupado. Usa solo tokens del tema. */
function CaptureButton({
  label,
  icon,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  disabled: boolean;
  busy: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.captureButton,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor: theme.colors.borderStrong,
          borderRadius: theme.radii.md,
          paddingVertical: theme.spacing.md,
          gap: theme.spacing.sm,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator color={theme.colors.accent} /> : icon}
      <Text variant="subhead" color="ink">
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: 8 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  preview: { height: 180, borderWidth: 1, overflow: 'hidden', justifyContent: 'center' },
  previewImage: { width: '100%', height: '100%' },
  previewEmpty: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  previewOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  capturedCard: { borderWidth: 1 },
  capturedHeader: { flexDirection: 'row', alignItems: 'center' },
  readonlyRow: { flexDirection: 'column' },
  captureCol: { flexDirection: 'column' },
  scanButton: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  scanButtonRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  captureButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
