import { useTheme } from '@veo/ui-kit';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { IconUsers } from '../../../trip/presentation/components/icons';

/**
 * Lead-circle del set (handoff `Trusted`: `.leadcircle` 46×46, radio 13, fondo surface2, borde, con
 * `I.users()` en acento). Cada fila de contacto la lleva a la izquierda. Decorativa: el `ListItem`
 * aporta el texto accesible.
 */
export function ContactLeadCircle(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.circle,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
        },
      ]}
    >
      <IconUsers color={theme.colors.accent} size={20} />
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
});
