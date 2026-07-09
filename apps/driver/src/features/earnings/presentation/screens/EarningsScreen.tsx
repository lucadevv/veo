import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Banner, SafeScreen, Skeleton, Text, useTheme, type StatusTone } from '@veo/ui-kit';
import type { DriverPayoutView } from '@veo/api-client';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { formatPEN, formatShortDate } from '../../../../shared/presentation/format';
import { PayoutRow } from '../components/PayoutRow';
import { PeriodTotalCard } from '../components/PeriodTotalCard';
import { WeeklyBarChart } from '../components/WeeklyBarChart';
import { PayoutInfoCard } from '../components/PayoutInfoCard';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { ScreenHero } from '../../../../shared/presentation/components/ScreenHero';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { useEarningsBreakdown, useEarningsDaily, useEarningsSummary } from '../hooks/useEarnings';

// ── Mapeo de estado de payout → tono/etiqueta. `status` es el enum TIPADO del contrato
// (`payoutStatus`): switch exhaustivo, un literal nuevo o mal escrito es error de compilación. ─────────
type PayoutStatusValue = DriverPayoutView['status'];

function payoutTone(status: PayoutStatusValue): StatusTone {
  switch (status) {
    case 'PROCESSED':
      return 'success';
    case 'PROCESSING':
      return 'accent';
    case 'HELD':
    case 'FAILED':
      return 'danger';
    case 'PENDING':
      return 'warn';
  }
}

function payoutLabel(status: PayoutStatusValue, t: TFunction): string {
  switch (status) {
    case 'PROCESSED':
      return t('earnings.payoutStatus.paid');
    case 'PROCESSING':
      return t('earnings.payoutStatus.processing');
    case 'HELD':
      return t('earnings.payoutStatus.held');
    case 'FAILED':
      return t('earnings.payoutStatus.failed');
    case 'PENDING':
      return t('earnings.payoutStatus.pending');
  }
}

/** Ventana temporal seleccionable. Mapea 1:1 con `DriverEarningsSummary` (today/week/month). */
type Period = 'today' | 'week' | 'month';

const PERIOD_NET_LABEL: Record<Period, string> = {
  today: 'earnings.netTodayLabel',
  week: 'earnings.netWeekLabel',
  month: 'earnings.netMonthLabel',
};

/**
 * Bloque "ganancias del período": card de neto (según el segmented) + bar chart semanal. El chart es
 * SIEMPRE la semana en curso (7 días), independiente del período elegido — así lo dibuja el frame.
 */
function EarningsBlock({ period, t }: { period: Period; t: TFunction }): React.JSX.Element {
  const theme = useTheme();
  const breakdown = useEarningsBreakdown();
  const daily = useEarningsDaily();

  if (breakdown.isLoading) {
    return (
      <View style={[styles.section, { gap: theme.spacing.lg }]}>
        <Skeleton height={132} radius={theme.radii.xl} />
        <Skeleton height={148} radius={theme.radii.lg} />
      </View>
    );
  }

  if (breakdown.isError || !breakdown.data) {
    return (
      <View style={[styles.section, { gap: theme.spacing.lg }]}>
        <Banner
          tone="danger"
          title={t('errors.generic')}
          description={toErrorMessage(breakdown.error, t)}
          action={{ label: t('common.retry'), onPress: () => breakdown.refetch() }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.section, { gap: theme.spacing.lg }]}>
      <Reveal>
        <PeriodTotalCard
          label={t(PERIOD_NET_LABEL[period])}
          breakdown={breakdown.data[period]}
          t={t}
        />
      </Reveal>

      {/* El chart degrada honesto: si su query falla, la card de neto sigue en pie (no bloquea la pantalla). */}
      {daily.isLoading ? (
        <Skeleton height={148} radius={theme.radii.lg} />
      ) : daily.isError || !daily.data ? null : (
        <Reveal delay={90}>
          <WeeklyBarChart days={daily.data.days} t={t} />
        </Reveal>
      )}
    </View>
  );
}

/** Bloque "por liquidar" + historial de liquidaciones (GET /earnings/summary). */
function PayoutsBlock({ t }: { t: TFunction }): React.JSX.Element {
  const theme = useTheme();
  const { data, isLoading, isError, error, refetch } = useEarningsSummary();

  if (isLoading) {
    return (
      <View style={[styles.section, { gap: theme.spacing.lg }]}>
        <Skeleton height={96} radius={theme.radii.lg} />
        <Skeleton height={72} radius={theme.radii.lg} />
      </View>
    );
  }

  if (isError || !data) {
    return (
      <View style={[styles.section, { gap: theme.spacing.lg }]}>
        <Banner
          tone="danger"
          title={t('errors.generic')}
          description={toErrorMessage(error, t)}
          action={{ label: t('common.retry'), onPress: () => refetch() }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.section, { gap: theme.spacing.xl }]}>
      <Reveal>
        <PayoutInfoCard pendingNetCents={data.pendingNetCents} t={t} />
      </Reveal>

      <View style={[styles.payoutsBlock, { gap: theme.spacing.sm }]}>
        <Text variant="headline">{t('earnings.payoutsTitle')}</Text>
        {data.payouts.length === 0 ? (
          <View
            style={[
              styles.emptyCard,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.lg,
                padding: theme.spacing['2xl'],
              },
            ]}
          >
            <Text variant="callout" color="inkMuted">
              {t('earnings.payoutsEmpty')}
            </Text>
          </View>
        ) : (
          <View
            style={[
              styles.payoutsCard,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.lg,
                paddingHorizontal: theme.spacing.lg,
              },
            ]}
          >
            {data.payouts.map((payout: DriverPayoutView, index: number) => (
              <Reveal key={payout.id} delay={index * 60} distance={8}>
                <PayoutRow
                  amountLabel={formatPEN(payout.amountCents)}
                  periodLabel={t('earnings.payoutPeriod', {
                    start: formatShortDate(payout.periodStart),
                    end: formatShortDate(payout.periodEnd),
                  })}
                  statusLabel={payoutLabel(payout.status, t)}
                  statusTone={payoutTone(payout.status)}
                  showDivider={index > 0}
                />
              </Reveal>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * Pantalla "Ganancias" del conductor, fiel al frame C/Ganancias: segmented temporal (Hoy/Semana/Mes) →
 * card de NETO del período + bar chart "Por día" + card "Por liquidar" (informativa) + historial de
 * liquidaciones. Sin horas trabajadas (no hay dato) y sin acción "Liquidar" (modelo LNS admin-only).
 */
export const EarningsScreen = (): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const [period, setPeriod] = useState<Period>('week');

  return (
    <SafeScreen scroll>
      <ScreenHero title={t('earnings.title')} />
      <View style={[styles.tabsWrap, { marginBottom: theme.spacing.lg }]}>
        <SegmentedTabs
          value={period}
          onChange={(key) => setPeriod(key as Period)}
          items={[
            { key: 'today', label: t('earnings.tabToday') },
            { key: 'week', label: t('earnings.tabWeek') },
            { key: 'month', label: t('earnings.tabMonth') },
          ]}
        />
      </View>

      <View style={{ gap: theme.spacing.xl }}>
        <EarningsBlock period={period} t={t} />
        <PayoutsBlock t={t} />
      </View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  tabsWrap: { paddingTop: 4 },
  section: { paddingTop: 4 },
  payoutsBlock: { alignSelf: 'stretch' },
  payoutsCard: { borderWidth: StyleSheet.hairlineWidth },
  emptyCard: { borderWidth: StyleSheet.hairlineWidth },
});
