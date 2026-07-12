import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Text, useTheme } from '@veo/ui-kit';

export interface StateViewProps {
  /** Título principal del estado (error/vacío). */
  title: string;
  /** Descripción de apoyo. */
  description?: string;
  /** Acción de recuperación (p. ej. reintentar). */
  action?: { label: string; onPress: () => void };
  /**
   * Ícono OPCIONAL renderizado en un disco tintado sobre el título. Al ser opcional, los usos
   * existentes (sin ícono) quedan intactos: si no se pasa, no se dibuja disco alguno.
   */
  icon?: React.ReactNode;
  /** Color de fondo del disco del ícono. Default: tinte sobrio de peligro (`danger + '14'`). */
  iconTint?: string;
}

/**
 * Estado a pantalla completa para vistas con datos remotos: error o vacío.
 * Centrado, accesible y construido solo con el sistema de diseño (sin estilos hardcodeados de color).
 */
export const StateView = ({
  title,
  description,
  action,
  icon,
  iconTint,
}: StateViewProps): React.JSX.Element => {
  const theme = useTheme();
  return (
    <View style={styles.container}>
      {icon ? (
        <View
          style={[
            styles.iconDisc,
            { backgroundColor: iconTint ?? theme.colors.danger + '14' },
          ]}
        >
          {icon}
        </View>
      ) : null}
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
};

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  iconDisc: {
    width: 80,
    height: 80,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  description: { maxWidth: 320 },
  action: { marginTop: 16 },
});
