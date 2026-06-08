import { Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { IconCheck } from '../../../auth/presentation/components/icons';

/** Claves de motivo (i18n en `ratings.reason.*`). Estables: viajan dentro del comentario al backend. */
export type RatingReason =
  | 'ROUGH_DRIVING'
  | 'LATE'
  | 'DIRTY_VEHICLE'
  | 'TREATMENT'
  | 'BAD_ROUTE'
  | 'OVERCHARGED'
  | 'GREAT_TREATMENT'
  | 'PUNCTUAL'
  | 'SAFE_DRIVING';

/** Motivos "a mejorar" (1–4 estrellas). Espejo de `reasons` del handoff `Rating`. */
const IMPROVE_REASONS: readonly RatingReason[] = [
  'ROUGH_DRIVING',
  'LATE',
  'DIRTY_VEHICLE',
  'TREATMENT',
  'BAD_ROUTE',
  'OVERCHARGED',
];

/** Elogios (5 estrellas). Espejo del bloque `r===5` del handoff `Rating`. */
const PRAISE_REASONS: readonly RatingReason[] = ['GREAT_TREATMENT', 'PUNCTUAL', 'SAFE_DRIVING'];

/**
 * Chips de motivo condicionados a las estrellas (handoff `Rating`): si la nota es baja (1–4) ofrece
 * motivos "a mejorar"; si es perfecta (5) ofrece elogios. Multi-select (toggle), pill lima cuando está
 * seleccionada (DESIGN §3: pill solo en tags) con check del set. Las etiquetas seleccionadas se envían
 * dentro del comentario (el backend de ratings aún no acepta tags estructurados — degradación honesta).
 */
export function RatingReasonChips({
  stars,
  value,
  onChange,
}: {
  /** Estrellas actuales (1–5). Con 0 no se muestra nada. */
  stars: number;
  value: RatingReason[];
  onChange: (next: RatingReason[]) => void;
}): React.JSX.Element | null {
  const theme = useTheme();
  const { t } = useTranslation();

  if (stars < 1) {
    return null;
  }

  const reasons = stars === 5 ? PRAISE_REASONS : IMPROVE_REASONS;
  const label = stars === 5 ? t('ratings.praiseLabel') : t('ratings.improveLabel');

  const toggle = (r: RatingReason): void =>
    onChange(value.includes(r) ? value.filter((x) => x !== r) : [...value, r]);

  return (
    <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing.lg }}>
      <Text variant="footnote" color="inkMuted" align="center">
        {label}
      </Text>
      <View style={[styles.row, { gap: theme.spacing.sm }]}>
        {reasons.map((r) => {
          const on = value.includes(r);
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
              {on ? <IconCheck color={theme.colors.accent} size={14} /> : null}
              <Text variant="footnote" color={on ? 'accent' : 'ink'}>
                {t(`ratings.reason.${r}`)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Etiquetas legibles de los motivos elegidos, para anteponerlas al comentario libre. */
export function reasonLabels(
  reasons: RatingReason[],
  translate: (key: string) => string,
): string[] {
  return reasons.map((r) => translate(`ratings.reason.${r}`));
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 999 },
});
