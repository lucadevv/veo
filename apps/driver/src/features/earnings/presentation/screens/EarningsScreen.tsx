import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Banner, SafeScreen, Skeleton, Text, useTheme, type StatusTone } from '@veo/ui-kit';
import type { DriverPayoutView } from '@veo/api-client';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { formatPEN, formatShortDate } from '../../../../shared/presentation/format';
import { EarningsHeroCard } from '../components/EarningsHeroCard';
import { PayoutRow } from '../components/PayoutRow';
import { BreakdownCard } from '../components/BreakdownCard';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { Appear } from '../components/motion';
import { useEarningsBreakdown, useEarningsSummary } from '../hooks/useEarnings';

// ── Mapeo de estado de payout → tono/etiqueta. `status` es el enum TIPADO del contrato
// (`payoutStatus`), no un string libre: el switch es exhaustivo sobre el union, así un valor nuevo o
// un literal mal escrito es error de compilación, NO un payout pagado que se ve "pendiente". ─────────
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

/** Encabezado simple de la pestaña Ganancias (sin retroceso: es un tab, no una pila). */
function EarningsHeader({ title }: { title: string }): React.JSX.Element {
  return (
    <View style={styles.header}>
      <Text variant="title1" numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

type EarningsTab = 'summary' | 'breakdown';

/** Sección "Resumen": hero del neto total + lista de liquidaciones (comportamiento previo intacto). */
function SummarySection({ t }: { t: TFunction }): React.JSX.Element {
  const theme = useTheme();
  const { data, isLoading, isError, error, refetch } = useEarningsSummary();

  if (isLoading) {
    return (
      <View style={[styles.section, { gap: theme.spacing.lg }]}>
        <Skeleton height={188} radius={theme.radii.xl} />
        <Skeleton height={20} width="40%" />
        <Skeleton height={72} radius={theme.radii.lg} />
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
      {/* Tarjeta hero con el neto total y las estadísticas reales del summary. */}
      <Appear>
        <EarningsHeroCard summary={data} t={t} />
      </Appear>

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
              <Appear key={payout.id} delay={index * 60} distance={8}>
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
              </Appear>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/** Sección "Desglose": GET /earnings/breakdown con tarjetas de HOY y SEMANA (neto destacado). */
function BreakdownSection({ t }: { t: TFunction }): React.JSX.Element {
  const theme = useTheme();
  const { data, isLoading, isError, error, refetch } = useEarningsBreakdown();

  if (isLoading) {
    return (
      <View style={[styles.section, { gap: theme.spacing.lg }]}>
        <Skeleton height={236} radius={theme.radii.xl} />
        <Skeleton height={236} radius={theme.radii.xl} />
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
      <Appear>
        <BreakdownCard periodLabel={t('earnings.periodToday')} breakdown={data.today} t={t} />
      </Appear>
      <Appear delay={90}>
        <BreakdownCard periodLabel={t('earnings.periodWeek')} breakdown={data.week} t={t} />
      </Appear>
    </View>
  );
}

export const EarningsScreen = (): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const [tab, setTab] = useState<EarningsTab>('summary');

  return (
    <SafeScreen scroll header={<EarningsHeader title={t('earnings.title')} />}>
      <View style={[styles.tabsWrap, { marginBottom: theme.spacing.lg }]}>
        <SegmentedTabs
          value={tab}
          onChange={(key) => setTab(key as EarningsTab)}
          items={[
            { key: 'summary', label: t('earnings.tabSummary') },
            { key: 'breakdown', label: t('earnings.tabBreakdown') },
          ]}
        />
      </View>

      {tab === 'summary' ? <SummarySection t={t} /> : <BreakdownSection t={t} />}
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  header: { paddingTop: 8, paddingBottom: 12 },
  tabsWrap: { paddingTop: 4 },
  section: { paddingTop: 4 },
  payoutsBlock: { alignSelf: 'stretch' },
  payoutsCard: { borderWidth: StyleSheet.hairlineWidth },
  emptyCard: { borderWidth: StyleSheet.hairlineWidth },
});
