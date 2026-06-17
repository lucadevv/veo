import type {PaymentView} from '@veo/api-client';
import {useMutation} from '@tanstack/react-query';
import {Banner, Button, Card, Text, TextField, useTheme} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {parseTipToCents} from '../../domain/usecases';
import {formatPEN} from '../../../../shared/utils/format';
import {Animated, usePressScale} from './motion';

/** Propinas rápidas sugeridas (céntimos PEN). */
const QUICK_TIPS_CENTS = [200, 500, 1000] as const;

export interface TipCardProps {
  /** Viaje al que se deja la propina (`POST /trips/:id/tip`). */
  tripId: string;
  /** Propina ya acumulada del viaje (si > 0, mostramos el estado "enviada"). */
  initialTipCents?: number;
  /** Notifica el `paymentView` resultante (p. ej. para refrescar el detalle). */
  onTipped?: (payment: PaymentView) => void;
}

/**
 * Tarjeta para dejar propina al conductor tras el viaje. Chips rápidos (S/2, S/5, S/10) + monto
 * personalizado y un botón "Enviar propina" (`POST /trips/:id/tip`). 100% va al conductor. La
 * idempotencia la garantiza el bff, así que reintentos no duplican. Reutilizable en Rating y
 * TripDetail. Feedback inmediato al tocar (chip seleccionado), transición de éxito y errores en Banner.
 */
export function TipCard({
  tripId,
  initialTipCents = 0,
  onTipped,
}: TipCardProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const addTip = useDependency(TOKENS.addTipUseCase);

  // Chip preseleccionado (céntimos) o 'custom' para usar el campo libre.
  const [selected, setSelected] = useState<number | 'custom' | null>(null);
  const [custom, setCustom] = useState('');

  const customCents = parseTipToCents(custom);
  const tipCents = selected === 'custom' ? customCents : (selected ?? 0);

  const mutation = useMutation<PaymentView, Error, number>({
    mutationFn: (cents: number) => addTip.execute(tripId, cents),
    onSuccess: payment => onTipped?.(payment),
  });

  // Propina ya enviada (en esta sesión o acumulada del viaje): estado de confirmación.
  const sentCents =
    mutation.data?.tipCents ??
    (initialTipCents > 0 ? initialTipCents : undefined);

  if (sentCents) {
    return (
      <Card variant="outlined" padding="lg">
        <Banner
          tone="success"
          title={t('tips.sentTitle')}
          description={t('tips.sentBody', {amount: formatPEN(sentCents)})}
        />
      </Card>
    );
  }

  const canSend = tipCents > 0 && !mutation.isPending;

  return (
    <Card variant="outlined" padding="lg">
      <Text variant="title3">{t('tips.title')}</Text>
      <Text
        variant="footnote"
        color="inkMuted"
        style={{marginTop: theme.spacing.xs}}>
        {t('tips.subtitle')}
      </Text>

      <View
        style={[
          styles.chips,
          {gap: theme.spacing.sm, marginTop: theme.spacing.lg},
        ]}>
        {QUICK_TIPS_CENTS.map(cents => (
          <TipChip
            key={cents}
            label={formatPEN(cents)}
            tabular
            active={selected === cents}
            onPress={() => {
              setSelected(cents);
              setCustom('');
            }}
          />
        ))}

        <TipChip
          label={t('tips.custom')}
          active={selected === 'custom'}
          onPress={() => setSelected('custom')}
        />
      </View>

      {selected === 'custom' ? (
        <View style={{marginTop: theme.spacing.md}}>
          <TextField
            label={t('tips.customLabel')}
            keyboardType="decimal-pad"
            value={custom}
            onChangeText={setCustom}
            autoFocus
          />
        </View>
      ) : null}

      {mutation.isError ? (
        <Banner
          tone="danger"
          title={t('tips.error')}
          style={{marginTop: theme.spacing.md}}
        />
      ) : null}

      <Button
        label={mutation.isPending ? t('tips.sending') : t('tips.send')}
        variant="accent"
        fullWidth
        loading={mutation.isPending}
        disabled={!canSend}
        onPress={() => mutation.mutate(tipCents)}
        style={{marginTop: theme.spacing.lg}}
      />
    </Card>
  );
}

interface TipChipProps {
  label: string;
  active: boolean;
  onPress: () => void;
  tabular?: boolean;
}

/** Chip de propina: borde lima al estar activo + feedback de press (scale 0.97). Respeta reduce-motion. */
function TipChip({
  label,
  active,
  onPress,
  tabular = false,
}: TipChipProps): React.JSX.Element {
  const theme = useTheme();
  const {animatedStyle, onPressIn, onPressOut} = usePressScale();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{selected: active}}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}>
      <Animated.View
        style={[
          styles.chip,
          animatedStyle,
          {
            borderRadius: theme.radii.pill,
            paddingVertical: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
            borderColor: active ? theme.colors.accent : theme.colors.border,
            borderWidth: active ? 2 : 1,
            backgroundColor: active
              ? theme.colors.surfaceElevated
              : theme.colors.surface,
          },
        ]}>
        <Text
          variant="bodyStrong"
          color={active ? 'accent' : 'ink'}
          tabular={tabular}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chips: {flexDirection: 'row', flexWrap: 'wrap'},
  chip: {alignItems: 'center', justifyContent: 'center'},
});
