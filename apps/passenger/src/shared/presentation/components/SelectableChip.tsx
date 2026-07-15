import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {Pressable, StyleSheet} from 'react-native';

export interface SelectableChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** Dígitos tabulares (chips de hora, "08:30"): las columnas no bailan entre chips. */
  tabular?: boolean;
}

/**
 * Chip seleccionable canónico (día/hora del ScheduleSheet, fecha del buscador de carpool): estado
 * por BORDE (accent 2px + fondo elevado cuando está activo), no solo por color. Un solo componente
 * para todos los pickers de chips — antes vivía duplicado en ScheduleSheet y CarpoolSearchScreen
 * (contrato divergente cazado por mjolnir).
 */
export function SelectableChip({
  label,
  selected,
  onPress,
  tabular,
}: SelectableChipProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{selected}}
      accessibilityLabel={label}
      onPress={onPress}
      style={({pressed}) => [
        styles.chip,
        {
          borderRadius: theme.radii.pill,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.sm,
          borderWidth: selected ? 2 : 1,
          borderColor: selected ? theme.colors.accent : theme.colors.border,
          backgroundColor: selected
            ? theme.colors.surfaceElevated
            : theme.colors.surface,
          opacity: pressed ? 0.7 : 1,
        },
      ]}>
      <Text
        variant="subhead"
        color={selected ? 'ink' : 'inkMuted'}
        tabular={tabular}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {alignItems: 'center', justifyContent: 'center'},
});
