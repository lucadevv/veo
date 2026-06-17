import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button, Text } from '@veo/ui-kit';

export interface TopBarProps {
  title: string;
  /** Acción de retroceso (renderiza un botón fantasma "Atrás"). */
  onBack?: () => void;
  /** Slot derecho (acciones). */
  trailing?: ReactNode;
}

/**
 * Barra superior simple de pantalla: título + retroceso opcional + acciones.
 * Sin íconos de mapa de bits ni emojis (regla del sistema de diseño): el retroceso usa texto.
 */
export const TopBar = ({ title, onBack, trailing }: TopBarProps): React.JSX.Element => {
  const { t } = useTranslation();
  return (
    <View style={styles.row}>
      <View style={styles.left}>
        {onBack ? (
          <Button label={t('common.back')} variant="ghost" size="sm" onPress={onBack} />
        ) : null}
        <Text variant="title2" numberOfLines={1}>
          {title}
        </Text>
      </View>
      {trailing ? <View>{trailing}</View> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    gap: 12,
  },
  left: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
});
