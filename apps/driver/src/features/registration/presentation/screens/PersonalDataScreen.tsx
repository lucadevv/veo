import React, { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { IconCheck } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { hexAlpha } from '../components';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import { RegistrationStep } from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';
import { usePersonalDataContinue } from '../hooks/usePersonalDataContinue';
import { useRegistrationExit } from '../hooks/useRegistrationExit';
import { useRegistrationExitGuard } from '../hooks/useRegistrationExitGuard';
import {
  RegistrationExitSheet,
  RegistrationHeader,
  RegistrationProgress,
  ScanDniSheet,
} from '../components';

type Props = NativeStackScreenProps<RegistrationStackParamList, 'PersonalData'>;

/**
 * Paso 1 del alta: datos personales del DNI (drv-04) · onboarding SIN formularios (Lote 1). El conductor
 * ESCANEA el DNI; el OCR lee nombre/DNI/nacimiento y se muestran en una tarjeta "Capturado ✓" READ-ONLY
 * (texto, NO inputs). Al continuar: `PATCH /drivers/me/personal` con la data OCR + subida del DNI con su
 * `extractedData`. NO hay tipeo manual: si el OCR no leyó el NÚMERO de DNI (campo crítico), se pide
 * reescanear (degradación honesta), nunca un formulario.
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

  const [serverError, setServerError] = useState<unknown>(null);
  // El PATCH /personal creó el driver, pero la subida DIFERIDA del DNI falló. NO perdemos las caras
  // capturadas (siguen en `pendingDni`): aviso + reintento al volver a tocar Continuar (PATCH idempotente).
  const [dniUploadFailed, setDniUploadFailed] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  // El DNI (número) es el campo CRÍTICO: sin él no se puede registrar el documento ni avanzar. El nombre y
  // el nacimiento son deseables pero el gating duro es el número leído. Honestidad: solo avanza con el OCR.
  const hasReadDni = personal.dni.trim().length > 0;
  // ¿Se capturó un DNI? La señal es la IMAGEN del anverso en `pendingDni`, NO los campos OCR: la foto del
  // documento viaja aunque el OCR no extraiga texto (p. ej. binario nativo sin la capa OCR). Así NUNCA se
  // muestra una tarjeta "vacía" que parece OK ni se oculta el fallback honesto cuando el OCR no leyó nada.
  const hasCapture = pendingDni != null;
  const canContinue = hasReadDni;

  const onContinue = async (): Promise<void> => {
    if (personalContinue.isPending) {
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
              {t('registration.stepOf', { current: 1, total: 4 })}
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
        </View>
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
