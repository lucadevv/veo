import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
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
  /** Acción trailing (ej. "Cambiar"): la caja se vuelve presionable y muestra el label en brand. */
  actionLabel?: string;
  /** Handler de la acción; requiere `actionLabel` para tener affordance visible. */
  onPress?: () => void;
}

/**
 * Campo del perfil del conductor (frame `C/Editar-Perfil`). En su forma base es LECTURA; con
 * `actionLabel` + `onPress` la caja se vuelve una fila ACCIONABLE (valor actual + acción trailing en
 * brand), como el Teléfono, cuyo cambio vive en su propio sheet (`PhoneChangeSheet`). Los campos
 * bloqueados (KYC) llevan candado.
 */
export const ProfileField = ({
  label,
  value,
  locked = false,
  muted = false,
  actionLabel,
  onPress,
}: ProfileFieldProps): React.JSX.Element => {
  const theme = useTheme();
  const dim = locked || muted;
  const pressable = Boolean(actionLabel && onPress);

  const box = (
    <View
      style={[
        styles.box,
        {
          backgroundColor: locked ? theme.colors.bg : theme.colors.surface,
          borderColor: theme.colors.border,
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
      {pressable ? (
        <Text variant="subhead" color="brand">
          {actionLabel}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={styles.field}>
      <Text variant="caption" color="inkMuted">
        {label}
      </Text>
      {pressable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${actionLabel ?? ''}`}
          onPress={onPress}
          style={({ pressed }) => (pressed ? styles.pressed : undefined)}
        >
          {box}
        </Pressable>
      ) : (
        box
      )}
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
  pressed: { opacity: 0.7 },
});
