import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { BottomSheet, Button, Text } from '@veo/ui-kit';
import type { RegistrationExit } from '../hooks/useRegistrationExit';

interface RegistrationExitSheetProps {
  /** Estado + acciones de salida producidos por `useRegistrationExit`. */
  exit: RegistrationExit;
}

/**
 * Diálogo de confirmación de la salida del onboarding (LOTE 1). Reusa el patrón `BottomSheet` de
 * `@veo/ui-kit` que ya emplea `ProfileScreen` para confirmar el logout (coherencia visual). Es el
 * ÚNICO render del confirm de salida: las 4 pantallas pre-aprobación lo montan con el mismo
 * `useRegistrationExit`, evitando duplicar markup y textos. Al confirmar, dispara el logout/clearSession
 * reusado.
 */
export function RegistrationExitSheet({ exit }: RegistrationExitSheetProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <BottomSheet
      visible={exit.confirmVisible}
      onClose={exit.dismissExit}
      title={t('registration.exitConfirmTitle')}
      footer={
        <View style={styles.footer}>
          <Button label={t('common.cancel')} variant="secondary" onPress={exit.dismissExit} />
          <Button
            label={t('registration.exit')}
            variant="danger"
            loading={exit.isLoggingOut}
            onPress={exit.confirmExit}
          />
        </View>
      }
    >
      <Text variant="callout" color="inkMuted">
        {t('registration.exitConfirmBody')}
      </Text>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
});
