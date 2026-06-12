import { Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { IconPlus, type GlyphProps } from './icons';

export interface ShortcutChipProps {
  label: string;
  Icon: (props: GlyphProps) => React.JSX.Element;
  present: boolean;
  onPress: () => void;
}

/** Pill de 1 toque (Casa/Trabajo). Si el lugar falta, muestra el "+" e invita a agregarlo. */
export function ShortcutChip({ label, Icon, present, onPress }: ShortcutChipProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.chip,
        { backgroundColor: theme.colors.bg, borderColor: theme.colors.border, borderRadius: theme.radii.pill },
      ]}
    >
      {present ? (
        <Icon color={theme.colors.accent} size={18} />
      ) : (
        <IconPlus color={theme.colors.inkMuted} size={18} />
      )}
      <Text variant="subhead" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderWidth: 1,
  },
});
