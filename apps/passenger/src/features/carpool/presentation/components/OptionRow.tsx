import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {Pressable, StyleSheet} from 'react-native';
import {IconCheck} from '../../../trip/presentation/components/icons';

export interface OptionRowProps {
  label: string;
  selected: boolean;
  onPress: () => void;
}

/**
 * Fila de opción de los sheets del marketplace (filtros de resultados, selector de región del
 * feed): label + check accent cuando está elegida (target 44pt). Un solo componente para todos
 * los sheets de opciones del carpool — cero copy-paste.
 */
export function OptionRow({
  label,
  selected,
  onPress,
}: OptionRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{selected}}
      onPress={onPress}
      style={({pressed}) => [
        styles.optionRow,
        {
          borderRadius: theme.radii.md,
          backgroundColor: selected ? theme.colors.brandDim : 'transparent',
          opacity: pressed ? 0.7 : 1,
        },
      ]}>
      <Text
        variant="body"
        style={selected ? {color: theme.colors.brand, fontWeight: '600'} : null}>
        {label}
      </Text>
      {selected ? <IconCheck color={theme.colors.brand} size={18} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  optionRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
