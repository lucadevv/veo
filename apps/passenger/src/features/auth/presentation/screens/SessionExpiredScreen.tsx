import {Button, SafeScreen, Text, useTheme} from '@veo/ui-kit';
import React, {useCallback} from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {useSessionStore} from '../../../../core/session/sessionStore';
import {IconLock} from '../components/icons';

/**
 * Pantalla de sesión EXPIRADA (refresh JWT fallido / token vencido). El `RootNavigator` la muestra
 * cuando `status === 'expired'`, estado al que se llega desde `clearSession('expired')` en el flujo
 * de refresh (`core/network/http.ts`). No se navega imperativamente: la conmutación de stack es por
 * estado.
 *
 * El CTA "Volver a iniciar sesión" cierra con motivo 'user-logout' (default de `clearSession`), que
 * lleva `status` a 'unauthenticated' → el navegador muestra Auth para re-verificar la identidad.
 */
export function SessionExpiredScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const clearSession = useSessionStore(state => state.clearSession);

  // Re-login intencional desde la pantalla de expiración: motivo 'user-logout' → 'unauthenticated'
  // → Auth (no reentra al estado 'expired').
  const reVerify = useCallback(() => {
    clearSession('user-logout');
  }, [clearSession]);

  return (
    <SafeScreen
      footer={
        <Button
          label={t('auth.expiredAction')}
          variant="accent"
          fullWidth
          size="lg"
          onPress={reVerify}
        />
      }>
      <View style={[styles.center, {gap: theme.spacing.md}]}>
        <View
          style={[
            styles.badge,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.pill,
            },
          ]}>
          <IconLock color={theme.colors.inkMuted} size={40} />
        </View>
        <Text variant="title1" align="center">
          {t('auth.expiredTitle')}
        </Text>
        <Text variant="body" color="inkMuted" align="center">
          {t('auth.expiredSubtitle')}
        </Text>
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  center: {flex: 1, justifyContent: 'center', alignItems: 'center'},
  badge: {
    width: 96,
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginBottom: 6,
  },
});
