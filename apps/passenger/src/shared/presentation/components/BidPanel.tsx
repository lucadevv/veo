import { IconButton, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { formatPEN } from '../../utils/format';
import { isAtFloor } from '../../utils/bid';
import { IconMinus, IconPlus } from '../../../features/trip/presentation/components/icons';

/**
 * PUJA · "Ofrece tu tarifa" (handoff `Offer`). Stepper de a S/1 sobre el número grande, anclado en el
 * sugerido del quote y con el piso de zona inviolable (el "−" se deshabilita en el piso y se avisa). La
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
  const { t } = useTranslation();
  const atFloor = isAtFloor(bidCents, floorCents);

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Text variant="footnote" color="inkMuted" align="center">
        {t('puja.offerYourFare')}
      </Text>

      <View style={[styles.stepperRow, { gap: theme.spacing.xl }]}>
        <IconButton
          accessibilityLabel={t('puja.decrease')}
          variant="surface"
          size="lg"
          disabled={atFloor}
          onPress={onDecrement}
          icon={<IconMinus color={atFloor ? theme.colors.inkSubtle : theme.colors.ink} size={22} />}
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

      <Text variant="footnote" color="inkMuted" align="center" tabular>
        {suggestedCents !== undefined
          ? t('puja.suggestedAndMin', {
              suggested: formatPEN(suggestedCents),
              min: formatPEN(floorCents),
            })
          : t('puja.minOnly', { min: formatPEN(floorCents) })}
      </Text>

      {atFloor ? (
        <Text variant="footnote" color="warn" align="center">
          {t('puja.atFloor')}
        </Text>
      ) : null}

      <Text variant="footnote" color="inkSubtle" align="center">
        {t('puja.tollsApart')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
