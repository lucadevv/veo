import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Polyline, Rect } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { Banner, BottomSheet, Button, Text, TextField, useTheme } from '@veo/ui-kit';
import {
  ImagePickError,
  type ImageSource,
  type PickedImage,
} from '../../../documents/domain';
import { IconCheck } from '../../../../shared/presentation/icons';
import { DateField } from '../../../../shared/presentation/components/DateField';
import { hexAlpha } from './color';
import {
  REGISTRATION_DOCUMENT_FORM_CONFIG,
  type RegistrationDocumentFormType,
} from './registrationDocumentForm';

/** Glifo de cámara (inline, sin depender del set global de íconos). */
function CameraGlyph({ color, size = 18 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 8a2 2 0 0 1 2-2h1.5l1-1.5h5L16 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={13} r={3} stroke={color} strokeWidth={1.8} />
    </Svg>
  );
}

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
   * Captura/selección del archivo desde la fuente indicada (cámara o galería). La pantalla inyecta el
   * `ImagePickerService` por DI; el sheet NO conoce el SDK nativo. Cancelar resuelve `null`; los
   * fallos accionables lanzan `ImagePickError`.
   */
  onPick: (source: ImageSource) => Promise<PickedImage | null>;
  /** Dispara la subida+registro con los metadatos y el archivo elegido. */
  onSubmit: (input: RegistrationDocumentInput) => void;
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
  // Estado LOCAL del selector (idle/picking/ready). La pantalla impone uploading/success/error vía prop.
  const [localState, setLocalState] = useState<DocumentUploadState>('idle');
  const [pickError, setPickError] = useState<string | null>(null);

  // Reinicia el formulario cada vez que el sheet se abre (cambia de documento).
  useEffect(() => {
    if (visible) {
      setDocumentNumber('');
      setExpiry('');
      setTouched(false);
      setFile(null);
      setLocalState('idle');
      setPickError(null);
    }
  }, [visible]);

  // El estado efectivo: la pantalla manda mientras sube/termina/falla; si no, manda el local.
  const effectiveState: DocumentUploadState =
    uploadState === 'uploading' || uploadState === 'success' || uploadState === 'error'
      ? uploadState
      : localState;

  const isUploading = effectiveState === 'uploading';
  const isSuccess = effectiveState === 'success';
  const captureDisabled = isUploading || isSuccess;

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
              <ImageGlyph size={28} color={theme.colors.inkSubtle} />
              <Text variant="footnote" color="inkSubtle">
                {t('registration.documents.noFile')}
              </Text>
            </View>
          )}
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

        {/* Acciones de captura: cámara o galería. */}
        <View style={[styles.captureRow, { gap: theme.spacing.md }]}>
          <CaptureButton
            label={t('registration.documents.takePhoto')}
            icon={<CameraGlyph size={18} color={theme.colors.ink} />}
            onPress={pickFrom('camera')}
            disabled={captureDisabled}
            busy={effectiveState === 'picking'}
          />
          <CaptureButton
            label={t('registration.documents.fromGallery')}
            icon={<ImageGlyph size={18} color={theme.colors.ink} />}
            onPress={pickFrom('library')}
            disabled={captureDisabled}
            busy={effectiveState === 'picking'}
          />
        </View>

        {/* El campo de número se muestra SOLO para documentos numerados (licencia/SOAT/tarjeta). La foto
            del vehículo (VEHICLE_PHOTO) es solo imagen: no se pide número. */}
        {hasNumber ? (
          <TextField
            label={t(formConfig.numberLabelKey ?? '')}
            placeholder={t(formConfig.numberPlaceholderKey ?? '')}
            value={documentNumber}
            onChangeText={setDocumentNumber}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!captureDisabled}
            error={numberError}
            required
          />
        ) : null}
        {/* El vencimiento se pide SOLO para documentos que vencen (licencia/SOAT). La tarjeta de
            propiedad no vence en Perú: no se muestra el campo ni se exige, y se envía sin `expiresAt`. */}
        {formConfig.hasExpiry ? (
          <DateField
            label={t('registration.documents.expiryLabel')}
            value={expiry}
            onChange={setExpiry}
            placeholder={t('registration.documents.expiryPlaceholder')}
            // Un documento ya vencido no es válido: el picker no permite elegir fechas pasadas.
            minimumDate={today}
            disabled={captureDisabled}
            error={expiryError}
          />
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

/** Botón de captura (cámara/galería) con ícono + estado ocupado. Usa solo tokens del tema. */
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
  captureRow: { flexDirection: 'row' },
  captureButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
