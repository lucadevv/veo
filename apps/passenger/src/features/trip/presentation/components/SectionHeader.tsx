import { Text } from '@veo/ui-kit';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

export interface SectionHeaderProps {
  title: string;
  actionLabel: string;
  onAction: () => void;
}

/** Encabezado de sección con enlace "ver todas". */
export function SectionHeader({ title, actionLabel, onAction }: SectionHeaderProps): React.JSX.Element {
  return (
    <View style={styles.sectionHeader}>
      <Text variant="subhead" color="inkMuted">
        {title}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={actionLabel} onPress={onAction} hitSlop={8}>
        <Text variant="subhead" color="accent">
          {actionLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
