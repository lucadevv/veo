import React from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { FleetDocumentStatus } from '@veo/shared-types';
import type { DriverProfile } from '../../../profile/domain';
import { REGISTRATION_GATE_QUERY_KEY } from '../hooks/useRegistrationGate';
import { useRegistrationDocuments } from '../hooks/useRegistrationDocuments';
import { useResubmitRegistration } from '../hooks/useResubmitRegistration';
import { IconLifebuoy } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { env } from '../../../../core/config/env';
import { correctionStepForRejection, isRejectedStatus, RegistrationStep } from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';
import { useRegistrationExit } from '../hooks/useRegistrationExit';
import { useRegistrationExitGuard } from '../hooks/useRegistrationExitGuard';
import { RegistrationExitSheet, VeoWordmark, hexAlpha } from '../components';

/**
 * Pantalla de RECHAZO del alta (drv-09). El conductor llega aquí cuando identity rechazó sus
 * antecedentes (estado `rejected`). Muestra el MOTIVO real del rechazo (de `GET /drivers/me`,
 * `rejectionReason`) y ofrece dos caminos REALES, cerrando el dead-end:
 *  - "Corregir mis datos": vuelve al wizard (el store marca `in_progress`) para re-subir lo observado.
 *  - "Reenviar a revisión": resubmit directo (`POST /drivers/me/resubmit`, REJECTED → PENDING) cuando el
 *    conductor ya corrigió y solo quiere volver a la cola sin re-recorrer el wizard.
 * La aprobación NUNCA se decide localmente: tras reenviar, el gate reconcilia contra el backend.
 */
export const RejectedScreen = (): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const setCurrentStep = useRegistrationStore((s) => s.setCurrentStep);
  const markCorrectionStarted = useRegistrationStore((s) => s.markCorrectionStarted);
  // U4: gobierna "Reenviar a revisión" — solo se habilita tras una corrección detectable (el conductor
  // entró al wizard vía "Corregir mis datos" en esta sesión), para no re-mandar lo MISMO que fue rechazado.
  const hasCorrected = useRegistrationStore((s) => s.hasCorrectedAfterRejection);
  const resubmit = useResubmitRegistration();

  // Pantalla RAÍZ del estado `rejected`: además de corregir/reenviar, el conductor debe poder salir.
  // Reusa el mismo logout/clearSession + guard del back de hardware (que de otro modo cerraría la app).
  const exit = useRegistrationExit();
  useRegistrationExitGuard(exit.handleHardwareBack);

  // El motivo viene del perfil cacheado por el gate (GET /drivers/me); null si no se dio motivo.
  const profile = queryClient.getQueryData<DriverProfile>(REGISTRATION_GATE_QUERY_KEY);
  const reason = profile?.rejectionReason ?? null;

  // M5b: documentos rechazados POR el operador con su motivo (qué corregir y por qué). El rechazo puede
  // ser a nivel antecedentes (reason de arriba) o por documento puntual — acá mostramos los segundos. El
  // motivo por-documento vive en el doc-detalle (GET /drivers/me/documents), no en el perfil ligero.
  const docs = useRegistrationDocuments();
  const rejectedDocs = (docs.data ?? []).filter(
    (d) => d.status === FleetDocumentStatus.REJECTED && d.rejectionReason,
  );

  const onFix = () => {
    // Vuelve al wizard para corregir. `setCurrentStep` ya marca `in_progress` (el RootNavigator
    // conmuta a Registration) Y fija el paso inicial del wizard (`RegistrationNavigator` lo lee del
    // store). Antes solo cambiaba el status y reabría en el `currentStep` persistido (típicamente 4 =
    // KYC), desorientando al conductor.
    //
    // U4: derivamos el paso del EJE REAL del rechazo (no del paso 1 por omisión). El rechazo tiene tres
    // ejes independientes (espejo de `mapProfileToRegistrationStatus`): documentos del operador
    // (`rejectedDocs`), KYC/biometría (`kycStatus`) y antecedentes (`backgroundCheckStatus`).
    //  - Si hay docs rechazados derivables a un paso → ese paso (Conductor/Vehículo).
    //  - Si el rechazo es de BIOMETRÍA/identidad o ANTECEDENTES (sin documento del alta derivable) →
    //    paso KYC (`IDENTITY_VERIFICATION`), NO el paso 1: el conductor NO debe re-recorrer datos +
    //    vehículo + docs que estaban BIEN solo porque le rechazaron la selfie/antecedentes.
    //  - Degradación honesta: si no se puede derivar ningún eje, caemos al paso 1 para re-recorrer en orden.
    const targetStep =
      correctionStepForRejection({
        rejectedDocTypes: rejectedDocs.map((doc) => doc.type),
        kycRejected: profile ? isRejectedStatus(profile.kycStatus) : false,
        backgroundCheckRejected: profile ? isRejectedStatus(profile.backgroundCheckStatus) : false,
      }) ?? RegistrationStep.PERSONAL_DATA;
    // U4: marca la corrección de ESTA sesión → habilita "Reenviar a revisión" (rompe el loop de reenvío).
    markCorrectionStarted();
    setCurrentStep(targetStep);
  };

  const onContactSupport = () => {
    Linking.openURL(`mailto:${env.SUPPORT_EMAIL}`).catch(() => undefined);
  };

  return (
    <>
    <SafeScreen
      scroll
      // `padded={false}`: el gutter (24 = `2xl`, editorial de Login/Onboarding) lo controla la pantalla.
      // Sin esto SafeScreen sumaba su 20 al 24 del body → 44, desalineado del footer. Una sola fuente.
      padded={false}
      footer={
        <View style={{ paddingHorizontal: theme.spacing['2xl'], gap: theme.spacing.sm }}>
          <Button
            label={t('registration.rejected.fix')}
            variant="primary"
            fullWidth
            onPress={onFix}
          />
          <Button
            label={t('registration.rejected.resubmit')}
            variant="secondary"
            fullWidth
            loading={resubmit.isPending}
            disabled={!hasCorrected}
            onPress={() => resubmit.mutate()}
          />
          {!hasCorrected ? (
            <Text variant="footnote" color="inkMuted" align="center">
              {t('registration.rejected.resubmitHint')}
            </Text>
          ) : null}
          <Button
            label={t('registration.support.contact')}
            variant="ghost"
            fullWidth
            leftIcon={<IconLifebuoy size={18} color={theme.colors.accent} strokeWidth={2} />}
            onPress={onContactSupport}
          />
          <Button
            label={t('registration.exit')}
            variant="ghost"
            fullWidth
            loading={exit.isLoggingOut}
            onPress={exit.requestExit}
          />
        </View>
      }
    >
      <View style={[styles.body, { gap: theme.spacing.xl, paddingHorizontal: theme.spacing['2xl'] }]}>
        <Reveal style={styles.brand}>
          <VeoWordmark size="sm" peru />
        </Reveal>

        {/* Sin glyph 132px ni barra de color: el ancla es la TIPOGRAFÍA. Título display alineado a la
            izquierda (gutter 2xl, como Onboarding) — jerarquía por escala + aire; el foco real es la
            reason card de abajo. */}
        <Reveal delay={120} style={styles.intro}>
          <Text variant="display">{t('registration.rejected.title')}</Text>
          <Text variant="callout" color="inkMuted">
            {t('registration.rejected.subtitle')}
          </Text>
        </Reveal>

        {reason ? (
          <Reveal delay={180}>
            <View
              style={[
                styles.reasonCard,
                {
                  backgroundColor: hexAlpha(theme.colors.danger, 0.1),
                  borderColor: hexAlpha(theme.colors.danger, 0.35),
                  borderRadius: theme.radii.lg,
                  padding: theme.spacing.lg,
                  gap: theme.spacing.xs,
                },
              ]}
            >
              <Text variant="subhead" color="danger">
                {t('registration.rejected.reasonLabel')}
              </Text>
              <Text variant="bodyStrong">{reason}</Text>
            </View>
          </Reveal>
        ) : (
          <Reveal delay={180}>
            <Text variant="callout" color="inkMuted" align="center">
              {t('registration.rejected.noReason')}
            </Text>
          </Reveal>
        )}

        {rejectedDocs.length > 0 ? (
          <Reveal delay={210} style={{ gap: theme.spacing.sm }}>
            <Text variant="subhead" color="danger">
              {t('registration.rejected.docsLabel')}
            </Text>
            {rejectedDocs.map((doc) => (
              <View
                key={doc.type}
                style={[
                  styles.reasonCard,
                  {
                    backgroundColor: hexAlpha(theme.colors.danger, 0.1),
                    borderColor: hexAlpha(theme.colors.danger, 0.35),
                    borderRadius: theme.radii.lg,
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xs,
                  },
                ]}
              >
                <Text variant="subhead">
                  {t(`documents.type.${doc.type}`, { defaultValue: doc.type })}
                </Text>
                <Text variant="bodyStrong">{doc.rejectionReason}</Text>
              </View>
            ))}
          </Reveal>
        ) : null}

        {resubmit.isError ? (
          <Text variant="subhead" color="danger" align="center">
            {t('registration.rejected.resubmitError')}
          </Text>
        ) : null}
      </View>
    </SafeScreen>
    <RegistrationExitSheet exit={exit} />
    </>
  );
};

const styles = StyleSheet.create({
  body: { paddingTop: 16, alignItems: 'stretch' },
  brand: { alignItems: 'center', gap: 6 },
  intro: { gap: 12, alignSelf: 'stretch' },
  reasonCard: { alignSelf: 'stretch' },
});
