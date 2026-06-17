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
import {
  registrationDocTypeToBackend,
  type RegistrationDocumentServerStatus,
  type RegistrationDocumentType,
} from '../../domain';
import {
  useOnboardLicense,
  useRegistrationDocuments,
  useSubmitRegistrationDocument,
} from '../hooks/useRegistrationDocuments';
import {
  DocumentUploadCard,
  RegistrationDocumentSheet,
  RegistrationHeader,
  RegistrationProgress,
  type DocumentCardTone,
} from '../components';
import type { RegistrationDocumentInput } from '../components/RegistrationDocumentSheet';

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

  // Rehidrata el estado real de los documentos (chips reflejan `simpleStatus`).
  const serverDocs = useRegistrationDocuments();
  const submitDocument = useSubmitRegistrationDocument();
  const onboardLicense = useOnboardLicense();

  // Documento cuyo sheet de captura está abierto (null = cerrado).
  const [activeType, setActiveType] = useState<RegistrationDocumentType | null>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);

  const statusOf = (type: RegistrationDocumentType) =>
    documents.find((d) => d.type === type)?.status ?? 'pending';

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

  const onSubmitDocument = async (input: RegistrationDocumentInput) => {
    if (!activeType) {
      return;
    }
    setSubmitError(null);
    try {
      // Registra el documento (queda en revisión en fleet).
      await submitDocument.mutateAsync({
        type: registrationDocTypeToBackend(activeType),
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
      // Marca el avance local (permite continuar el wizard) y refresca los chips.
      setDocumentStatus(activeType, 'uploaded');
      setActiveType(null);
    } catch (e) {
      setSubmitError(e);
    }
  };

  // Gating del paso 3: NO se puede avanzar a la verificación de identidad sin TODOS los documentos
  // requeridos subidos (licencia/SOAT/tarjeta de propiedad). Coherente con `isDraftComplete` y con la
  // regla de negocio (no se completa el alta con documentación faltante). `DOCS` es el catálogo de
  // requeridos; cada uno debe estar en `uploaded` localmente (el chip del servidor es informativo).
  const allRequiredUploaded = DOCS.every((doc) => statusOf(doc.type) === 'uploaded');

  const onContinue = () => {
    // Guarda defensiva además del `disabled` del botón: jamás avanzar con documentos pendientes.
    if (!allRequiredUploaded) {
      return;
    }
    setCurrentStep(4);
    navigation.navigate('IdentityVerification');
  };

  const submitting = submitDocument.isPending || onboardLicense.isPending;

  return (
    <SafeScreen
      scroll
      header={<RegistrationHeader showLogo wings peru onBack={navigation.goBack} />}
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
                  onPress={() => {
                    setSubmitError(null);
                    setActiveType(doc.type);
                  }}
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

      <RegistrationDocumentSheet
        visible={activeDoc !== null}
        onClose={() => setActiveType(null)}
        documentLabel={activeDoc ? t(activeDoc.labelKey) : ''}
        requireExpiry={activeType === 'LICENSE'}
        submitting={submitting}
        errorMessage={submitError ? toErrorMessage(submitError, t) : undefined}
        onSubmit={onSubmitDocument}
      />
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  body: { paddingTop: 12 },
  intro: { gap: 6 },
  list: {},
  note: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 },
  noteText: { flex: 1 },
});
