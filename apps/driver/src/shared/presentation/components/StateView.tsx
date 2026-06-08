import React from 'react';
import {StyleSheet, View} from 'react-native';
import {Button, Text} from '@veo/ui-kit';

export interface StateViewProps {
  /** Título principal del estado (error/vacío). */
  title: string;
  /** Descripción de apoyo. */
  description?: string;
  /** Acción de recuperación (p. ej. reintentar). */
  action?: {label: string; onPress: () => void};
}

/**
 * Estado a pantalla completa para vistas con datos remotos: error o vacío.
 * Centrado, accesible y construido solo con el sistema de diseño (sin estilos hardcodeados de color).
 */
export const StateView = ({title, description, action}: StateViewProps): React.JSX.Element => (
  <View style={styles.container}>
    <Text variant="title3" align="center">
      {title}
    </Text>
    {description ? (
      <Text variant="callout" color="inkMuted" align="center" style={styles.description}>
        {description}
      </Text>
    ) : null}
    {action ? (
      <View style={styles.action}>
        <Button label={action.label} variant="secondary" onPress={action.onPress} />
      </View>
    ) : null}
  </View>
);

const styles = StyleSheet.create({
  container: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8},
  description: {maxWidth: 320},
  action: {marginTop: 16},
});
