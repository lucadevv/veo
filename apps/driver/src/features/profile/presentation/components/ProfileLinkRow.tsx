import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';
import { IconChevronRight } from '../../../../shared/presentation/icons';
import { PressableScale } from './motion';

export interface ProfileLinkRowProps {
  /** Ícono guía a la izquierda (ya dimensionado por el consumidor). */
  icon: ReactNode;
  /** Etiqueta del enlace. */
  label: string;
  onPress: () => void;
  /** Dibuja un divisor inferior (para filas no finales dentro de una tarjeta). */
  showDivider?: boolean;
}

/**
 * Fila de enlace de navegación para la pantalla de Cuenta: ícono en círculo tintado + etiqueta +
 * chevron. Feedback de press por cambio de fondo (consistente con `ListItem` del ui-kit).
 */
export const ProfileLinkRow = ({
  icon,
  label,
  onPress,
  showDivider = false,
}: ProfileLinkRowProps): React.JSX.Element => {
  const theme = useTheme();

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.row, { borderRadius: theme.radii.md }]}
      pressedStyle={{ backgroundColor: theme.colors.accent + '0F' }}
    >
      <View
        style={[
          styles.iconCircle,
          { backgroundColor: theme.colors.surfaceMuted, borderRadius: theme.radii.pill },
        ]}
      >
        {icon}
      </View>
      <View
        style={[
          styles.body,
          showDivider
            ? {
                borderBottomColor: theme.colors.border,
                borderBottomWidth: StyleSheet.hairlineWidth,
              }
            : null,
        ]}
      >
        <Text variant="bodyStrong" numberOfLines={1}>
          {label}
        </Text>
        <IconChevronRight size={20} color={theme.colors.inkSubtle} />
      </View>
    </PressableScale>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 4 },
  iconCircle: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 56,
  },
});
