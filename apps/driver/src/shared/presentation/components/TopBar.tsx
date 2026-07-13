import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text, useTheme } from '@veo/ui-kit';
import { IconChevronLeft } from '../icons';

export interface TopBarProps {
  title: string;
  /** Acción de retroceso (renderiza el chevron de iOS). */
  onBack?: () => void;
  /** Slot derecho (acciones). */
  trailing?: ReactNode;
}

/**
 * Barra superior de pantalla: retroceso (chevron ‹ de iOS) + título CENTRADO + acciones. Unificada con
 * el resto de la app: el back es SIEMPRE el chevron de iOS (no un botón de texto "Atrás") y el título va
 * centrado (los slots laterales de ancho mínimo igual lo mantienen centrado aunque haya trailing).
 */
export const TopBar = ({ title, onBack, trailing }: TopBarProps): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <View style={styles.side}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
          >
            <IconChevronLeft size={28} color={theme.colors.ink} strokeWidth={2.25} />
          </Pressable>
        ) : null}
      </View>
      <Text variant="headline" numberOfLines={1} align="center" style={styles.title}>
        {title}
      </Text>
      <View style={[styles.side, styles.sideRight]}>{trailing}</View>
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 8,
    minHeight: 48,
  },
  // Slots laterales de ancho mínimo igual → el título queda centrado sin importar el back/trailing.
  side: { minWidth: 44, justifyContent: 'center' },
  sideRight: { alignItems: 'flex-end' },
  title: { flex: 1 },
});
