import React, { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { IconCheck, IconDocument } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { hexAlpha } from '../components';
import { isConflictError, toErrorMessage } from '../../../../shared/presentation/errors';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import {
  DocumentUploadStatus,
  RegistrationStep,
  isAcceptableServerDocStatus,
  registrationDocTypeToBackend,
  type RegistrationDocumentServerStatus,
  type RegistrationDocumentType,
} from '../../domain';
import { REGISTRATION_TOTAL_STEPS, useRegistrationStore } from '../state/registrationStore';
import { usePersonalDataContinue } from '../hooks/usePersonalDataContinue';
import { useRegistrationExit } from '../hooks/useRegistrationExit';
import { useRegistrationExitGuard } from '../hooks/useRegistrationExitGuard';
import {
  useOnboardLicense,
  useRegistrationDocuments,
  useUploadAndRegisterDocument,
} from '../hooks/useRegistrationDocuments';
import { useDocumentScanner, useImagePicker } from '../../../../core/di/useDi';
import {
  DocumentUploadCard,
  RegistrationDocumentSheet,
  RegistrationExitSheet,
  RegistrationHeader,
  RegistrationProgress,
  ScanDniSheet,
  type DocumentCardTone,
} from '../components';
import type {
  DocumentUploadState,
  RegistrationDocumentInput,
} from '../components/RegistrationDocumentSheet';

type Props = NativeStackScreenProps<RegistrationStackParamList, 'PersonalData'>;

/** Etiqueta del wizard de la LICENCIA de conducir (documento del CONDUCTOR; mapea a LICENSE_A1). */
const LICENSE_DOC_TYPE: RegistrationDocumentType = 'LICENSE';

/** Tono del chip según el `simpleStatus` real del documento (espeja el dominio de documentos). */
function serverStatusTone(status: RegistrationDocumentServerStatus): DocumentCardTone {
  switch (status) {
    case 'vigente':
      return 'success';
    case 'por_vencer':
      return 'warn';
    case 'vencido':
    case 'rechazado':
      return 'danger';
    case 'en_revision':
    default:
      return 'neutral';
  }
}

/**
 * Paso 1 del alta · CONDUCTOR (LOTE B · reagrupación por dueño del documento). Reúne los documentos del
 * CONDUCTOR: el DNI (scan-first, onboarding SIN formularios · Lote 1) Y la LICENCIA de conducir (bajada
 * desde el viejo paso "Documentos"). El conductor ESCANEA el DNI (OCR lee nombre/DNI/nacimiento → tarjeta
 * "Capturado ✓" READ-ONLY) y ESCANEA la licencia (reusa el componente CANÓNICO `RegistrationDocumentSheet`
 * + el parser `parseLicense` calibrado en Lote A). Al continuar: `PATCH /drivers/me/personal` + subida
 * DIFERIDA del DNI. La licencia se sube/registra al capturarla (mismo pipeline que tenía DocumentsScreen,
 * incluido el `POST /drivers/onboard`). El gating del "Continuar" exige DNI leído + licencia subida.
 */
export const PersonalDataScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const personal = useRegistrationStore((s) => s.personal);
  // Las caras del DNI escaneado (anverso = miniatura de la tarjeta "DNI capturado ✓"). Es la fuente de
  // verdad de "se capturó un DNI" INDEPENDIENTE del OCR: la imagen viaja aunque el texto no se lea.
  const pendingDni = useRegistrationStore((s) => s.pendingDni);
  const setCurrentStep = useRegistrationStore((s) => s.setCurrentStep);
  // Orquesta el continue: PATCH /personal (crea el driver) → subida DIFERIDA del DNI escaneado (con su
  // `extractedData`). La subida NO puede pasar antes del PATCH (el presign exige que el driver exista).
  const personalContinue = usePersonalDataContinue();

  // Salida de emergencia del onboarding: paso 1 es una pantalla RAÍZ (sin back de navegación).
  const exit = useRegistrationExit();
  useRegistrationExitGuard(exit.handleHardwareBack);

  // LICENCIA (doc del conductor): mismo pipeline canónico que usaba DocumentsScreen (subida+registro +
  // onboarding de licencia + chip de estado de servidor + 409-como-éxito).
  const documents = useRegistrationStore((s) => s.documents);
  const setDocumentStatus = useRegistrationStore((s) => s.setDocumentStatus);
  const serverDocs = useRegistrationDocuments();
  const uploadDocument = useUploadAndRegisterDocument();
  const onboardLicense = useOnboardLicense();
  const imagePicker = useImagePicker();
  const documentScanner = useDocumentScanner();

  const [serverError, setServerError] = useState<unknown>(null);
  // El PATCH /personal creó el driver, pero la subida DIFERIDA del DNI falló. NO perdemos las caras
  // capturadas (siguen en `pendingDni`): aviso + reintento al volver a tocar Continuar (PATCH idempotente).
  const [dniUploadFailed, setDniUploadFailed] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  // Estado de la captura de la LICENCIA (sheet canónico). Mismo patrón que DocumentsScreen.
  const [licenseSheetOpen, setLicenseSheetOpen] = useState(false);
  const [licenseUploadState, setLicenseUploadState] = useState<DocumentUploadState>('idle');
  const [licenseError, setLicenseError] = useState<unknown>(null);

  // El DNI (número) es el campo CRÍTICO: sin él no se puede registrar el documento ni avanzar. El nombre y
  // el nacimiento son deseables pero el gating duro es el número leído. Honestidad: solo avanza con el OCR.
  const hasReadDni = personal.dni.trim().length > 0;
  // ¿Se capturó un DNI? La señal es la IMAGEN del anverso en `pendingDni`, NO los campos OCR: la foto del
  // documento viaja aunque el OCR no extraiga texto (p. ej. binario nativo sin la capa OCR). Así NUNCA se
  // muestra una tarjeta "vacía" que parece OK ni se oculta el fallback honesto cuando el OCR no leyó nada.
  const hasCapture = pendingDni != null;

  const licenseBackendType = registrationDocTypeToBackend(LICENSE_DOC_TYPE);

  /** ¿El servidor YA tiene la licencia en un estado aceptable? (conductor que vuelve/reinstala). */
  const serverHasLicense =
    serverDocs.data?.some(
      (doc) => doc.type === licenseBackendType && isAcceptableServerDocStatus(doc.status),
    ) ?? false;

  // La licencia cuenta como subida si el avance local la marca `uploaded` O el servidor ya la tiene válida.
  const licenseUploaded =
    documents.find((d) => d.type === LICENSE_DOC_TYPE)?.status === DocumentUploadStatus.UPLOADED ||
    serverHasLicense;

  // Estado de SERVIDOR de la licencia para el chip (si existe en `GET /drivers/me/documents`).
  const licenseServerState = (() => {
    const match = serverDocs.data?.find((doc) => doc.type === licenseBackendType);
    if (!match) {
      return undefined;
    }
    return {
      label: t(`documents.status.${match.simpleStatus}`),
      tone: serverStatusTone(match.simpleStatus),
    };
  })();

  // Gating del paso CONDUCTOR (LOTE B): se exige DNI leído + LICENCIA subida para avanzar al Vehículo.
  const canContinue = hasReadDni && licenseUploaded;

  /** Sube+registra la licencia (reusa el pipeline canónico de documentos + onboarding de licencia). */
  const onSubmitLicense = async (input: RegistrationDocumentInput) => {
    setLicenseError(null);
    setLicenseUploadState('uploading');
    try {
      await uploadDocument.mutateAsync({
        type: licenseBackendType,
        file: input.file,
        ...(input.documentNumber ? { documentNumber: input.documentNumber } : {}),
        ...(input.expiresAtIso ? { expiresAt: input.expiresAtIso } : {}),
        ...(input.extractedData ? { extractedData: input.extractedData } : {}),
        ...(input.ocrEngine ? { ocrEngine: input.ocrEngine } : {}),
        ...(input.ocrAt ? { ocrAt: input.ocrAt } : {}),
      });
      // La licencia alimenta el onboarding del conductor (driverOnboardRequest). Exige número Y vencimiento:
      // ambos son crítico-faltante para la licencia (gating de `isCriticalFieldMissing`), así que si el doc
      // llegó al envío, los dos están presentes. El guard explícito narrowa para el contrato.
      if (input.documentNumber && input.expiresAtIso) {
        await onboardLicense.mutateAsync({
          licenseNumber: input.documentNumber,
          licenseExpiresAt: input.expiresAtIso,
        });
      }
      markLicenseCaptured();
    } catch (e) {
      // 409 = la licencia YA fue registrada en un intento previo → ÉXITO, no error (mismo patrón que el
      // DNI/foto/tarjeta). Detectado por status 409 tipado (`isConflictError`), no por el texto.
      if (isConflictError(e)) {
        markLicenseCaptured();
        return;
      }
      setLicenseError(e);
      setLicenseUploadState('error');
    }
  };

  /** Marca la licencia como capturada (subida) y cierra el sheet tras mostrar el check de éxito. */
  function markLicenseCaptured(): void {
    setDocumentStatus(LICENSE_DOC_TYPE, DocumentUploadStatus.UPLOADED);
    setLicenseUploadState('success');
    setTimeout(() => {
      setLicenseSheetOpen(false);
      setLicenseUploadState('idle');
    }, 900);
  }

  const onContinue = async (): Promise<void> => {
    if (personalContinue.isPending) {
      return;
    }
    // Guarda defensiva además del `disabled`: jamás avanzar sin DNI leído + licencia subida.
    if (!canContinue) {
      return;
    }
    setServerError(null);
    setDniUploadFailed(false);

    // El hook orquesta PATCH /personal (crea el driver) → subida DIFERIDA del DNI escaneado (con OCR). El
    // resultado discriminado dice exactamente qué pintar (sin strings mágicos) y si se puede avanzar.
    const result = await personalContinue.submit(personal);
    switch (result.status) {
      case 'ok':
        setCurrentStep(RegistrationStep.VEHICLE);
        navigation.navigate('Vehicle');
        return;
      case 'field-errors':
        // Sin formulario editable no debería ocurrir (el OCR alimenta los campos), pero si el backend
        // valida algo, lo surfaceamos como error de servidor para no dejar al conductor sin feedback.
        setServerError(new Error(t('registration.personal.scanDni.invalidData')));
        return;
      case 'server-error':
        setServerError(result.error);
        return;
      case 'dni-upload-failed':
        setDniUploadFailed(true);
        return;
    }
  };

  return (
    <>
      <SafeScreen
        scroll
        header={<RegistrationHeader showLogo wings peru onExit={exit.requestExit} />}
        footer={
          <Button
            label={t('common.continue')}
            variant="accent"
            fullWidth
            loading={personalContinue.isPending}
            disabled={!canContinue}
            onPress={() => {
              void onContinue();
            }}
          />
        }
      >
        <View style={[styles.body, { gap: theme.spacing.xl }]}>
          <Reveal>
            <RegistrationProgress current={1} />
          </Reveal>

          <Reveal delay={40}>
            <Text variant="caption" color="inkMuted" align="center">
              {t('registration.stepOf', { current: 1, total: REGISTRATION_TOTAL_STEPS })}
            </Text>
          </Reveal>

          <Reveal delay={80} style={styles.intro}>
            <Text variant="title1">{t('registration.personal.title')}</Text>
            <Text variant="callout" color="inkMuted">
              {t('registration.personal.scanSubtitle')}
            </Text>
          </Reveal>

          {/* Acción PRINCIPAL: escanear el DNI (anverso + reverso). El OCR lee los datos; no se tipean. */}
          <Reveal delay={100} from="scale">
            <Button
              label={
                hasCapture
                  ? t('registration.personal.scanDni.rescan')
                  : t('registration.personal.scanDni.cta')
              }
              variant={hasCapture ? 'secondary' : 'accent'}
              fullWidth
              onPress={() => setScanOpen(true)}
            />
            <Text variant="footnote" color="inkSubtle" align="center" style={styles.scanHint}>
              {t('registration.personal.scanDni.hint')}
            </Text>
          </Reveal>

          {serverError ? (
            <Reveal>
              <Banner
                tone="danger"
                title={t('errors.generic')}
                description={toErrorMessage(serverError, t)}
              />
            </Reveal>
          ) : null}

          {dniUploadFailed ? (
            <Reveal>
              <Banner
                tone="danger"
                title={t('registration.personal.scanDni.uploadFailed')}
                description={t('registration.personal.scanDni.uploadRetryHint')}
              />
            </Reveal>
          ) : null}

          {/* TARJETA "DNI capturado ✓" MINIMALISTA: tilde de éxito + miniatura del anverso, SIN mostrar los
              valores (nombre/dni/nacimiento). Se muestra cuando hay captura Y el campo CRÍTICO (número) se
              leyó: una captura que parece OK SOLO cuando de verdad lo está. */}
          {hasCapture && hasReadDni && pendingDni ? (
            <Reveal delay={120} from="scale">
              <View
                style={[
                  styles.capturedCard,
                  {
                    backgroundColor: hexAlpha(theme.colors.success, 0.1),
                    borderColor: hexAlpha(theme.colors.success, 0.4),
                    borderRadius: theme.radii.lg,
                    padding: theme.spacing.md,
                    gap: theme.spacing.md,
                  },
                ]}
              >
                <Image
                  source={{ uri: pendingDni.front.uri }}
                  style={[styles.capturedThumb, { borderRadius: theme.radii.md }]}
                  resizeMode="cover"
                  accessibilityIgnoresInvertColors
                />
                <View style={[styles.capturedHeader, { gap: theme.spacing.xs }]}>
                  <IconCheck size={20} color={theme.colors.success} strokeWidth={2.6} />
                  <Text variant="headline" color="success">
                    {t('registration.personal.scanDni.capturedTitle')}
                  </Text>
                </View>
              </View>
            </Reveal>
          ) : null}

          {/* Fallback HONESTO del campo CRÍTICO: se capturó la foto del DNI pero el OCR NO leyó el número →
              reescaneo (NO un formulario, NO una tarjeta vacía que finge éxito). Se gatilla por la IMAGEN
              capturada (no por los campos OCR), así un OCR que no leyó NADA igual cae acá en vez de quedar
              mudo. Sin el número no se puede registrar el documento ni avanzar. */}
          {hasCapture && !hasReadDni ? (
            <Reveal>
              <Banner
                tone="warn"
                title={t('registration.personal.scanDni.criticalMissingTitle')}
                description={t('registration.personal.scanDni.criticalMissingBody')}
              />
            </Reveal>
          ) : null}

          {serverDocs.isError ? (
            <Reveal>
              <Banner
                tone="warn"
                title={t('errors.generic')}
                description={toErrorMessage(serverDocs.error, t)}
              />
            </Reveal>
          ) : null}

          {/* LICENCIA de conducir (LOTE B · doc del CONDUCTOR, bajada del viejo paso Documentos). Reusa el
              componente CANÓNICO `RegistrationDocumentSheet` + el parser `parseLicense` (Lote A). Requerida
              para avanzar (gating: DNI + licencia). */}
          <Reveal delay={160}>
            <DocumentUploadCard
              icon={<IconDocument size={26} color={theme.colors.accent} strokeWidth={1.8} />}
              label={t('registration.documents.license')}
              status={licenseUploaded ? DocumentUploadStatus.UPLOADED : DocumentUploadStatus.PENDING}
              uploadedLabel={t('registration.documents.uploaded')}
              pendingLabel={t('registration.documents.pending')}
              serverState={licenseServerState}
              busy={uploadDocument.isPending || onboardLicense.isPending}
              accessibilityLabel={t('registration.documents.uploadAccessibility', {
                document: t('registration.documents.license'),
              })}
              onPress={() => {
                setLicenseError(null);
                setLicenseUploadState('idle');
                setLicenseSheetOpen(true);
              }}
            />
          </Reveal>
        </View>

        {licenseSheetOpen ? (
          <RegistrationDocumentSheet
            visible
            onClose={() => {
              if (licenseUploadState !== 'uploading') {
                setLicenseSheetOpen(false);
              }
            }}
            documentLabel={t('registration.documents.license')}
            documentType={licenseBackendType}
            uploadState={licenseUploadState}
            errorMessage={licenseError ? toErrorMessage(licenseError, t) : undefined}
            onPick={(source) => imagePicker.pick(source)}
            onScan={() => documentScanner.scan()}
            onSubmit={onSubmitLicense}
          />
        ) : null}
      </SafeScreen>
      <RegistrationExitSheet exit={exit} />
      <ScanDniSheet visible={scanOpen} onClose={() => setScanOpen(false)} />
    </>
  );
};

const styles = StyleSheet.create({
  body: { paddingTop: 12 },
  intro: { gap: 6 },
  scanHint: { marginTop: 6 },
  capturedCard: { borderWidth: 1, alignItems: 'center' },
  capturedThumb: { width: '100%', height: 160 },
  capturedHeader: { flexDirection: 'row', alignItems: 'center' },
});
