import { Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { IconLock } from '../components/icons';

/**
 * Pantalla de sesión expirada por INACTIVIDAD (fiel al diseño). Cierra la sesión y vuelve al flujo
 * de ingreso para re-verificar la identidad. La conmutación de stack la hace el `RootNavigator`
 * según el estado de sesión (no se navega imperativamente): al limpiar la sesión, `status` pasa a
 * `unauthenticated` y el navegador muestra Auth.
 *
 * Nota: esta pantalla solo cubre la UI + la ruta. El TRIGGER real de inactividad (temporizador que
 * conmuta a este estado) queda como follow-up.
 */
export function SessionExpiredScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const clearSession = useSessionStore((state) => state.clearSession);

  const reVerify = useCallback(() => {
    clearSession();
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
      }
    >
      <View style={[styles.center, { gap: theme.spacing.md }]}>
        <View
          style={[
            styles.badge,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.pill,
            },
          ]}
        >
          <IconLock color={theme.colors.inkMuted} size={34} />
        </View>
        <Text variant="display" align="center">
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  badge: {
    width: 84,
    height: 84,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginBottom: 6,
  },
});
