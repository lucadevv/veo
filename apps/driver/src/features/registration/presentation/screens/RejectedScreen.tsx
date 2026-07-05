import React from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Button, SafeScreen, StatusPill, Text, useTheme } from '@veo/ui-kit';
import { FleetDocumentStatus } from '@veo/shared-types';
import type { DriverProfile } from '../../../profile/domain';
import { REGISTRATION_GATE_QUERY_KEY } from '../hooks/useRegistrationGate';
import { useRegistrationDocuments } from '../hooks/useRegistrationDocuments';
import { useResubmitRegistration } from '../hooks/useResubmitRegistration';
import { IconAlert, IconDocument, IconLifebuoy } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { env } from '../../../../core/config/env';
import { correctionStepForRejection, isRejectedStatus, RegistrationStep } from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';
import { useRegistrationExit } from '../hooks/useRegistrationExit';
import { useRegistrationExitGuard } from '../hooks/useRegistrationExitGuard';
import { RegistrationExitSheet, hexAlpha } from '../components';

/** Diámetro del badge de alerta (frame `C/Rejected`: círculo 72 `$danger-dim` con `triangle-alert` 32). */
const BADGE = 72;

/**
 * Pantalla de RECHAZO del alta (drv-09), a imagen del frame `C/Rejected` (composición CENTRADA, tono
 * danger sobrio). El conductor llega cuando identity rechazó sus antecedentes/KYC o el operador rechazó
 * un documento (estado `rejected`). Muestra el MOTIVO real (de `GET /drivers/me → rejectionReason`) + los
 * documentos rechazados con su motivo por-doc (`GET /drivers/me/documents → rejectionReason`), y ofrece
 * dos caminos REALES, cerrando el dead-end:
 *  - "Corregir mis datos": vuelve al wizard al paso del EJE REAL del rechazo (docs conductor/vehículo o KYC).
 *  - "Reenviar a revisión": resubmit (`POST /drivers/me/resubmit`, REJECTED → PENDING), habilitado solo tras
 *    una corrección detectable en esta sesión. La aprobación NUNCA se decide localmente.
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
  const exit = useRegistrationExit();
  useRegistrationExitGuard(exit.handleHardwareBack);

  // El motivo viene del perfil cacheado por el gate (GET /drivers/me); null si no se dio motivo.
  const profile = queryClient.getQueryData<DriverProfile>(REGISTRATION_GATE_QUERY_KEY);
  const reason = profile?.rejectionReason ?? null;

  // M5b: documentos rechazados POR el operador con su motivo (qué corregir y por qué). El rechazo puede ser
  // a nivel antecedentes (reason de arriba) o por documento puntual — acá mostramos los segundos.
  const docs = useRegistrationDocuments();
  const rejectedDocs = (docs.data ?? []).filter(
    (d) => d.status === FleetDocumentStatus.REJECTED && d.rejectionReason,
  );

  const onFix = () => {
    // U4: derivamos el paso del EJE REAL del rechazo (no del paso 1 por omisión): docs del operador,
    // KYC/biometría o antecedentes. Degradación honesta: si no se deriva ningún eje, caemos al paso 1.
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
        // `padded={false}`: el gutter (24 = `2xl`) lo controla la pantalla, alineado con el footer.
        padded={false}
        footer={
          <View style={{ paddingHorizontal: theme.spacing['2xl'], gap: theme.spacing.md }}>
            {/* Corregir mis datos — botón PRIMARY (frame: gradiente azul + glow; usamos el primary canónico). */}
            <Button label={t('registration.rejected.fix')} variant="primary" fullWidth onPress={onFix} />
            {/* Reenviar a revisión — SECONDARY, deshabilitado hasta corregir (frame: opacity 0.55). */}
            <Button
              label={t('registration.rejected.resubmit')}
              variant="secondary"
              fullWidth
              loading={resubmit.isPending}
              disabled={!hasCorrected}
              onPress={() => resubmit.mutate()}
            />
            {!hasCorrected ? (
              <Text variant="footnote" color="inkSubtle" align="center">
                {t('registration.rejected.resubmitHint')}
              </Text>
            ) : null}
            {resubmit.isError ? (
              <Text variant="footnote" color="danger" align="center">
                {t('registration.rejected.resubmitError')}
              </Text>
            ) : null}
            {/* Contactar a soporte — FILA text-link `inkMuted` (frame: no es botón). */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('registration.support.contact')}
              onPress={onContactSupport}
              style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
            >
              <IconLifebuoy size={16} color={theme.colors.inkMuted} strokeWidth={2} />
              <Text variant="subhead" color="inkMuted">
                {t('registration.support.contact')}
              </Text>
            </Pressable>
            {/* Cerrar sesión — link QUIETO `inkSubtle`. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('registration.exit')}
              disabled={exit.isLoggingOut}
              onPress={exit.requestExit}
              style={({ pressed }) => [styles.logoutRow, pressed && styles.pressed]}
            >
              {exit.isLoggingOut ? (
                <ActivityIndicator size="small" color={theme.colors.inkSubtle} />
              ) : (
                <Text variant="footnote" color="inkSubtle">
                  {t('registration.exit')}
                </Text>
              )}
            </Pressable>
          </View>
        }
      >
        <View style={[styles.body, { gap: theme.spacing.lg, paddingHorizontal: theme.spacing['2xl'] }]}>
          {/* Wordmark "VEO" pelado centrado (frame: display 18/700, letterSpacing 1.5). */}
          <Reveal style={styles.brand}>
            <Text variant="title2" style={styles.wordmark}>
              VEO
            </Text>
          </Reveal>

          {/* Badge de alerta (frame: círculo 72 `$danger-dim` + `triangle-alert` 32 `$danger`, plano sin glow). */}
          <Reveal delay={60} style={styles.badgeWrap}>
            <View style={[styles.badge, { backgroundColor: hexAlpha(theme.colors.danger, 0.14) }]}>
              <IconAlert size={32} color={theme.colors.danger} strokeWidth={2} />
            </View>
          </Reveal>

          {/* Bloque héroe CENTRADO (frame): título `display` 30/700 (2 líneas) + subtítulo muted. */}
          <Reveal delay={100} style={styles.intro}>
            <Text variant="title1" align="center">
              {t('registration.rejected.title')}
            </Text>
            <Text variant="callout" color="inkMuted" align="center">
              {t('registration.rejected.subtitle')}
            </Text>
          </Reveal>

          {/* Card del MOTIVO (frame: `$danger-dim` + stroke `#FF4D6A4D`, r-lg, padding 14/18, gap 6).
              Muestra el motivo de antecedentes/KYC; si no hay, un aviso a soporte. */}
          {reason ? (
            <Reveal delay={160}>
              <View
                style={[
                  styles.reasonCard,
                  {
                    backgroundColor: hexAlpha(theme.colors.danger, 0.14),
                    borderColor: hexAlpha(theme.colors.danger, 0.3),
                    borderRadius: theme.radii.lg,
                  },
                ]}
              >
                <Text variant="caption" color="danger" style={styles.reasonLabel}>
                  {t('registration.rejected.reasonLabel')}
                </Text>
                <Text variant="footnote" style={styles.reasonBody}>
                  {reason}
                </Text>
              </View>
            </Reveal>
          ) : (
            <Reveal delay={160}>
              <Text variant="callout" color="inkMuted" align="center">
                {t('registration.rejected.noReason')}
              </Text>
            </Reveal>
          )}

          {/* Documentos a corregir (frame: header `ink-subtle` + filas `DocCard` surface+border con
              icono + nombre + pill "Rechazado"). El motivo por-doc va como segunda línea (dato que el
              frame no muestra pero el conductor necesita para saber QUÉ corregir). */}
          {rejectedDocs.length > 0 ? (
            <Reveal delay={200} style={styles.docsBlock}>
              <Text variant="footnote" color="inkSubtle" style={styles.docsHeader}>
                {t('registration.rejected.docsLabel')}
              </Text>
              {rejectedDocs.map((doc) => (
                <View
                  key={doc.type}
                  style={[
                    styles.docCard,
                    { backgroundColor: theme.colors.surface, borderColor: theme.colors.border, borderRadius: theme.radii.lg },
                  ]}
                >
                  <View style={styles.docRow}>
                    <IconDocument size={20} color={theme.colors.inkMuted} strokeWidth={2} />
                    <Text variant="subhead" style={styles.docName}>
                      {t(`documents.type.${doc.type}`, { defaultValue: doc.type })}
                    </Text>
                    <StatusPill label={t('documents.status.rechazado')} tone="danger" />
                  </View>
                  {doc.rejectionReason ? (
                    <Text variant="footnote" color="inkMuted" style={styles.docReason}>
                      {doc.rejectionReason}
                    </Text>
                  ) : null}
                </View>
              ))}
            </Reveal>
          ) : null}
        </View>
      </SafeScreen>
      <RegistrationExitSheet exit={exit} />
    </>
  );
};

const styles = StyleSheet.create({
  body: { paddingTop: 20, alignItems: 'stretch' },
  // Wordmark centrado (frame).
  brand: { alignSelf: 'center' },
  wordmark: { fontSize: 18, letterSpacing: 1.5 },
  // Badge de alerta centrado.
  badgeWrap: { alignSelf: 'stretch', alignItems: 'center' },
  badge: {
    width: BADGE,
    height: BADGE,
    borderRadius: BADGE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Bloque héroe CENTRADO.
  intro: { gap: 10, alignSelf: 'stretch', alignItems: 'center' },
  // Card del motivo: stroke 1px + padding 14/18 + gap 6 (frame).
  reasonCard: {
    alignSelf: 'stretch',
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 18,
    gap: 6,
  },
  reasonLabel: { letterSpacing: 0.5 },
  reasonBody: { lineHeight: 20 },
  // "Documentos a corregir": header 13/600 + filas DocCard.
  docsBlock: { alignSelf: 'stretch', gap: 8 },
  docsHeader: { fontSize: 13, fontWeight: '600' },
  // Fila de documento (frame: surface + border, padding 14, gap 8).
  docCard: { alignSelf: 'stretch', borderWidth: 1, padding: 14, gap: 8 },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  docName: { flex: 1 },
  docReason: { lineHeight: 19 },
  // Filas text-link del footer.
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  logoutRow: { alignItems: 'center', justifyContent: 'center', paddingTop: 4, paddingVertical: 8 },
  pressed: { opacity: 0.6 },
});
