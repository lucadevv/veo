import React from 'react';
import {Linking, StyleSheet, View} from 'react-native';
import Svg, {Circle, Path} from 'react-native-svg';
import {useTranslation} from 'react-i18next';
import {useQueryClient} from '@tanstack/react-query';
import {Button, SafeScreen, Text, useTheme} from '@veo/ui-kit';
import type {DriverProfile} from '../../../profile/domain';
import {REGISTRATION_GATE_QUERY_KEY} from '../hooks/useRegistrationGate';
import {useResubmitRegistration} from '../hooks/useResubmitRegistration';
import {IconLifebuoy} from '../../../../shared/presentation/icons';
import {Reveal} from '../../../../shared/presentation/components/motion';
import {env} from '../../../../core/config/env';
import {useRegistrationStore} from '../state/registrationStore';
import {VeoWordmark, hexAlpha} from '../components';

/** Ilustración de alerta (line art) para la pantalla de rechazo. */
function RejectGlyph({color}: {color: string}): React.JSX.Element {
  return (
    <Svg width={132} height={132} viewBox="0 0 132 132" fill="none">
      <Circle cx={66} cy={66} r={44} stroke={color} strokeWidth={2.4} />
      <Path d="M66 40v34" stroke={color} strokeWidth={2.8} strokeLinecap="round" />
      <Circle cx={66} cy={90} r={2.6} fill={color} />
    </Svg>
  );
}

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
  const {t} = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const setStatus = useRegistrationStore(s => s.setStatus);
  const resubmit = useResubmitRegistration();

  // El motivo viene del perfil cacheado por el gate (GET /drivers/me); null si no se dio motivo.
  const profile = queryClient.getQueryData<DriverProfile>(REGISTRATION_GATE_QUERY_KEY);
  const reason = profile?.rejectionReason ?? null;

  const onFix = () => {
    // Vuelve al wizard para corregir: marca `in_progress` (el RootNavigator conmuta a Registration).
    setStatus('in_progress');
  };

  const onContactSupport = () => {
    Linking.openURL(`mailto:${env.SUPPORT_EMAIL}`).catch(() => undefined);
  };

  return (
    <SafeScreen
      scroll
      footer={
        <View style={{gap: theme.spacing.sm}}>
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
            onPress={() => resubmit.mutate()}
          />
          <Button
            label={t('registration.rejected.contactSupport')}
            variant="ghost"
            fullWidth
            leftIcon={<IconLifebuoy size={18} color={theme.colors.accent} strokeWidth={2} />}
            onPress={onContactSupport}
          />
        </View>
      }>
      <View style={[styles.body, {gap: theme.spacing.xl}]}>
        <Reveal style={styles.brand}>
          <VeoWordmark size="sm" peru />
        </Reveal>

        <Reveal delay={60} spring style={styles.illustration}>
          <RejectGlyph color={theme.colors.danger} />
        </Reveal>

        <Reveal delay={120} style={styles.intro}>
          <Text variant="title1" align="center">
            {t('registration.rejected.title')}
          </Text>
          <Text variant="callout" color="inkMuted" align="center">
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
              ]}>
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

        {resubmit.isError ? (
          <Text variant="subhead" color="danger" align="center">
            {t('registration.rejected.resubmitError')}
          </Text>
        ) : null}
      </View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  body: {paddingTop: 16, alignItems: 'stretch'},
  brand: {alignItems: 'center', gap: 6},
  illustration: {alignItems: 'center'},
  intro: {gap: 8},
  reasonCard: {alignSelf: 'stretch'},
});
