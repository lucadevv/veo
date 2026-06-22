import React, { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { IconCheck, IconDocument } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { hexAlpha } from '../components';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import {
  DocumentUploadStatus,
  RegistrationStep,
  registrationDocTypeToBackend,
  serverHasAcceptableDoc,
  type RegistrationDocumentServerStatus,
  type RegistrationDocumentType,
} from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';
import {
  usePersonalDataContinue,
  type DeferredDocument,
} from '../hooks/usePersonalDataContinue';
import { DriverExistence, useDriverExists } from '../hooks/useDriverExists';
import { useRegistrationExit } from '../hooks/useRegistrationExit';
import { useRegistrationExitGuard } from '../hooks/useRegistrationExitGuard';
import { useRegistrationDocuments } from '../hooks/useRegistrationDocuments';
import { useDocumentScanner, useImagePicker } from '../../../../core/di/useDi';
import {
  DocumentUploadCard,
  firstMissingRequirement,
  RegistrationDocumentSheet,
  RegistrationExitSheet,
  RegistrationHeader,
  RegistrationProgress,
  ScanDniSheet,
  type DocumentCardTone,
  type StepRequirement,
} from '../components';
import type {
  DocumentUploadState,
  RegistrationDocumentInput,
} from '../components/RegistrationDocumentSheet';

type Props = NativeStackScreenProps<RegistrationStackParamList, 'PersonalData'>;

/** Etiqueta del wizard de la LICENCIA de conducir (documento del CONDUCTOR; mapea a LICENSE_A1). */
const LICENSE_DOC_TYPE: RegistrationDocumentType = 'LICENSE';

/** Etiqueta del wizard del DNI (documento del CONDUCTOR; mapea a DNI). */
const DNI_DOC_TYPE: RegistrationDocumentType = 'DNI';

/**
 * Mapea el documento DIFERIDO que falló (`DeferredDocument`, discriminador tipado del continue) a su
 * etiqueta del wizard, para revertir su flag LOCAL al estado real cuando la subida falla (sub-fix #F: el
 * chip no debe mentir "Subido" si el server no lo tiene). Sin string mágico: el mapa es exhaustivo.
 */
const DEFERRED_DOC_TO_WIZARD_TYPE: Record<DeferredDocument, RegistrationDocumentType> = {
  dni: DNI_DOC_TYPE,
  license: LICENSE_DOC_TYPE,
};

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
 * DIFERIDA del DNI Y de la LICENCIA (escanear solo GUARDA en `pendingLicense`; la subida + el
 * `POST /drivers/onboard` ocurren en el "Continuar", tras el PATCH que crea el driver — espejo del DNI,
 * porque para un conductor nuevo el presign de la licencia da 404 si se sube en el escaneo). El gating del
 * "Continuar" exige DNI leído + licencia capturada (pendiente de subir, subida local, o ya en el servidor).
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

  // LICENCIA (doc del conductor · LOTE B). La subida + onboarding se DIFIEREN al "Continuar" (espejo del
  // DNI): para un conductor NUEVO el driver no existe hasta el PATCH /personal, así que subir en el escaneo
  // daba 404 "no existe perfil". Acá el escaneo solo GUARDA la captura en `pendingLicense`; el chip de estado
  // de servidor y el 409-como-éxito viven en el continue (`usePersonalDataContinue`).
  const documents = useRegistrationStore((s) => s.documents);
  const setDocumentStatus = useRegistrationStore((s) => s.setDocumentStatus);
  const pendingLicense = useRegistrationStore((s) => s.pendingLicense);
  const setPendingLicense = useRegistrationStore((s) => s.setPendingLicense);
  const serverDocs = useRegistrationDocuments();
  // ¿El SERVIDOR ya tiene al conductor? Señal TIPADA derivada de `GET /drivers/me` (comparte el cache del
  // gate). Unifica la fuente de verdad del continue: en RESUME (driver existe) NO se re-PATCHea (los datos
  // personales ya están server-side y el `personal` local vacío rompía la validación); en alta FRESCA el
  // PATCH crea el driver. Es la pieza que mata el dead-end "los datos leídos no son válidos".
  const driverExistence = useDriverExists();
  const imagePicker = useImagePicker();
  const documentScanner = useDocumentScanner();

  const [serverError, setServerError] = useState<unknown>(null);
  // El PATCH /personal creó el driver, pero una subida DIFERIDA (DNI o licencia) falló. NO perdemos la
  // captura (sigue en `pendingDni`/`pendingLicense`): aviso + reintento al volver a tocar Continuar (PATCH
  // idempotente). `null` = sin fallo; si no, el documento que falló (para pintar el aviso correcto).
  const [uploadFailedDoc, setUploadFailedDoc] = useState<DeferredDocument | null>(null);
  const [scanOpen, setScanOpen] = useState(false);

  // Estado de la captura LOCAL de la LICENCIA (sheet canónico). La captura NO sube: guarda en `pendingLicense`
  // y muestra el check de éxito (misma UX). La subida real ocurre en el continue.
  const [licenseSheetOpen, setLicenseSheetOpen] = useState(false);
  const [licenseUploadState, setLicenseUploadState] = useState<DocumentUploadState>('idle');
  const [licenseError, setLicenseError] = useState<unknown>(null);

  /** ¿El servidor YA tiene el DNI en un estado aceptable? (conductor que vuelve/reinstala). */
  const serverHasDni = serverHasAcceptableDoc(serverDocs.data, 'DNI');
  // El DNI cuenta como "hecho" si el número está poblado (tipeado/escaneado/HIDRATADO desde el server) O
  // el servidor YA lo tiene válido — MISMO criterio server-aware que la licencia. Antes solo miraba el
  // estado LOCAL de sesión (`personal.dni`, vacío al reanudar) y por eso re-pedía el DNI aunque ya estuviera
  // enviado, mientras la licencia (server-aware) NO se re-pedía: esa era la incoherencia del resume.
  const hasReadDni = personal.dni.trim().length > 0 || serverHasDni;
  // ¿Se capturó un DNI? La señal es la IMAGEN del anverso en `pendingDni`, NO los campos OCR: la foto del
  // documento viaja aunque el OCR no extraiga texto (p. ej. binario nativo sin la capa OCR). Así NUNCA se
  // muestra una tarjeta "vacía" que parece OK ni se oculta el fallback honesto cuando el OCR no leyó nada.
  const hasCapture = pendingDni != null;

  const dniBackendType = registrationDocTypeToBackend('DNI');
  // Estado de SERVIDOR del DNI para el chip "ya enviado" (mismo patrón que la licencia): al reanudar SIN
  // captura local pero CON el DNI ya en el servidor, mostramos su estado real en vez de re-pedirlo.
  const dniServerState = (() => {
    const match = serverDocs.data?.find((doc) => doc.type === dniBackendType);
    if (!match) {
      return undefined;
    }
    return {
      label: t(`documents.status.${match.simpleStatus}`),
      tone: serverStatusTone(match.simpleStatus),
    };
  })();

  const licenseBackendType = registrationDocTypeToBackend(LICENSE_DOC_TYPE);

  /** ¿El servidor YA tiene la licencia en un estado aceptable? (conductor que vuelve/reinstala). */
  const serverHasLicense = serverHasAcceptableDoc(serverDocs.data, LICENSE_DOC_TYPE);

  // La licencia cuenta como "lista para avanzar" si: hay una captura DIFERIDA pendiente de subir en el
  // continue (`pendingLicense`), O el avance local la marca `uploaded` (resume/hidratación), O el servidor
  // ya la tiene válida. El `pendingLicense` es la señal del flujo nuevo (escaneo → guarda → sube en Continuar).
  const licenseUploaded =
    pendingLicense != null ||
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

  // U3 · CTA que dice QUÉ falta: derivado del MISMO gating (no se duplica la lógica). El orden refleja la
  // SECUENCIA de pasos (1 · DNI, 2 · Licencia): se muestra el PRIMER requisito incumplido, pegado al CTA.
  const personalRequirements: readonly StepRequirement[] = [
    { satisfied: hasReadDni, missingKey: 'registration.personal.missing.dni' },
    { satisfied: licenseUploaded, missingKey: 'registration.personal.missing.license' },
  ];
  const missingKey = firstMissingRequirement(personalRequirements);

  /**
   * GUARDA la licencia escaneada para subirla DIFERIDA en el "Continuar" (espejo del DNI). NO sube ni hace
   * onboard acá: para un conductor nuevo el driver no existe hasta el PATCH /personal, así que la subida en
   * el escaneo daba 404. La licencia exige número Y vencimiento (ambos críticos en `isCriticalFieldMissing`),
   * así que si el sheet llamó a `onSubmit`, los dos están presentes; el guard explícito narrowa para el
   * contrato y degrada honestamente (si faltara alguno, error en vez de fingir captura).
   */
  const onSubmitLicense = (input: RegistrationDocumentInput): void => {
    setLicenseError(null);
    if (!input.documentNumber || !input.expiresAtIso) {
      // No debería ocurrir (gating crítico del sheet), pero NUNCA guardamos una licencia sin los datos que
      // el onboarding necesita: pedimos reescaneo en vez de capturar algo inservible.
      setLicenseError(new Error(t('registration.documents.licenseUploadFailed')));
      setLicenseUploadState('error');
      return;
    }
    setPendingLicense({
      file: input.file,
      documentNumber: input.documentNumber,
      expiresAt: input.expiresAtIso,
      extractedData: input.extractedData ?? null,
    });
    markLicenseCaptured();
  };

  /** Marca la licencia como capturada localmente y cierra el sheet tras mostrar el check de éxito. */
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
    setUploadFailedDoc(null);

    // El hook orquesta el continue según la FUENTE DE VERDAD del server: en RESUME (driver existe) salta el
    // PATCH y solo corre las subidas diferidas (en resume puro no hay pendientes → solo navega); en alta
    // FRESCA hace el PATCH (crea el driver) → subidas. El `unknown` (server sin resolver) degrada a alta
    // fresca (intenta el PATCH): nunca asumimos que el driver existe sin confirmación. El resultado
    // discriminado dice exactamente qué pintar (sin strings mágicos) y si se avanza.
    const result = await personalContinue.submit({
      personal,
      driverExists: driverExistence === DriverExistence.Exists,
    });
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
      case 'document-upload-failed':
        // El driver YA existe (PATCH OK) pero la subida diferida del DNI o la licencia falló. Conservamos la
        // captura y mostramos el aviso del documento que falló; reintento al volver a tocar Continuar.
        // Sub-fix #F (chip que miente): `markLicenseCaptured` marcó el doc local UPLOADED en el ESCANEO
        // (optimista, antes de subir). Si la subida diferida falló, ese flag seguiría diciendo "Subido"
        // aunque el server NO lo tenga. Revertimos el flag local del doc que falló a PENDING para que el
        // chip refleje la verdad (el `pendingDni`/`pendingLicense` se conserva para reintentar).
        setDocumentStatus(
          DEFERRED_DOC_TO_WIZARD_TYPE[result.document],
          DocumentUploadStatus.PENDING,
        );
        setUploadFailedDoc(result.document);
        return;
    }
  };

  return (
    <>
      <SafeScreen
        scroll
        header={<RegistrationHeader showLogo peru onExit={exit.requestExit} />}
        footer={
          <View style={styles.footer}>
            {/* U3 · feedback PEGADO al CTA: cuando "Continuar" está disabled, decimos QUÉ falta (el primer
                requisito incumplido del gating), no un banner lejano. Tipado (clave i18n derivada), sin
                string mágico. Desaparece cuando todo está listo (el botón se habilita). */}
            {missingKey ? (
              <Text variant="footnote" color="inkMuted" align="center" style={styles.missingHint}>
                {t('registration.personal.missing.label', { detail: t(missingKey) })}
              </Text>
            ) : null}
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
          </View>
        }
      >
        <View style={[styles.body, { gap: theme.spacing['2xl'] }]}>
          {/* La BARRA de progreso (animada) se mantiene como única señal visual del avance: el caption
              textual "Paso N de M" (`registration.stepOf`) se ELIMINÓ — era redundante con la barra y
              empujaba el contenido, invirtiendo la jerarquía. Ahora el TÍTULO display manda. */}
          <Reveal>
            <RegistrationProgress current={1} />
          </Reveal>

          {/* Bloque héroe alineado a la IZQUIERDA con aire generoso (estándar Tesla: Onboarding/Login):
              título `display` que domina + subtítulo `callout` muted. Sin "Paso N de M" encima. */}
          <Reveal delay={80} style={styles.intro}>
            <Text variant="display">{t('registration.personal.title')}</Text>
            <Text variant="callout" color="inkMuted">
              {t('registration.personal.scanSubtitle')}
            </Text>
          </Reveal>

          {/* PASO 1 · DNI (U3 · jerarquía 1-2-3). El "Escanear DNI" YA NO es un botón accent que compite con el
              CTA del footer: es una CARD DE PASO NUMERADA "1 · DNI" — MISMO patrón visual que la licencia
              (`DocumentUploadCard` con estado + acción) — para comunicar "primero esto, después esto". Toda la
              card es presionable y abre el sheet de escaneo (acción DENTRO de la card). El estado del chip
              refleja la verdad: "Listo para enviar" si hay DNI leído/server, o el estado real del servidor; si
              no, "Pendiente". U2 · dedup (DUP #2): una sola affordance de re-escaneo por estado se mantiene —
              la card ES esa única entrada (ya no hay Button suelto con el mismo `setScanOpen`). */}
          <Reveal delay={100} from="scale">
            <DocumentUploadCard
              icon={<IconDocument size={26} color={theme.colors.accent} strokeWidth={1.8} />}
              stepNumber={1}
              label={t('registration.documents.dni')}
              status={hasReadDni ? DocumentUploadStatus.UPLOADED : DocumentUploadStatus.PENDING}
              uploadedLabel={t('registration.documents.state.ready')}
              pendingLabel={t('registration.documents.pending')}
              serverState={dniServerState}
              accessibilityLabel={
                hasCapture || hasReadDni
                  ? t('registration.actions.rescan')
                  : t('registration.personal.scanDni.cta')
              }
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

          {uploadFailedDoc ? (
            <Reveal>
              <Banner
                tone="danger"
                title={
                  uploadFailedDoc === 'license'
                    ? t('registration.documents.licenseUploadFailed')
                    : t('registration.personal.scanDni.uploadFailed')
                }
                description={
                  uploadFailedDoc === 'license'
                    ? t('registration.documents.licenseUploadRetryHint')
                    : t('registration.personal.scanDni.uploadRetryHint')
                }
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
              stepNumber={2}
              label={t('registration.documents.license')}
              status={licenseUploaded ? DocumentUploadStatus.UPLOADED : DocumentUploadStatus.PENDING}
              uploadedLabel={t('registration.documents.state.ready')}
              pendingLabel={t('registration.documents.pending')}
              serverState={licenseServerState}
              busy={personalContinue.isPending}
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
  body: { paddingTop: 20 },
  // Aire Tesla bajo la barra de progreso: el bloque héroe respira (marginTop generoso) y el
  // título+subtítulo quedan juntos por su propio gap.
  intro: { gap: 10, marginTop: 12 },
  footer: { gap: 10 },
  missingHint: {},
  scanHint: { marginTop: 6 },
  capturedCard: { borderWidth: 1, alignItems: 'center' },
  capturedThumb: { width: '100%', height: 160 },
  capturedHeader: { flexDirection: 'row', alignItems: 'center' },
});
