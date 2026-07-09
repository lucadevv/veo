import React from 'react';
import { StyleSheet, View } from 'react-native';
import { StatusPill, Text, useTheme, type StatusTone } from '@veo/ui-kit';
import { IconDocument } from '../../../../shared/presentation/icons';
import { PressableScale } from './motion';

export interface DocumentRowProps {
  /** Nombre legible del tipo de documento (ya traducido). */
  typeLabel: string;
  /** Etiqueta de estado (traducida) y su tono semántico — el mapeo vive en el dominio. */
  statusLabel: string;
  statusTone: StatusTone;
  /** Resalta la card (borde tintado) cuando el documento requiere atención. */
  highlighted?: boolean;
  /** Color del borde de resalte (tono del estado). */
  highlightColor?: string;
  /** Abre el formulario para registrar/actualizar este documento. */
  onPress: () => void;
}

/**
 * Card de documento, fiel al frame C/Documentos: ícono en círculo + nombre legible del tipo + `StatusPill`.
 * El frame es MINIMALISTA — no muestra número ni vencimiento en la lista (eso vive en el detalle/registro
 * al tocar). Un documento que requiere atención resalta con borde tintado. Presionable → registrar/actualizar.
 */
export function DocumentRow({
  typeLabel,
  statusLabel,
  statusTone,
  highlighted = false,
  highlightColor,
  onPress,
}: DocumentRowProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${typeLabel}, ${statusLabel}`}
      onPress={onPress}
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: highlighted && highlightColor ? highlightColor : theme.colors.border,
          borderWidth: highlighted ? 1.5 : StyleSheet.hairlineWidth,
          borderRadius: theme.radii.lg,
          padding: 14,
        },
      ]}
      pressedStyle={{ backgroundColor: theme.colors.surfaceElevated }}
    >
      <View style={styles.rowInner}>
        <View style={[styles.icon, { backgroundColor: theme.colors.surfaceElevated }]}>
          <IconDocument
            size={18}
            color={highlighted && highlightColor ? highlightColor : theme.colors.inkMuted}
            strokeWidth={2}
          />
        </View>
        <Text variant="bodyStrong" style={styles.name} numberOfLines={1}>
          {typeLabel}
        </Text>
        <StatusPill label={statusLabel} tone={statusTone} dot />
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch' },
  rowInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 36, height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  name: { flex: 1 },
});
