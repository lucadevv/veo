import {hexAlpha, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {Pressable, StyleSheet} from 'react-native';
import {type GlyphProps} from './icons';

export interface ShortcutChipProps {
  label: string;
  Icon: (props: GlyphProps) => React.JSX.Element;
  present: boolean;
  onPress: () => void;
}

/** Pill de 1 toque (Casa/Trabajo). Si el lugar falta, muestra el "+" e invita a agregarlo. */
export function ShortcutChip({
  label,
  Icon,
  present,
  onPress,
}: ShortcutChipProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.chip,
        {
          // Piel del pen (P/Home · ShortcutChips): surface al 60% + borde del vidrio al 40%.
          backgroundColor: hexAlpha(theme.colors.surface, 0.6),
          borderColor: '#4C546866',
          borderRadius: theme.radii.pill,
        },
      ]}>
      {/* SIEMPRE el glifo del lugar (pen: house/briefcase) — el "+" pelado escondía QUÉ atajo era.
          Presente → accent (1 toque pide el viaje); ausente → apagado (el tap invita a agregarlo). */}
      <Icon
        color={present ? theme.colors.accent : theme.colors.inkSubtle}
        size={18}
      />
      <Text
        variant="subhead"
        color={present ? 'ink' : 'inkMuted'}
        numberOfLines={1}>
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
