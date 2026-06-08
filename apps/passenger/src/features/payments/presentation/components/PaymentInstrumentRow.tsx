import type { MobilePaymentMethod } from '@veo/api-client';
import { StatusPill, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { PaymentMethodLogo } from '../../../../shared/assets/payment-methods';

export interface PaymentInstrumentRowProps {
  method: MobilePaymentMethod;
  /** Nombre del instrumento (Yape, Plin…). */
  name: string;
  /** UNA línea de experiencia (cómo se paga). */
  line: string;
  /** Es el método predeterminado del perfil → pill `defaultLabel`. */
  isDefault?: boolean;
  /** Texto de la pill de "predeterminado" (es-PE, lo provee el caller). */
  defaultLabel?: string;
  /** Tap en la fila (setear default o abrir gestión). */
  onPress?: () => void;
  /** Acción a la derecha (CTA "Vincular") en lugar de la pill. */
  action?: React.ReactNode;
  /** Slot a la derecha (estado: check, spinner, etc.) cuando no hay action ni default-pill. */
  trailing?: React.ReactNode;
  /** Resalta el leadcircle/borde (instrumento principal vinculado). */
  emphasized?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

/**
 * Fila de INSTRUMENTO de pago (patrón PedidosYa / instrumentos). Glifo + nombre + UNA línea de
 * experiencia + estado/acción a la derecha. Es la unidad de la lista única de "Métodos de pago": una
 * sola experiencia, sin secciones separadas. Tap = setear default (o abrir gestión, según el caller).
 * Target ≥56pt, feedback de press por opacidad (filas frecuentes → sin scale, criterio emil).
 */
export function PaymentInstrumentRow({
  method,
  name,
  line,
  isDefault = false,
  defaultLabel,
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
            ? { borderColor: theme.colors.accent, borderWidth: 2 }
            : { borderColor: 'transparent', borderWidth: 2 },
        ]}
      >
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

      <View style={[styles.trailing, { gap: theme.spacing.xs }]}>
        {isDefault && defaultLabel ? <StatusPill label={defaultLabel} tone="accent" dot /> : null}
        {action ?? trailing ?? null}
      </View>
    </>
  );

  const containerStyle = {
    minHeight: 56,
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radii.md,
    borderWidth: emphasized ? 2 : 1,
    borderColor: emphasized ? theme.colors.accent : theme.colors.border,
    backgroundColor: emphasized ? theme.colors.surfaceElevated : theme.colors.surface,
  } as const;

  if (!onPress) {
    return (
      <View
        accessible
        accessibilityLabel={accessibilityLabel ?? `${name}. ${line}`}
        style={[styles.row, containerStyle]}
      >
        {content}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `${name}. ${line}`}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: isDefault }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, containerStyle, { opacity: pressed ? 0.7 : 1 }]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  // Anillo de 2px alrededor del logo circular (transparente salvo cuando el instrumento se enfatiza),
  // con `borderRadius` generoso para acompañar el círculo de 36px del logo.
  leadRing: { borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
  trailing: { flexDirection: 'row', alignItems: 'center' },
});
