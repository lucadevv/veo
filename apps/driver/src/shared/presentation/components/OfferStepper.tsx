import React from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';
import { formatPEN } from '../format';
import { IconMinus, IconPlus } from '../icons';

export interface OfferStepperProps {
  /** Kicker sobre el stepper (ej. "TU OFERTA"). */
  label: string;
  /** Monto actual en céntimos PEN. Siempre se mantiene dentro de [minCents, maxCents]. */
  valueCents: number;
  onChange: (cents: number) => void;
  minCents: number;
  maxCents: number;
  /** Paso del −/+ en céntimos. Default S/ 1. */
  stepCents?: number;
  /** Montos rápidos (céntimos) como chips bajo el stepper; el igual al valor se pinta activo. */
  chips?: readonly number[];
}

/**
 * Stepper de MONTO de oferta (frame C/Puja · bloques `StepWrap`+`Chips` del board): −/+ circulares
 * de 52 con el monto display al centro y chips de salto rápido debajo. El − es neutro (blanco/borde)
 * y el + lleva el tint de marca — la dirección "ofertar más" es la acción con energía. Clampa en los
 * extremos deshabilitando el borde alcanzado; la validez del monto la garantiza el rango, no un error.
 */
export function OfferStepper({
  label,
  valueCents,
  onChange,
  minCents,
  maxCents,
  stepCents = 100,
  chips,
}: OfferStepperProps): React.JSX.Element {
  const theme = useTheme();
  const atMin = valueCents <= minCents;
  const atMax = valueCents >= maxCents;

  const roundBtn = (disabled: boolean): ViewStyle => ({
    opacity: disabled ? 0.4 : 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  });

  return (
    <View style={styles.wrap}>
      <Text variant="label" color="inkSubtle">
        {label}
      </Text>
      <View style={styles.stepRow}>
        <Pressable
          onPress={() => onChange(Math.max(minCents, valueCents - stepCents))}
          disabled={atMin}
          style={[styles.roundBtn, roundBtn(atMin)]}
          accessibilityRole="button"
          accessibilityLabel="Bajar la oferta"
        >
          <IconMinus size={22} color={theme.colors.ink} />
        </Pressable>
        <Text variant="display" tabular style={styles.value}>
          {formatPEN(valueCents)}
        </Text>
        <Pressable
          onPress={() => onChange(Math.min(maxCents, valueCents + stepCents))}
          disabled={atMax}
          style={[
            styles.roundBtn,
            {
              opacity: atMax ? 0.4 : 1,
              borderColor: theme.colors.brand,
              backgroundColor: theme.colors.brandDim,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Subir la oferta"
        >
          <IconPlus size={22} color={theme.colors.brand} />
        </Pressable>
      </View>
      {chips && chips.length > 0 ? (
        <View style={styles.chipRow}>
          {chips.map((cents) => {
            const active = cents === valueCents;
            return (
              <Pressable
                key={cents}
                onPress={() => onChange(cents)}
                accessibilityRole="button"
                accessibilityLabel={formatPEN(cents)}
                style={[
                  styles.chip,
                  active
                    ? { backgroundColor: theme.colors.brandDim, borderColor: theme.colors.brand }
                    : { backgroundColor: theme.colors.bg, borderColor: theme.colors.border },
                ]}
              >
                <Text variant="subhead" color={active ? 'brand' : 'inkMuted'} tabular>
                  {formatPEN(cents)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 8 },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
  },
  roundBtn: {
    width: 52,
    height: 52,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: { fontSize: 38, lineHeight: 44 },
  chipRow: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  chip: { borderRadius: 999, borderWidth: 1, paddingVertical: 8, paddingHorizontal: 16 },
});
