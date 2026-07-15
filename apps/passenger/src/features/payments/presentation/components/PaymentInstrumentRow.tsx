import type {MobilePaymentMethod} from '@veo/api-client';
import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {Pressable, StyleSheet, View} from 'react-native';
import {PaymentMethodLogo} from '../../../../shared/assets/payment-methods';
import {IconCheck} from '../../../trip/presentation/components/icons';

export interface PaymentInstrumentRowProps {
  method: MobilePaymentMethod;
  /** Nombre del instrumento (Yape, Plin…). */
  name: string;
  /** UNA línea de experiencia (cómo se paga). */
  line: string;
  /** Es el método predeterminado del perfil → card seleccionada (borde brand + check circular). */
  isDefault?: boolean;
  /**
   * Dibuja el radio vacío a la derecha cuando NO es el predeterminado (metáfora de selección del
   * pen Ofbr6). `false` para filas que no participan de la selección (p. ej. estados transitorios).
   */
  selectable?: boolean;
  /** Tap en la fila (setear default o abrir gestión). */
  onPress?: () => void;
  /** Acción a la derecha (CTA "Vincular"), antes del indicador de selección. */
  action?: React.ReactNode;
  /** Slot extra a la derecha (estado: pill, spinner, etc.), antes del indicador de selección. */
  trailing?: React.ReactNode;
  /** Resalta el anillo del logo (instrumento principal vinculado). Ya NO toca el borde de la card:
   *  el borde brand quedó reservado para la SELECCIÓN (per pen), y mezclarlos mentiría. */
  emphasized?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

/**
 * CARD de instrumento de pago (design/veo.pen Ofbr6): cada método es una card separada con glifo +
 * nombre + UNA línea de experiencia. La metáfora de selección es la del pen: el método PREDETERMINADO
 * lleva borde brand de 2px + check circular brand a la derecha; los demás, borde normal + radio vacío
 * (reemplaza a la pill "Predeterminado"). Tap = setear default (o abrir gestión, según el caller).
 * Target ≥56pt, feedback de press por opacidad (filas frecuentes → sin scale, criterio emil).
 */
export function PaymentInstrumentRow({
  method,
  name,
  line,
  isDefault = false,
  selectable = true,
  onPress,
  action,
  trailing,
  emphasized = false,
  accessibilityLabel,
  accessibilityHint,
}: PaymentInstrumentRowProps): React.JSX.Element {
  const theme = useTheme();

  const content = (
    <>
      {/* Logo circular consistente (el propio componente dibuja el círculo). Si el instrumento está
          enfatizado, un anillo de acento lo rodea sin tapar el recorte limpio del logo. */}
      <View
        style={[
          styles.leadRing,
          emphasized
            ? {borderColor: theme.colors.accent, borderWidth: 2}
            : {borderColor: 'transparent', borderWidth: 2},
        ]}>
        <PaymentMethodLogo method={method} size={36} />
      </View>

      <View style={styles.body}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="footnote" color="inkMuted" numberOfLines={1}>
          {line}
        </Text>
      </View>

      <View style={[styles.trailing, {gap: theme.spacing.xs}]}>
        {action ?? trailing ?? null}
        {/* Indicador de selección per pen: check circular brand (predeterminado) o radio vacío. */}
        {isDefault ? (
          <View
            style={[styles.check, {backgroundColor: theme.colors.accent}]}
            accessibilityElementsHidden>
            <IconCheck color={theme.colors.onAccent} size={14} />
          </View>
        ) : selectable ? (
          <View
            style={[styles.radio, {borderColor: theme.colors.borderStrong}]}
            accessibilityElementsHidden
          />
        ) : null}
      </View>
    </>
  );

  // Card por método (pen): seleccionada = borde brand 2px; el resto, borde normal de 1px.
  const containerStyle = {
    minHeight: 56,
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radii.lg,
    borderWidth: isDefault ? 2 : 1,
    borderColor: isDefault ? theme.colors.accent : theme.colors.border,
    backgroundColor: emphasized
      ? theme.colors.surfaceElevated
      : theme.colors.surface,
  } as const;

  if (!onPress) {
    return (
      <View
        accessible
        accessibilityLabel={accessibilityLabel ?? `${name}. ${line}`}
        accessibilityState={{selected: isDefault}}
        style={[styles.row, containerStyle]}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `${name}. ${line}`}
      accessibilityHint={accessibilityHint}
      accessibilityState={{selected: isDefault}}
      onPress={onPress}
      style={({pressed}) => [
        styles.row,
        containerStyle,
        {opacity: pressed ? 0.7 : 1},
      ]}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center'},
  // Anillo de 2px alrededor del logo circular (transparente salvo cuando el instrumento se enfatiza),
  // con `borderRadius` generoso para acompañar el círculo de 36px del logo.
  leadRing: {borderRadius: 22, alignItems: 'center', justifyContent: 'center'},
  body: {flex: 1, gap: 2},
  trailing: {flexDirection: 'row', alignItems: 'center'},
  // Check circular de 24 (pen: fondo brand, check onAccent) del método predeterminado.
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Radio vacío de 22 (pen: anillo borderStrong de 2px) de los métodos no elegidos.
  radio: {width: 22, height: 22, borderRadius: 11, borderWidth: 2},
});
