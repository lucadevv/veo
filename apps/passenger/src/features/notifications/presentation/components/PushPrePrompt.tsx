import {BottomSheet, Button, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {View} from 'react-native';
import {IconBell} from '../../../profile/presentation/components/icons';

export interface PushPrePromptProps {
  visible: boolean;
  /** Cerrar sin activar ("Ahora no"). NO insiste: el permiso queda en el toggle del Perfil. */
  onDismiss: () => void;
  /** Activar → dispara el diálogo del SO y registra el token. */
  onEnable: () => void;
}

/**
 * Pre-prompt CONTEXTUAL de notificaciones (patrón Uber/Cabify). Se muestra cuando el push IMPORTA de
 * verdad —acabás de pedir el viaje y estás esperando conductor—, NO al entrar a la app. Explica el VALOR
 * ANTES de disparar el diálogo del SO (que es de un solo tiro en iOS): así el usuario llega predispuesto
 * a aceptar, en vez de un prompt frío que rechaza de reflejo. "Ahora no" no insiste.
 */
export function PushPrePrompt({
  visible,
  onDismiss,
  onEnable,
}: PushPrePromptProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  return (
    <BottomSheet
      visible={visible}
      onClose={onDismiss}
      title={t('notifications.prePromptTitle')}>
      <View
        style={{
          alignItems: 'center',
          gap: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
        }}>
        <IconBell color={theme.colors.accent} size={40} />
        <Text variant="body" color="inkMuted" align="center">
          {t('notifications.prePromptBody')}
        </Text>
        <View
          style={{
            width: '100%',
            gap: theme.spacing.sm,
            marginTop: theme.spacing.sm,
          }}>
          <Button
            label={t('notifications.prePromptEnable')}
            fullWidth
            size="lg"
            onPress={onEnable}
          />
          <Button
            label={t('notifications.prePromptDismiss')}
            variant="ghost"
            fullWidth
            onPress={onDismiss}
          />
        </View>
      </View>
    </BottomSheet>
  );
}
