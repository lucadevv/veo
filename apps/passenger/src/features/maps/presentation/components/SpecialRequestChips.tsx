import type { SpecialRequest } from '@veo/api-client';
import { Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { IconChild, IconLuggage, type GlyphProps } from '../../../trip/presentation/components/icons';

/** Las 3 solicitudes especiales (BE-2). "Parada" no va acá: es un waypoint del trayecto. */
const REQUESTS: readonly SpecialRequest[] = ['PET', 'LUGGAGE', 'CHILD_SEAT'];

/** Glyph del set `I` por solicitud (mascota/silla reusan `child`, equipaje usa `work`). Cero emojis. */
const REQUEST_GLYPH: Record<SpecialRequest, (props: GlyphProps) => React.JSX.Element> = {
  PET: IconChild,
  LUGGAGE: IconLuggage,
  CHILD_SEAT: IconChild,
};

/**
 * PUJA · "Solicitudes para el conductor" (handoff `Offer`). Chips toggle: el pasajero marca mascota/
 * equipaje/silla y el conductor las VE antes de aceptar (viajan en createTrip → bid_posted → board).
 * Pill lima cuando está seleccionada (DESIGN §3: pill solo en tags). La UI refleja; sin gate.
 */
export function SpecialRequestChips({
  value,
  onChange,
}: {
  value: SpecialRequest[];
  onChange: (next: SpecialRequest[]) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  const toggle = (r: SpecialRequest): void =>
    onChange(value.includes(r) ? value.filter((x) => x !== r) : [...value, r]);

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Text variant="footnote" color="inkMuted">
        {t('puja.specialRequests')}
      </Text>
      <View style={[styles.row, { gap: theme.spacing.sm }]}>
        {REQUESTS.map((r) => {
          const on = value.includes(r);
          const Glyph = REQUEST_GLYPH[r];
          return (
            <Pressable
              key={r}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => toggle(r)}
              style={[
                styles.chip,
                {
                  gap: theme.spacing.xs,
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: theme.spacing.sm,
                  borderColor: on ? theme.colors.accent : theme.colors.border,
                  backgroundColor: on ? theme.colors.surfaceElevated : 'transparent',
                },
              ]}
            >
              <Glyph color={on ? theme.colors.accent : theme.colors.inkMuted} size={16} />
              <Text variant="footnote" color={on ? 'accent' : 'ink'}>
                {t(`puja.request.${r}`)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 999 },
});
