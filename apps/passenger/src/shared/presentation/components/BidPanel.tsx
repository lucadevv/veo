import {IconButton, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {formatPEN} from '../../utils/format';
import {isAtFloor} from '../../utils/bid';
import {
  IconBolt,
  IconCheck,
  IconMinus,
  IconPlus,
} from '../../../features/trip/presentation/components/icons';

/**
 * PUJA · "Pon tu precio" (design/veo.pen P/PujaPrice · LmocF). Header propio (título + sub), stepper
 * de a S/1 sobre el número grande anclado en el sugerido del quote, pill de SUGERIDO con check (rango
 * real min–sugerido del server) y nota con rayo ("una mejor oferta encuentra conductor más rápido").
 * El piso de zona es inviolable (el "−" se deshabilita en el piso y se avisa); peajes van aparte. La
 * lógica de clamp/redondeo vive en `shared/utils/bid.ts` (pura, testeada); este componente solo refleja.
 */
export interface BidPanelProps {
  bidCents: number;
  suggestedCents?: number;
  floorCents: number;
  onDecrement: () => void;
  onIncrement: () => void;
}

export function BidPanel({
  bidCents,
  suggestedCents,
  floorCents,
  onDecrement,
  onIncrement,
}: BidPanelProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const atFloor = isAtFloor(bidCents, floorCents);
  // Pill de rango SOLO con datos reales del server (sugerido + piso > 0); si falta alguno, cae al
  // texto plano de siempre (sugerido/mínimo) — nunca un rango inventado.
  const hasRange = suggestedCents !== undefined && floorCents > 0;

  return (
    <View style={{gap: theme.spacing.sm}}>
      {/* Header propio del panel (pen: título grande + sub en voseo → acá tuteo peruano). */}
      <View style={{gap: theme.spacing.xxs}}>
        <Text variant="title3">{t('puja.panelTitle')}</Text>
        <Text variant="footnote" color="inkMuted">
          {t('puja.panelSubtitle')}
        </Text>
      </View>

      <View style={[styles.stepperRow, {gap: theme.spacing.xl}]}>
        <IconButton
          accessibilityLabel={t('puja.decrease')}
          variant="surface"
          size="lg"
          disabled={atFloor}
          onPress={onDecrement}
          icon={
            <IconMinus
              color={atFloor ? theme.colors.inkSubtle : theme.colors.ink}
              size={22}
            />
          }
        />
        <Text variant="display" color="ink" tabular>
          {formatPEN(bidCents)}
        </Text>
        <IconButton
          accessibilityLabel={t('puja.increase')}
          variant="surface"
          size="lg"
          onPress={onIncrement}
          icon={<IconPlus color={theme.colors.accent} size={22} />}
        />
      </View>

      {/* Sugerido: pill con check (pen RangeHint, tono success) cuando el server dio min Y sugerido;
          si no, el texto informativo de siempre. Los montos son SIEMPRE los reales del quote. */}
      {hasRange ? (
        <View
          style={[
            styles.rangePill,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderRadius: theme.radii.pill,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: theme.spacing.xs,
              gap: theme.spacing.xs,
            },
          ]}>
          <IconCheck color={theme.colors.success} size={13} />
          <Text variant="footnote" color="success" tabular>
            {t('puja.suggestedRange', {
              min: formatPEN(floorCents),
              suggested: formatPEN(suggestedCents),
            })}
          </Text>
        </View>
      ) : (
        <Text variant="footnote" color="inkMuted" align="center" tabular>
          {suggestedCents !== undefined
            ? t('puja.suggestedAndMin', {
                suggested: formatPEN(suggestedCents),
                min: formatPEN(floorCents),
              })
            : t('puja.minOnly', {min: formatPEN(floorCents)})}
        </Text>
      )}

      {atFloor ? (
        <Text variant="footnote" color="warn" align="center">
          {t('puja.atFloor')}
        </Text>
      ) : null}

      {/* Nota con rayo (pen Note): incentivo honesto — mejor oferta ⇒ match más rápido. */}
      <View
        style={[
          styles.note,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderRadius: theme.radii.md,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.sm,
            gap: theme.spacing.sm,
          },
        ]}>
        <IconBolt color={theme.colors.accent} size={16} />
        <Text
          variant="footnote"
          color="inkMuted"
          style={styles.noteText}>
          {t('puja.betterOfferNote')}
        </Text>
      </View>

      <Text variant="footnote" color="inkSubtle" align="center">
        {t('puja.tollsApart')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Pill del sugerido: centrada bajo el precio, abraza su contenido (no de borde a borde).
  rangePill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
  },
  note: {flexDirection: 'row', alignItems: 'center'},
  noteText: {flex: 1},
});
