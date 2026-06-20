import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Polyline, Rect } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { Banner, BottomSheet, Button, Text, TextField, useTheme } from '@veo/ui-kit';
import {
  ImagePickError,
  isDocumentScannerError,
  isParsableDocumentType,
  parseDocument,
  type ImageSource,
  type ParsedDocument,
  type PickedImage,
  type ScannedDocument,
} from '../../../documents/domain';
import { scannedImageToPickedImage } from '../../../documents/data';
import { IconCheck } from '../../../../shared/presentation/icons';
import { DateField } from '../../../../shared/presentation/components/DateField';
import { hexAlpha } from './color';
import {
  REGISTRATION_DOCUMENT_FORM_CONFIG,
  type RegistrationDocumentFormType,
} from './registrationDocumentForm';

/** Glifo de galería/imagen (inline). */
function ImageGlyph({ color, size = 18 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={3} y={4} width={18} height={16} rx={2} stroke={color} strokeWidth={1.8} />
      <Circle cx={8.5} cy={9} r={1.6} stroke={color} strokeWidth={1.8} />
      <Polyline
        points="4,17 9,12 13,15 17,11 20,14"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Glifo de escáner de documento (inline): marco con esquinas + línea de escaneo. */
function ScanGlyph({ color, size = 18 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Esquinas del marco de escaneo (no un rectángulo cerrado: evoca la guía de bordes). */}
      <Path
        d="M4 8V6a2 2 0 0 1 2-2h2"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M16 4h2a2 2 0 0 1 2 2v2"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M20 16v2a2 2 0 0 1-2 2h-2"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M8 20H6a2 2 0 0 1-2-2v-2"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Línea de escaneo. */}
      <Path d="M4 12h16" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

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
export type DocumentCaptureLocalState = 'idle' | 'picking' | 'scanning' | 'ready';

/** Resultado del formulario: metadatos + archivo local elegido para subir. */
export interface RegistrationDocumentInput {
  documentNumber: string;
  /** Vencimiento en ISO-8601 (si el conductor lo ingresó / es requerido). */
  expiresAtIso?: string;
  /** Archivo local capturado/elegido (cámara o galería). El binario se sube ANTES de registrar. */
  file: PickedImage;
}

export interface RegistrationDocumentSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Nombre legible del documento (título del sheet). */
  documentLabel: string;
  /**
   * Tipo CANÓNICO del documento que se está capturando (`FleetDocumentType` del subconjunto del alta).
   * Selecciona la configuración contextual del formulario (`REGISTRATION_DOCUMENT_FORM_CONFIG`): la
   * etiqueta/placeholder propios del número y si el documento vence (y por tanto se pide vencimiento).
   */
  documentType: RegistrationDocumentFormType;
  /**
   * Estado de la subida controlado por la pantalla (refleja la mutación de subida+registro). El sheet
   * gestiona `idle`/`picking`/`ready` por su cuenta y la pantalla impone `uploading`/`success`/`error`.
   */
  uploadState: DocumentUploadState;
  /** Mensaje de error (de la subida/registro) a mostrar en un Banner. */
  errorMessage?: string;
  /**
   * Selección del archivo desde la GALERÍA (fallback secundario). La pantalla inyecta el
   * `ImagePickerService` por DI; el sheet NO conoce el SDK nativo. Cancelar resuelve `null`; los
   * fallos accionables lanzan `ImagePickError`.
   */
  onPick: (source: ImageSource) => Promise<PickedImage | null>;
  /**
   * Escaneo del documento con la cámara nativa (bordes + auto-captura + corrección + OCR on-device). Es
   * la acción PRINCIPAL. La pantalla inyecta el `DocumentScannerService` por DI; el sheet NO conoce el
   * módulo nativo. Resuelve con `{ images, textLines }`: el sheet toma `images[0]` como archivo y pasa
   * `textLines[0]` al parser del tipo actual para PRE-LLENAR número/vencimiento. Lanza
   * `DocumentScannerError`: `E_CANCELLED` (cancelar, no error), `E_UNAVAILABLE` (cae a galería),
   * `E_SCAN_FAILED` (error con reintento).
   */
  onScan: () => Promise<ScannedDocument>;
  /** Dispara la subida+registro con los metadatos y el archivo elegido. */
  onSubmit: (input: RegistrationDocumentInput) => void;
}

/**
 * Campos del FORMULARIO que el OCR pudo extraer del documento escaneado: el número propio del tipo y el
 * vencimiento en `AAAA-MM-DD` (el formato que consume el `DateField`/`parseExpiry`). Mapea el resultado
 * tipado del parser (`ParsedDocument`, discriminado por `kind`) a los dos campos que el sheet edita. Solo
 * incluye un campo si el parser lo extrajo con confianza (degradación honesta: lo ausente queda manual).
 */
function formFieldsFromParsed(parsed: ParsedDocument): { number?: string; expiry?: string } {
  switch (parsed.kind) {
    case 'license':
      return {
        ...(parsed.number ? { number: parsed.number } : {}),
        ...(parsed.expiresAt ? { expiry: parsed.expiresAt } : {}),
      };
    case 'soat':
      return {
        ...(parsed.policyNumber ? { number: parsed.policyNumber } : {}),
        ...(parsed.expiresAt ? { expiry: parsed.expiresAt } : {}),
      };
    case 'propertyCard':
      // La tarjeta de propiedad no vence: el OCR aporta la PLACA como número de referencia del campo.
      return parsed.plate ? { number: parsed.plate } : {};
    case 'dni':
      // El DNI no se escanea en este flujo (su parser queda listo para el lote futuro); no aplica al sheet.
      return {};
  }
}

/** Acepta `AAAA-MM-DD` y valida que sea un día real; devuelve el ISO o null. */
function parseExpiry(raw: string): { iso: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { iso: date.toISOString() };
}

/**
 * Formulario en bottom sheet para registrar un documento del alta: captura del binario (cámara o
 * galería) + número + vencimiento. El tipo es fijo (lo decide la tarjeta del paso de documentos), por
 * eso no se elige aquí. El flujo sube el binario al almacén soberano y luego registra el documento con
 * su `fileS3Key`; el documento queda "en revisión". Estados HONESTOS: nunca se marca éxito sin que el
 * PUT del binario y el registro hayan resuelto bien.
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

  // Configuración contextual del formulario para ESTE tipo de documento (etiqueta del número +
  // si vence). La fuente es el mapa tipado y exhaustivo, no flags sueltos.
  const formConfig = REGISTRATION_DOCUMENT_FORM_CONFIG[documentType];
  const requireExpiry = formConfig.hasExpiry;
  // La foto del vehículo (VEHICLE_PHOTO) NO tiene número: el campo no se muestra ni se exige.
  const hasNumber = formConfig.hasNumber;

  // Acota el picker de vencimiento a partir de hoy (un documento vencido no es válido).
  const today = new Date();

  const [documentNumber, setDocumentNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [touched, setTouched] = useState(false);
  const [file, setFile] = useState<PickedImage | null>(null);
  // Estado LOCAL del selector (idle/scanning/ready). La pantalla impone uploading/success/error vía prop.
  const [localState, setLocalState] = useState<DocumentCaptureLocalState>('idle');
  const [pickError, setPickError] = useState<string | null>(null);
  // Aviso (no error) de degradación honesta: el escáner no está disponible → se ofrece la galería.
  const [scanUnavailable, setScanUnavailable] = useState(false);
  // ¿El número / vencimiento del formulario fueron PRE-LLENADOS desde el OCR del escaneo? Sirve para
  // marcar visualmente "Extraído del documento — confirmá" y para limpiar el aviso si el conductor
  // edita el campo (un valor corregido a mano ya no es "el extraído").
  const [autoNumber, setAutoNumber] = useState(false);
  const [autoExpiry, setAutoExpiry] = useState(false);

  // Reinicia el formulario cada vez que el sheet se abre (cambia de documento).
  useEffect(() => {
    if (visible) {
      setDocumentNumber('');
      setExpiry('');
      setTouched(false);
      setFile(null);
      setLocalState('idle');
      setPickError(null);
      setScanUnavailable(false);
      setAutoNumber(false);
      setAutoExpiry(false);
    }
  }, [visible]);

  // El estado efectivo: la pantalla manda mientras sube/termina/falla; si no, manda el local (que
  // puede ser `scanning`/`picking`/`ready`/`idle`).
  const effectiveState: DocumentUploadState | DocumentCaptureLocalState =
    uploadState === 'uploading' || uploadState === 'success' || uploadState === 'error'
      ? uploadState
      : localState;

  const isUploading = effectiveState === 'uploading';
  const isSuccess = effectiveState === 'success';
  const isScanning = effectiveState === 'scanning';
  const isPicking = effectiveState === 'picking';
  const captureDisabled = isUploading || isSuccess || isScanning || isPicking;

  const numberError = useMemo(
    () =>
      touched && hasNumber && documentNumber.trim().length === 0
        ? t('registration.documents.numberRequired')
        : undefined,
    [touched, hasNumber, documentNumber, t],
  );

  const expiryError = useMemo(() => {
    if (!touched) {
      return undefined;
    }
    const trimmed = expiry.trim();
    if (trimmed.length === 0) {
      return requireExpiry ? t('registration.documents.expiryRequired') : undefined;
    }
    return parseExpiry(trimmed) ? undefined : t('registration.documents.expiryInvalid');
  }, [touched, expiry, requireExpiry, t]);

  /** Abre cámara o galería; al obtener archivo pasa a `ready`. Cancelar no es error (vuelve a idle). */
  const pickFrom = (source: ImageSource) => async () => {
    if (captureDisabled) {
      return;
    }
    setPickError(null);
    setLocalState('picking');
    try {
      const picked = await onPick(source);
      if (!picked) {
        // El conductor canceló: si no había archivo previo, vuelve a idle; si lo había, lo conserva.
        setLocalState(file ? 'ready' : 'idle');
        return;
      }
      setFile(picked);
      setLocalState('ready');
    } catch (e) {
      setLocalState(file ? 'ready' : 'idle');
      setPickError(
        e instanceof ImagePickError && e.reason === 'permission'
          ? t('registration.documents.permissionDenied')
          : t('registration.documents.captureFailed'),
      );
    }
  };

  /**
   * Pre-llena el formulario con los campos que el OCR extrajo de la primera página escaneada. Rutea por
   * el tipo CANÓNICO del documento (solo los parseables: licencia/SOAT/tarjeta; la foto del vehículo no
   * se parsea). Best-effort y NO destructivo: solo escribe un campo si el OCR lo extrajo con confianza
   * (lo ausente queda como esté), y marca cada campo escrito como "auto-extraído" para que la UI invite a
   * confirmarlo. Nunca inventa ni bloquea el submit.
   */
  const applyOcrAutofill = (lines: readonly string[]): void => {
    if (!isParsableDocumentType(documentType) || lines.length === 0) {
      return;
    }
    const parsed = parseDocument(documentType, lines);
    const fields = formFieldsFromParsed(parsed);
    if (hasNumber && fields.number) {
      setDocumentNumber(fields.number);
      setAutoNumber(true);
    }
    if (requireExpiry && fields.expiry && parseExpiry(fields.expiry)) {
      setExpiry(fields.expiry);
      setAutoExpiry(true);
    }
  };

  /**
   * Acción PRINCIPAL: abre el escáner nativo (bordes + auto-captura + corrección). Al obtener la
   * imagen croppeada pasa a `ready` con el preview. Degradación HONESTA por código tipado:
   *  - `E_CANCELLED`: el conductor cerró el escáner → NO es error (conserva el estado previo).
   *  - `E_UNAVAILABLE`: el módulo no está → aviso + se ofrece la galería (no se inventa captura).
   *  - `E_SCAN_FAILED` / desconocido: banner de error accionable (reintentar o usar galería).
   */
  const handleScan = async () => {
    if (captureDisabled) {
      return;
    }
    setPickError(null);
    setScanUnavailable(false);
    setLocalState('scanning');
    try {
      const { images, textLines } = await onScan();
      // 1 imagen por documento por ahora (el backend N-imágenes es Lote 3): tomamos la primera.
      const first = images[0];
      if (!first) {
        // El escáner resolvió sin imágenes: lo tratamos como fallo de captura (no éxito silencioso).
        setLocalState(file ? 'ready' : 'idle');
        setPickError(t('registration.documents.scanFailed'));
        return;
      }
      setFile(scannedImageToPickedImage(first));
      setLocalState('ready');
      // AUTO-LLENADO: parsea el texto OCR de la primera página y pre-llena los campos extraídos. Es
      // BEST-EFFORT: si el OCR no extrajo algo, el campo queda manual (nunca bloquea ni inventa).
      applyOcrAutofill(textLines[0] ?? []);
    } catch (e) {
      setLocalState(file ? 'ready' : 'idle');
      if (isDocumentScannerError(e, 'E_CANCELLED')) {
        // Cancelar NO es un fallo: solo informamos que puede reintentar o usar la galería.
        setPickError(t('registration.documents.scanCancelled'));
        return;
      }
      if (isDocumentScannerError(e, 'E_UNAVAILABLE')) {
        // Degradación honesta: el escáner no existe en este device → la galería pasa a ser el camino.
        setScanUnavailable(true);
        return;
      }
      setPickError(t('registration.documents.scanFailed'));
    }
  };

  const canSubmit = file !== null && !isUploading && !isSuccess;

  const handleSubmit = () => {
    setTouched(true);
    if (!file) {
      return;
    }
    if (hasNumber && documentNumber.trim().length === 0) {
      return;
    }
    const trimmedExpiry = expiry.trim();
    const parsed = trimmedExpiry.length > 0 ? parseExpiry(trimmedExpiry) : null;
    if (requireExpiry && !parsed) {
      return;
    }
    if (trimmedExpiry.length > 0 && !parsed) {
      return;
    }
    onSubmit({
      // La foto no tiene número → '' (el backend lo acepta solo para VEHICLE_PHOTO, validación por tipo).
      documentNumber: hasNumber ? documentNumber.trim() : '',
      ...(parsed ? { expiresAtIso: parsed.iso } : {}),
      file,
    });
  };

  const ctaLabel = isSuccess
    ? t('registration.documents.uploaded')
    : effectiveState === 'error'
      ? t('common.retry')
      : t('registration.documents.save');

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={documentLabel}
      footer={
        <View style={styles.footer}>
          <Button
            label={isSuccess ? t('common.close') : t('common.cancel')}
            variant="secondary"
            onPress={onClose}
            disabled={isUploading}
          />
          <Button
            label={ctaLabel}
            variant="primary"
            loading={isUploading}
            disabled={!canSubmit && effectiveState !== 'error'}
            onPress={handleSubmit}
          />
        </View>
      }
    >
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
              <ScanGlyph size={28} color={theme.colors.inkSubtle} />
              <Text variant="footnote" color="inkSubtle">
                {t('registration.documents.noFile')}
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
                {t('registration.documents.uploadSuccess')}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Acción PRINCIPAL: escanear (bordes + auto-captura). La galería es el fallback secundario. */}
        <View style={[styles.captureCol, { gap: theme.spacing.sm }]}>
          <ScanButton
            label={file ? t('registration.documents.rescan') : t('registration.documents.scan')}
            hint={t('registration.documents.scanHint')}
            onPress={() => {
              void handleScan();
            }}
            disabled={captureDisabled}
            busy={isScanning}
          />
          <CaptureButton
            label={t('registration.documents.fromGallery')}
            icon={<ImageGlyph size={18} color={theme.colors.ink} />}
            onPress={pickFrom('library')}
            disabled={captureDisabled}
            busy={isPicking}
          />
        </View>

        {/* Degradación honesta: si el escáner no está disponible, lo decimos y la galería es el camino. */}
        {scanUnavailable ? (
          <Banner
            tone="warn"
            title={t('registration.documents.scanUnavailable')}
            description={t('registration.documents.fromGallery')}
          />
        ) : null}

        {/* El campo de número se muestra SOLO para documentos numerados (licencia/SOAT/tarjeta). La foto
            del vehículo (VEHICLE_PHOTO) es solo imagen: no se pide número. */}
        {hasNumber ? (
          <TextField
            label={t(formConfig.numberLabelKey ?? '')}
            placeholder={t(formConfig.numberPlaceholderKey ?? '')}
            value={documentNumber}
            onChangeText={(text) => {
              setDocumentNumber(text);
              // Si el conductor corrige el valor, deja de ser "el extraído": ocultamos el aviso.
              if (autoNumber) {
                setAutoNumber(false);
              }
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!captureDisabled}
            error={numberError}
            // Degradación honesta: si el número vino del OCR, lo decimos y pedimos confirmarlo.
            helperText={
              autoNumber && !numberError
                ? t('registration.documents.autofill.extracted')
                : undefined
            }
            required
          />
        ) : null}
        {/* El vencimiento se pide SOLO para documentos que vencen (licencia/SOAT). La tarjeta de
            propiedad no vence en Perú: no se muestra el campo ni se exige, y se envía sin `expiresAt`. */}
        {formConfig.hasExpiry ? (
          <View style={{ gap: theme.spacing.xs }}>
            <DateField
              label={t('registration.documents.expiryLabel')}
              value={expiry}
              onChange={(iso) => {
                setExpiry(iso);
                // Una fecha elegida a mano deja de ser "la extraída": ocultamos el aviso.
                if (autoExpiry) {
                  setAutoExpiry(false);
                }
              }}
              placeholder={t('registration.documents.expiryPlaceholder')}
              // Un documento ya vencido no es válido: el picker no permite elegir fechas pasadas.
              minimumDate={today}
              disabled={captureDisabled}
              error={expiryError}
            />
            {/* Degradación honesta: si el vencimiento vino del OCR, lo decimos y pedimos confirmarlo. */}
            {autoExpiry && !expiryError ? (
              <Text variant="footnote" color="inkSubtle">
                {t('registration.documents.autofill.extracted')}
              </Text>
            ) : null}
          </View>
        ) : null}

        {pickError ? (
          <Banner tone="warn" title={t('errors.generic')} description={pickError} />
        ) : null}
        {effectiveState === 'error' && errorMessage ? (
          <Banner tone="danger" title={t('errors.generic')} description={errorMessage} />
        ) : null}

        <Text variant="footnote" color="inkSubtle">
          {t('registration.documents.reviewNote')}
        </Text>
      </View>
    </BottomSheet>
  );
}

/**
 * Botón PRINCIPAL de escaneo: destacado (tinte de acento), con ícono de escáner, etiqueta y una pista
 * corta de cómo funciona. Comunica que esta es la acción preferida (bordes + auto-captura). Usa solo
 * tokens del tema.
 */
function ScanButton({
  label,
  hint,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  hint: string;
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
        {busy ? (
          <ActivityIndicator color={theme.colors.accent} />
        ) : (
          <ScanGlyph size={20} color={theme.colors.accent} />
        )}
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
