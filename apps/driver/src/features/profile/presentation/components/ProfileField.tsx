import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';
import { IconLock } from '../../../../shared/presentation/icons';

export interface ProfileFieldProps {
  /** Etiqueta del campo (ej. "Teléfono"). */
  label: string;
  /** Valor actual del perfil. */
  value: string;
  /**
   * Campo bloqueado (KYC/legal): borde tenue + candado + valor atenuado. Espeja el frame
   * `C/Editar-Perfil`, donde "Nombre completo" es el único campo con candado (dato de verificación).
   */
  locked?: boolean;
  /** Valor atenuado sin candado (p. ej. un dato vacío/"No registrado"). */
  muted?: boolean;
}

/**
 * Campo del perfil del conductor en modo LECTURA (frame `C/Editar-Perfil`). No es un input: el
 * driver-bff no expone hoy mutación de teléfono/correo, así que la pantalla muestra los datos y la
 * capacidad de edición se señaliza a nivel del CTA. Los campos bloqueados (KYC) llevan candado.
 */
export const ProfileField = ({
  label,
  value,
  locked = false,
  muted = false,
}: ProfileFieldProps): React.JSX.Element => {
  const theme = useTheme();
  const dim = locked || muted;

  return (
    <View style={styles.field}>
      <Text variant="caption" color="inkMuted">
        {label}
      </Text>
      <View
        style={[
          styles.box,
          {
            backgroundColor: theme.colors.surface,
            borderColor: locked ? theme.colors.border : theme.colors.borderStrong,
            borderRadius: theme.radii.sm,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
          },
        ]}
      >
        <Text variant="body" color={dim ? 'inkSubtle' : 'ink'} numberOfLines={1} style={styles.value}>
          {value}
        </Text>
        {locked ? <IconLock size={16} color={theme.colors.inkSubtle} strokeWidth={2} /> : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  field: { alignSelf: 'stretch', gap: 8 },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    gap: 12,
  },
  value: { flexShrink: 1 },
});
