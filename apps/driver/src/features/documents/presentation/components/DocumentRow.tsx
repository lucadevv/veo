import React from 'react';
import {StyleSheet, View} from 'react-native';
import {StatusPill, Text, useTheme, type StatusTone} from '@veo/ui-kit';
import {IconDocument} from '../../../../shared/presentation/icons';
import {PressableScale} from './motion';

export interface DocumentRowProps {
  /** Nombre legible del tipo de documento (ya traducido). */
  typeLabel: string;
  /** Número del documento; vacío si aún no se registró. */
  documentNumber: string;
  /** Vencimiento ya formateado (o etiqueta "sin vencimiento"). */
  expiryLabel: string;
  /** Etiqueta de estado (traducida) y su tono semántico — el mapeo vive en el dominio. */
  statusLabel: string;
  statusTone: StatusTone;
  /** Resalta la fila (borde tintado) cuando el documento requiere atención. */
  highlighted?: boolean;
  /** Color del borde de resalte (tono del estado). */
  highlightColor?: string;
  /** Abre el formulario para registrar/actualizar este documento. */
  onPress: () => void;
  /** Oculta el divisor superior en la primera fila. */
  showDivider?: boolean;
}

/**
 * Fila de documento (lenguaje Midnight Motion): ícono en superficie, tipo + número/vencimiento y
 * `StatusPill` a la derecha. Presionable para registrar/actualizar, con feedback de press por
 * cambio de fondo (consistente con `ListItem`). No contiene lógica: recibe ya formateado y
 * clasificado lo que la pantalla deriva de los datos reales.
 */
export function DocumentRow({
  typeLabel,
  documentNumber,
  expiryLabel,
  statusLabel,
  statusTone,
  highlighted = false,
  highlightColor,
  onPress,
  showDivider = true,
}: DocumentRowProps): React.JSX.Element {
  const theme = useTheme();
  const subtitle = documentNumber ? `${documentNumber} · ${expiryLabel}` : expiryLabel;

  return (
    <View>
      {showDivider ? (
        <View style={[styles.divider, {backgroundColor: theme.colors.border}]} />
      ) : null}
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${typeLabel}, ${statusLabel}`}
        onPress={onPress}
        style={[
          styles.row,
          {paddingVertical: theme.spacing.md, gap: theme.spacing.lg, borderRadius: theme.radii.md},
        ]}
        pressedStyle={{backgroundColor: theme.colors.surfaceElevated}}>
        <View
          style={[
            styles.icon,
            {
              backgroundColor: theme.colors.bg,
              borderRadius: theme.radii.md,
              borderColor: highlighted && highlightColor ? highlightColor : theme.colors.border,
              borderWidth: highlighted ? 1.5 : StyleSheet.hairlineWidth,
            },
          ]}>
          <IconDocument
            size={20}
            color={highlighted && highlightColor ? highlightColor : theme.colors.accent}
            strokeWidth={2}
          />
        </View>
        <View style={styles.body}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {typeLabel}
          </Text>
          <Text variant="footnote" color="inkMuted" numberOfLines={1} tabular>
            {subtitle}
          </Text>
        </View>
        <StatusPill label={statusLabel} tone={statusTone} dot />
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  divider: {height: StyleSheet.hairlineWidth, alignSelf: 'stretch'},
  row: {flexDirection: 'row', alignItems: 'center'},
  icon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {flex: 1, gap: 2},
});
