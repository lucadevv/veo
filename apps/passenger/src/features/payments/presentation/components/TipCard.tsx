import type {PaymentView} from '@veo/api-client';
import {useMutation} from '@tanstack/react-query';
import {Banner, Button, Card, Text, TextField, useTheme} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {parseTipToCents} from '../../domain/usecases';
import {interpretPaymentOutcome} from '../../domain/paymentOutcome';
import {formatPEN} from '../../../../shared/utils/format';
import {CheckoutInstructions} from './CheckoutInstructions';
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

  // La propina es un COBRO digital dedicado (Model B): interpretamos su resultado con el clasificador de
  // dominio canónico (mismo que el recibo/deuda), NUNCA asumimos "enviada" por el solo hecho de tener monto.
  const outcome = mutation.data ? interpretPaymentOutcome(mutation.data) : null;

  // (1) YA dada: acumulada del viaje (persistida — sobrevive al re-montaje) o recién CAPTURED en esta sesión.
  const settledCents =
    initialTipCents > 0
      ? initialTipCents
      : outcome?.kind === 'settled'
        ? (mutation.data?.tipCents ?? 0)
        : 0;
  if (settledCents > 0) {
    return (
      <Card variant="outlined" padding="lg">
        <Banner
          tone="success"
          title={t('tips.sentTitle')}
          description={t('tips.sentBody', {amount: formatPEN(settledCents)})}
        />
      </Card>
    );
  }

  // (2) Se está COBRANDO fuera de banda (viaje en efectivo / sin Yape vinculado): el pasajero DEBE completar
  // el checkout (Yape/QR/CIP). Reusamos el componente CANÓNICO de checkout; `onRetry` re-corre el cobro, que es
  // IDEMPOTENTE por dedupKey → al confirmar el webhook devuelve el mismo cobro ya CAPTURED. Antes acá se decía
  // "propina enviada" sobre un PENDING sin abrir el checkout → la propina se perdía.
  if (outcome?.kind === 'checkoutPending' && mutation.data) {
    const chargedCents = mutation.data.tipCents;
    return (
      <Card variant="outlined" padding="lg">
        <CheckoutInstructions
          payment={mutation.data}
          retrying={mutation.isPending}
          onRetry={() => mutation.mutate(chargedCents)}
          header={
            <>
              <Text variant="title3">{t('tips.checkoutTitle')}</Text>
              <Text variant="callout" color="inkMuted">
                {t('tips.checkoutBody', {amount: formatPEN(chargedCents)})}
              </Text>
            </>
          }
        />
      </Card>
    );
  }

  // (3) On-file (Yape vinculado): cobrándose server-initiated, se confirma por webhook. Estado honesto.
  if (outcome?.kind === 'processing') {
    return (
      <Card variant="outlined" padding="lg">
        <Banner
          tone="info"
          title={t('tips.processingTitle')}
          description={t('tips.processingBody')}
        />
      </Card>
    );
  }

  // (4) El cobro de la propina falló terminal (declive/expiró): honesto + volver a elegir. El reintento REINICIA
  // el selector (no re-cobra el MISMO tip: la idempotencia por dedupKey devuelve el FAILED sin cobrar — el
  // pasajero elige de nuevo, un monto distinto se cobra normal). El botón NO es un no-op: limpia el estado.
  if (outcome?.kind === 'failed' || outcome?.kind === 'debt') {
    return (
      <Card variant="outlined" padding="lg">
        <Banner
          tone="danger"
          title={t('tips.failedTitle')}
          description={t('tips.failedBody')}
        />
        <Button
          label={t('actions.retry')}
          variant="secondary"
          fullWidth
          onPress={() => {
            mutation.reset();
            setSelected(null);
            setCustom('');
          }}
          style={{marginTop: theme.spacing.md}}
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
