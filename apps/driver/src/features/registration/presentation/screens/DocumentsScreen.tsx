import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { IconCar, IconDocument, IconShield } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import { useRegistrationStore } from '../state/registrationStore';
import { useRegistrationStepBack } from '../hooks/useRegistrationStepBack';
import {
  DocumentUploadStatus,
  RegistrationStep,
  isAcceptableServerDocStatus,
  registrationDocTypeToBackend,
  type RegistrationDocumentServerStatus,
  type RegistrationDocumentType,
} from '../../domain';
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
  type DocumentCardTone,
} from '../components';
import type {
  DocumentUploadState,
  RegistrationDocumentInput,
} from '../components/RegistrationDocumentSheet';

type Props = NativeStackScreenProps<RegistrationStackParamList, 'Documents'>;

/** Glifo informativo (i) del aviso de formatos. */
function InfoGlyph({ color, size = 16 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={2} />
      <Path d="M12 11v5" stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Circle cx={12} cy={8} r={0.6} fill={color} stroke={color} strokeWidth={1.6} />
    </Svg>
  );
}

const DOCS: { type: RegistrationDocumentType; labelKey: string; icon: typeof IconDocument }[] = [
  { type: 'LICENSE', labelKey: 'registration.documents.license', icon: IconDocument },
  { type: 'SOAT', labelKey: 'registration.documents.soat', icon: IconShield },
  { type: 'VEHICLE_REGISTRATION', labelKey: 'registration.documents.property', icon: IconCar },
];

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

/** Paso 3 del alta: subida de documentos del conductor (drv-06) contra el driver-bff. */
export const DocumentsScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const documents = useRegistrationStore((s) => s.documents);
  const setDocumentStatus = useRegistrationStore((s) => s.setDocumentStatus);
  const setCurrentStep = useRegistrationStore((s) => s.setCurrentStep);

  // Back robusto del paso: reconstruye la pila al reanudar (si quedó superficial) y nunca dispara un
  // GO_BACK muerto (si no hay paso previo, abre el exit-confirm del Lote 1). Cubre software + hardware.
  const back = useRegistrationStepBack();

  // Rehidrata el estado real de los documentos (chips reflejan `simpleStatus`).
  const serverDocs = useRegistrationDocuments();
  const uploadDocument = useUploadAndRegisterDocument();
  const onboardLicense = useOnboardLicense();
  const imagePicker = useImagePicker();
  const documentScanner = useDocumentScanner();

  // Documento cuyo sheet de captura está abierto (null = cerrado).
  const [activeType, setActiveType] = useState<RegistrationDocumentType | null>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);
  // Estado de la subida del documento ACTIVO (máquina honesta: idle/uploading/success/error).
  const [uploadState, setUploadState] = useState<DocumentUploadState>('idle');

  const statusOf = (type: RegistrationDocumentType) =>
    documents.find((d) => d.type === type)?.status ?? DocumentUploadStatus.PENDING;

  /** Estado del servidor para un documento del wizard (si ya existe en `GET /drivers/me/documents`). */
  const serverStateOf = (type: RegistrationDocumentType) => {
    const backendType = registrationDocTypeToBackend(type);
    const match = serverDocs.data?.find((doc) => doc.type === backendType);
    if (!match) {
      return undefined;
    }
    return {
      label: t(`documents.status.${match.simpleStatus}`),
      tone: serverStatusTone(match.simpleStatus),
    };
  };

  const activeDoc = DOCS.find((d) => d.type === activeType) ?? null;

  /** Abre el sheet de un documento, reiniciando el estado de subida y el error previo. */
  const openDocument = (type: RegistrationDocumentType) => {
    setSubmitError(null);
    setUploadState('idle');
    setActiveType(type);
  };

  /** Cierra el sheet (solo si no hay una subida en curso). */
  const closeSheet = () => {
    if (uploadState === 'uploading') {
      return;
    }
    setActiveType(null);
    setUploadState('idle');
  };

  const onSubmitDocument = async (input: RegistrationDocumentInput) => {
    if (!activeType) {
      return;
    }
    setSubmitError(null);
    setUploadState('uploading');
    try {
      // SUBE el binario al almacén soberano y REGISTRA el documento con su `fileS3Key` (queda en
      // revisión en fleet). El flujo solo registra si el PUT del binario fue OK (sin éxito falso).
      await uploadDocument.mutateAsync({
        type: registrationDocTypeToBackend(activeType),
        file: input.file,
        documentNumber: input.documentNumber,
        ...(input.expiresAtIso ? { expiresAt: input.expiresAtIso } : {}),
      });
      // La licencia, además, alimenta el onboarding del conductor (driverOnboardRequest).
      if (activeType === 'LICENSE' && input.expiresAtIso) {
        await onboardLicense.mutateAsync({
          licenseNumber: input.documentNumber,
          licenseExpiresAt: input.expiresAtIso,
        });
      }
      // Éxito real: marca el avance local (permite continuar el wizard) y refresca los chips.
      setDocumentStatus(activeType, DocumentUploadStatus.UPLOADED);
      setUploadState('success');
      // Cierra el sheet tras un breve instante para que el conductor vea el check de éxito.
      setTimeout(() => {
        setActiveType((current) => (current === activeType ? null : current));
        setUploadState('idle');
      }, 900);
    } catch (e) {
      setSubmitError(e);
      setUploadState('error');
    }
  };

  /**
   * ¿El servidor YA tiene este documento en un estado ACEPTABLE para avanzar el alta? Misma fuente de
   * verdad que `VehicleScreen` para la foto: si el conductor reinstaló o cambió de device, el store
   * local arranca en `pending` pero el backend ya tiene el doc subido y en revisión/vigente, así que
   * debe contar como subido. Un doc RECHAZADO o VENCIDO NO cuenta: hay que re-subirlo (el chip lo
   * muestra en rojo). El predicado tipado del dominio (`isAcceptableServerDocStatus`) decide qué
   * estados crudos de fleet cuentan; un estado desconocido cae en "no cuenta" (default seguro).
   */
  const serverHasValidDoc = (type: RegistrationDocumentType): boolean => {
    const backendType = registrationDocTypeToBackend(type);
    return (
      serverDocs.data?.some(
        (doc) => doc.type === backendType && isAcceptableServerDocStatus(doc.status),
      ) ?? false
    );
  };

  // Gating del paso 3: NO se puede avanzar a la verificación de identidad sin TODOS los documentos
  // requeridos subidos (licencia/SOAT/tarjeta de propiedad). Coherente con `isDraftComplete` y con la
  // regla de negocio (no se completa el alta con documentación faltante). Un documento cuenta como
  // subido si el avance local lo marca `uploaded` O si el servidor YA lo tiene en estado válido
  // (conductor que vuelve/reinstala): sin esto el gate quedaba bloqueado para siempre pese a que el
  // backend ya tenía los docs. Espeja `photoUploaded` de `VehicleScreen` (misma fuente de verdad).
  const allRequiredUploaded = DOCS.every(
    (doc) => statusOf(doc.type) === DocumentUploadStatus.UPLOADED || serverHasValidDoc(doc.type),
  );

  const onContinue = () => {
    // Guarda defensiva además del `disabled` del botón: jamás avanzar con documentos pendientes.
    if (!allRequiredUploaded) {
      return;
    }
    setCurrentStep(RegistrationStep.IDENTITY_VERIFICATION);
    navigation.navigate('IdentityVerification');
  };

  const submitting = uploadDocument.isPending || onboardLicense.isPending;

  return (
    <>
    <SafeScreen
      scroll
      header={<RegistrationHeader showLogo wings peru onBack={back.onBack} />}
      footer={
        <Button
          label={t('common.continue')}
          variant="accent"
          fullWidth
          disabled={!allRequiredUploaded}
          onPress={onContinue}
        />
      }
    >
      <View style={[styles.body, { gap: theme.spacing.xl }]}>
        <Reveal>
          <RegistrationProgress current={3} />
        </Reveal>

        <Reveal delay={40} style={styles.intro}>
          <Text variant="caption" color="inkMuted" align="center">
            {t('registration.stepOf', { current: 3, total: 4 })}
          </Text>
          <Text variant="title1">{t('registration.documents.title')}</Text>
          <Text variant="callout" color="inkMuted">
            {t('registration.documents.subtitle')}
          </Text>
        </Reveal>

        {serverDocs.isError ? (
          <Reveal>
            <Banner
              tone="warn"
              title={t('errors.generic')}
              description={toErrorMessage(serverDocs.error, t)}
            />
          </Reveal>
        ) : null}

        <View style={[styles.list, { gap: theme.spacing.md }]}>
          {DOCS.map((doc, index) => {
            const Icon = doc.icon;
            const label = t(doc.labelKey);
            return (
              <Reveal key={doc.type} delay={90 + index * 60}>
                <DocumentUploadCard
                  icon={<Icon size={26} color={theme.colors.accent} strokeWidth={1.8} />}
                  label={label}
                  status={statusOf(doc.type)}
                  uploadedLabel={t('registration.documents.uploaded')}
                  pendingLabel={t('registration.documents.pending')}
                  serverState={serverStateOf(doc.type)}
                  busy={submitting && activeType === doc.type}
                  accessibilityLabel={t('registration.documents.uploadAccessibility', {
                    document: label,
                  })}
                  onPress={() => openDocument(doc.type)}
                />
              </Reveal>
            );
          })}
        </View>

        <Reveal delay={300} style={[styles.note, { gap: theme.spacing.sm }]}>
          <InfoGlyph color={theme.colors.inkSubtle} />
          <Text variant="footnote" color="inkSubtle" style={styles.noteText}>
            {t('registration.documents.formats')}
          </Text>
        </Reveal>
      </View>

      {activeDoc ? (
        <RegistrationDocumentSheet
          visible
          onClose={closeSheet}
          documentLabel={t(activeDoc.labelKey)}
          // El tipo CANÓNICO selecciona la config contextual del formulario en el sheet (etiqueta del
          // número propia + si el documento vence). El mapeo es el mismo que viaja al backend.
          documentType={registrationDocTypeToBackend(activeDoc.type)}
          uploadState={uploadState}
          errorMessage={submitError ? toErrorMessage(submitError, t) : undefined}
          onPick={(source) => imagePicker.pick(source)}
          onScan={() => documentScanner.scan()}
          onSubmit={onSubmitDocument}
        />
      ) : null}
    </SafeScreen>
    <RegistrationExitSheet exit={back.exit} />
    </>
  );
};

const styles = StyleSheet.create({
  body: { paddingTop: 12 },
  intro: { gap: 6 },
  list: {},
  note: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 },
  noteText: { flex: 1 },
});
