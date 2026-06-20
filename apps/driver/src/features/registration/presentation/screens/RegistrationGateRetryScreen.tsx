import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { useRegistrationExit } from '../hooks/useRegistrationExit';
import { useRegistrationExitGuard } from '../hooks/useRegistrationExitGuard';
import { RegistrationExitSheet, VeoWordmark, hexAlpha } from '../components';

/** Ilustración de "sin conexión / reintentar" (line art) para la pantalla de reintento del gate. */
function RetryGlyph({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={132} height={132} viewBox="0 0 132 132" fill="none">
      <Circle cx={66} cy={66} r={44} stroke={color} strokeWidth={2.4} />
      <Path
        d="M82 54a20 20 0 1 0 3 18"
        stroke={color}
        strokeWidth={2.8}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M82 46v9h-9"
        stroke={color}
        strokeWidth={2.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

interface RegistrationGateRetryScreenProps {
  /** Reintenta resolver el perfil del conductor (`GET /drivers/me`). */
  onRetry(): void;
}

/**
 * Pantalla de REINTENTO del gate de alta. Se muestra cuando `useRegistrationGate` no pudo resolver el
 * perfil del conductor por un error NO definitivo (red / 5xx / 429) y nunca se resolvió antes. La
 * sesión sigue válida (los tokens están OK): lo único que falló fue `GET /drivers/me`. En vez de
 * limpiar la sesión y mandar al conductor a un banner de error de login confuso (o a un dead-end),
 * ofrecemos un reintento explícito que recupera el flujo (gate → wizard / tabs / revisión).
 */
export const RegistrationGateRetryScreen = ({
  onRetry,
}: RegistrationGateRetryScreenProps): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();

  // Escape CRÍTICO de la "sesión zombie": el gate no resuelve el perfil y, sin esto, "Reintentar" es el
  // único botón → dead-end si el reintento sigue fallando. La salida reusa el mismo logout/clearSession.
  const exit = useRegistrationExit();
  useRegistrationExitGuard(exit.handleHardwareBack);

  return (
    <>
    <SafeScreen
      footer={
        <View style={{ gap: theme.spacing.sm }}>
          <Button
            label={t('registration.gateRetry.retry')}
            variant="primary"
            fullWidth
            onPress={onRetry}
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
      <View style={styles.container}>
        <Reveal>
          <VeoWordmark />
        </Reveal>
        <Reveal delay={80}>
          <View
            style={[
              styles.glyphWrap,
              { backgroundColor: hexAlpha(theme.colors.accent, 0.08) },
            ]}
          >
            <RetryGlyph color={theme.colors.accent} />
          </View>
        </Reveal>
        <Reveal delay={160}>
          <Text variant="title2" style={styles.title}>
            {t('registration.gateRetry.title')}
          </Text>
        </Reveal>
        <Reveal delay={220}>
          <Text variant="body" color="inkSubtle" style={styles.body}>
            {t('registration.gateRetry.body')}
          </Text>
        </Reveal>
      </View>
    </SafeScreen>
    <RegistrationExitSheet exit={exit} />
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  glyphWrap: {
    width: 132,
    height: 132,
    borderRadius: 66,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    textAlign: 'center',
  },
  body: {
    textAlign: 'center',
    maxWidth: 300,
  },
});
