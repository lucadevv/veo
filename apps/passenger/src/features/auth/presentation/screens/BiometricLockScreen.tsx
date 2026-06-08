import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { useBiometricGateStore } from '../stores/biometricGateStore';

/**
 * Candado de RE-LOGIN biométrico. Se muestra cuando hay una sesión persistida (arranque en frío) y el
 * candado está bloqueado. Pide Face ID / huella (puerto `LocalAuthService` sobre Keychain/Keystore)
 * para desbloquear el uso del refresh token. Si el dispositivo no tiene biometría, desbloquea solo.
 */
export function BiometricLockScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const localAuth = useDependency(TOKENS.localAuthService);
  const panicSecretStore = useDependency(TOKENS.panicSecretStore);
  const unlock = useBiometricGateStore((state) => state.unlock);
  const clearSession = useSessionStore((state) => state.clearSession);

  // Olvida la sesión persistida y borra el secreto HMAC de pánico (se re-aprovisiona al re-loguear).
  const forgetSession = useCallback(() => {
    void panicSecretStore.clearSecret().catch(() => undefined);
    clearSession();
  }, [panicSecretStore, clearSession]);

  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);
  // Evita lanzar dos prompts simultáneos (StrictMode / re-render).
  const promptingRef = useRef(false);

  const attempt = useCallback(async () => {
    if (promptingRef.current) {
      return;
    }
    promptingRef.current = true;
    setFailed(false);
    setChecking(true);
    try {
      const available = await localAuth.isAvailable();
      // Sin biometría disponible: no bloqueamos la app (degradación segura).
      if (!available) {
        unlock();
        return;
      }
      const ok = await localAuth.authenticate(t('auth.biometricReason'));
      if (ok) {
        unlock();
      } else {
        setFailed(true);
      }
    } finally {
      promptingRef.current = false;
      setChecking(false);
    }
  }, [localAuth, t, unlock]);

  // Lanza el prompt automáticamente al montar.
  useEffect(() => {
    void attempt();
  }, [attempt]);

  return (
    <SafeScreen
      footer={
        <View style={{ gap: theme.spacing.sm }}>
          <Button
            label={checking ? t('states.loading') : t('auth.biometricUnlock')}
            fullWidth
            size="lg"
            loading={checking}
            disabled={checking}
            onPress={() => void attempt()}
          />
          <Button
            label={t('auth.biometricLogout')}
            variant="ghost"
            fullWidth
            onPress={forgetSession}
          />
        </View>
      }
    >
      <View style={[styles.center, { gap: theme.spacing.lg }]}>
        <Text variant="display" color="brand" align="center">
          {t('auth.biometricTitle')}
        </Text>
        <Text variant="body" color="inkMuted" align="center">
          {t('auth.biometricSubtitle')}
        </Text>
        {checking ? <ActivityIndicator color={theme.colors.accent} /> : null}
        {failed ? <Banner tone="danger" title={t('auth.biometricError')} /> : null}
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center' },
});
