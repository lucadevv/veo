import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { PaymentView } from '@veo/api-client';
import {
  Banner,
  Button,
  Card,
  SafeScreen,
  Skeleton,
  SuccessCheck,
  Text,
  useTheme,
} from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { ScreenHero } from '../../../../shared/presentation/components/ScreenHero';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { formatPEN } from '../../../../shared/presentation/format';
import { useRepositories } from '../../../../core/di/useDi';
import { EARNINGS_SUMMARY_QUERY_KEY, GetEarningsSummaryUseCase } from '../../../earnings/domain';
import { PROFILE_QUERY_KEY } from '../../../profile/domain';
import type { DebtSettleMethod } from '../../domain';
import { DebtCheckoutInstructions } from '../components/DebtCheckoutInstructions';

type Props = NativeStackScreenProps<RootStackParamList, 'SettleDebt'>;

/** Cadencia del poll del estado de la deuda mientras el conductor completa el checkout (webhook ProntoPaga). */
const POLL_INTERVAL_MS = 2500;

/** Métodos DIGITALES ofrecidos al conductor (Yape/Plin/Tarjeta). CASH no aplica (deuda acumulada). */
const METHODS: readonly DebtSettleMethod[] = ['YAPE', 'PLIN', 'CARD'];

/**
 * Estado del flujo de saldar:
 *  - `idle`: resumen de la deuda + selector de método + "Saldar S/X".
 *  - `checkout`: el cobro volvió PENDING con checkout (ProntoPaga) → cómo pagar + poll a capturado.
 *  - `settled`: la deuda quedó saldada (pendingDebtCents → 0) → éxito, el banner del dashboard desaparece.
 */
type Phase = 'idle' | 'checkout' | 'settled';

/**
 * ADR-022 §P-A · Pantalla "Saldar deuda" del conductor. Muestra el total pendiente de comisiones por viajes
 * en EFECTIVO, deja elegir un medio DIGITAL (Yape/Plin/Tarjeta) y dispara el cobro de liquidación por el rail.
 * Si el cobro vuelve con checkout (ProntoPaga), reusa el patrón del PASAJERO (deepLink/QR/urlPay/CIP) + poll:
 * al capturarse, `pendingDebtCents` cae a 0 y el backend desbloquea al conductor solo → éxito + refetch del
 * estado (el banner de bloqueo del dashboard se va). Saldar es la ÚNICA forma de desbloquearse.
 */
export const SettleDebtScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { earnings, debt } = useRepositories();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>('idle');
  const [selectedMethod, setSelectedMethod] = useState<DebtSettleMethod>('YAPE');
  // El cobro de liquidación en vuelo (tras el settle): su checkout alimenta la vista + el poll de captura.
  const [payment, setPayment] = useState<PaymentView | null>(null);

  /** Refetchea el estado que ve el dashboard (deuda + bloqueo) para que el banner refleje el desbloqueo. */
  const invalidateBlockState = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: EARNINGS_SUMMARY_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
  }, [queryClient]);

  const markSettled = React.useCallback(() => {
    invalidateBlockState();
    setPhase('settled');
  }, [invalidateBlockState]);

  // Resumen de ganancias (fuente del monto de la deuda). En `checkout` POLLEA: la captura del cobro marca las
  // deudas PAID → `pendingDebtCents` cae a 0. Comparte la clave del dashboard (cache coherente: el banner se
  // actualiza solo). El poll se apaga cuando la deuda llega a 0 (éxito) o fuera de la fase de checkout.
  const summaryQuery = useQuery({
    queryKey: EARNINGS_SUMMARY_QUERY_KEY,
    queryFn: () => new GetEarningsSummaryUseCase(earnings).execute(),
    refetchInterval: (query) => {
      if (phase !== 'checkout') {
        return false;
      }
      const pending = query.state.data?.pendingDebtCents ?? 0;
      return pending === 0 ? false : POLL_INTERVAL_MS;
    },
  });

  const pendingDebtCents = summaryQuery.data?.pendingDebtCents ?? 0;

  // La captura llegó (el poll ve la deuda en 0): éxito. Solo dispara desde la fase de checkout.
  React.useEffect(() => {
    if (phase === 'checkout' && summaryQuery.data && (summaryQuery.data.pendingDebtCents ?? 0) === 0) {
      markSettled();
    }
  }, [phase, summaryQuery.data, markSettled]);

  const settleMutation = useMutation<PaymentView, Error, DebtSettleMethod>({
    mutationFn: (method) => debt.settle(method),
    onSuccess: (result) => {
      setPayment(result);
      // Sandbox/live puede capturar de una (sin checkout): éxito directo. ProntoPaga → checkout + poll.
      if (result.status === 'CAPTURED') {
        markSettled();
        return;
      }
      setPhase('checkout');
    },
  });

  /** Reintenta el checkout: re-llama el settle (idempotente → mismo checkout, o uno nuevo si venció). */
  const retryCheckout = React.useCallback(() => {
    settleMutation.mutate(payment?.method ? (payment.method as DebtSettleMethod) : selectedMethod);
    // Además refetchea la deuda: si ya capturó (webhook) mientras el checkout estaba abierto, cae a 0 → éxito.
    void summaryQuery.refetch();
  }, [settleMutation, payment, selectedMethod, summaryQuery]);

  // ── Cargando el monto de la deuda ────────────────────────────────────────────────────────────
  let body: React.ReactNode;

  if (phase === 'settled') {
    body = (
      <View style={styles.centered}>
        {/* Sello de éxito CANÓNICO (antes: ring translúcido + IconCheck SIN animación). Ahora trae el pop. */}
        <SuccessCheck size={72} />
        <Text variant="title2" align="center">
          {t('debt.settledTitle')}
        </Text>
        <Text variant="callout" color="inkMuted" align="center">
          {t('debt.settledBody')}
        </Text>
        <Button
          label={t('debt.backToStart')}
          variant="primary"
          fullWidth
          onPress={() => navigation.goBack()}
        />
      </View>
    );
  } else if (phase === 'checkout' && payment) {
    body = (
      <View style={{ gap: theme.spacing.lg }}>
        <DebtAmountCard amountCents={payment.amountCents} label={t('debt.summaryLabel')} />
        <DebtCheckoutInstructions
          payment={payment}
          onRetry={retryCheckout}
          retrying={settleMutation.isPending || summaryQuery.isFetching}
        />
      </View>
    );
  } else if (summaryQuery.isLoading) {
    body = (
      <View style={{ gap: theme.spacing.lg }}>
        <Skeleton height={110} radius={theme.radii.lg} />
        <Skeleton height={180} radius={theme.radii.lg} />
      </View>
    );
  } else if (summaryQuery.isError || !summaryQuery.data) {
    body = (
      <Banner
        tone="danger"
        title={t('errors.generic')}
        description={toErrorMessage(summaryQuery.error, t)}
        action={{ label: t('common.retry'), onPress: () => summaryQuery.refetch() }}
      />
    );
  } else if (pendingDebtCents === 0) {
    // No hay deuda que saldar (ya se saldó en otra sesión, o llegó acá sin deuda): honesto + salida.
    body = (
      <View style={{ gap: theme.spacing.lg }}>
        <Banner tone="info" title={t('debt.noDebtTitle')} description={t('debt.noDebtBody')} />
        <Button
          label={t('debt.backToStart')}
          variant="primary"
          fullWidth
          onPress={() => navigation.goBack()}
        />
      </View>
    );
  } else {
    // idle: monto de la deuda + selector de método + "Saldar S/X".
    body = (
      <View style={{ gap: theme.spacing.xl }}>
        <DebtAmountCard amountCents={pendingDebtCents} label={t('debt.summaryLabel')} />
        <Text variant="callout" color="inkMuted">
          {t('debt.explain')}
        </Text>

        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="headline">{t('debt.methodTitle')}</Text>
          {METHODS.map((method) => {
            const active = method === selectedMethod;
            return (
              <Pressable
                key={method}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                onPress={() => setSelectedMethod(method)}
                style={[
                  styles.methodRow,
                  {
                    backgroundColor: active ? theme.colors.brandDim : theme.colors.surface,
                    borderColor: active ? theme.colors.accent : theme.colors.border,
                    borderRadius: theme.radii.md,
                  },
                ]}
              >
                <Text variant="bodyStrong" color={active ? 'accent' : 'ink'}>
                  {t(`debt.method.${method}`)}
                </Text>
                <View
                  style={[
                    styles.radio,
                    { borderColor: active ? theme.colors.accent : theme.colors.border },
                  ]}
                >
                  {active ? (
                    <View style={[styles.radioDot, { backgroundColor: theme.colors.accent }]} />
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>

        {settleMutation.isError ? (
          <Banner
            tone="danger"
            title={t('debt.settleErrorTitle')}
            description={toErrorMessage(settleMutation.error, t)}
          />
        ) : null}

        <Button
          label={
            settleMutation.isPending
              ? t('debt.paying')
              : t('debt.payCta', { amount: formatPEN(pendingDebtCents) })
          }
          variant="primary"
          size="lg"
          fullWidth
          loading={settleMutation.isPending}
          onPress={() => settleMutation.mutate(selectedMethod)}
        />
      </View>
    );
  }

  return (
    <SafeScreen scroll>
      <ScreenHero title={t('debt.title')} />
      <View style={styles.content}>{body}</View>
    </SafeScreen>
  );
};

/** Card destacada del monto de la deuda (ámbar de deuda), reutilizada en idle y en checkout. */
function DebtAmountCard({
  amountCents,
  label,
}: {
  amountCents: number;
  label: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Card variant="elevated" padding="lg">
      <View style={{ gap: theme.spacing.xs }}>
        <Text variant="footnote" color="inkMuted">
          {label}
        </Text>
        <Text variant="display" color="warn" tabular>
          {formatPEN(amountCents)}
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 4 },
  centered: { gap: 14, alignItems: 'center', paddingTop: 24 },
  successRing: {
    width: 72,
    height: 72,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  methodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 10, height: 10, borderRadius: 999 },
});
