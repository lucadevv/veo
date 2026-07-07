import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { TFunction } from 'i18next';
import type { EarningsSummary } from '@veo/api-client';
import { Text, useTheme } from '@veo/ui-kit';
import { formatPEN } from '../../../../shared/presentation/format';
import { useCountUp } from './motion';

export interface EarningsHeroCardProps {
  /** Resumen real de ganancias (céntimos PEN). No se transforma ni se inventan datos. */
  summary: EarningsSummary;
  t: TFunction;
}

/**
 * Hero EDITORIAL de ganancias. NO es la "card con número gigante + sub-tiles": ese hero-metric template
 * es el cliché SaaS que `impeccable` prohíbe (lo que se sentía "hecho por AI"). Acá el neto es la métrica
 * protagonista como número `display` a la IZQUIERDA, en JADE (dinero ganado = positivo, el acento premium
 * de la marca — no el azul, que se reserva a lo interactivo), SIN encajonar. Debajo, una fila de stats
 * limpia (label + monto) separada por una línea sutil. Solo campos reales del `EarningsSummary`.
 */
export function EarningsHeroCard({ summary, t }: EarningsHeroCardProps): React.JSX.Element {
  const theme = useTheme();
  // Cuenta ascendente sutil del neto total al cargar (respeta reduce-motion).
  const animatedNet = useCountUp(summary.totalNetCents);

  return (
    <View style={styles.hero}>
      <Text variant="caption" color="inkMuted">
        {t('earnings.netTotal')}
      </Text>
      <Text variant="display" color="success" tabular>
        {formatPEN(animatedNet)}
      </Text>
      <Text variant="footnote" color="inkSubtle" tabular>
        {t('earnings.grossTotal')} · {formatPEN(summary.totalGrossCents)} · {summary.currency}
      </Text>

      <View style={[styles.stats, { borderTopColor: theme.colors.border }]}>
        <Stat
          label={t('earnings.paidNet')}
          value={formatPEN(summary.paidNetCents)}
          valueColor="ink"
        />
        <Stat
          label={t('earnings.pendingNet')}
          value={formatPEN(summary.pendingNetCents)}
          valueColor="inkMuted"
        />
        <Stat
          label={t('earnings.commission')}
          value={formatPEN(summary.totalCommissionCents)}
          valueColor="inkMuted"
        />
      </View>
    </View>
  );
}

interface StatProps {
  label: string;
  value: string;
  valueColor: 'ink' | 'inkMuted';
}

/** Celda de estadística: etiqueta muted + monto. Sin ícono ni caja (evita el "grid de cards" cliché). */
function Stat({ label, value, valueColor }: StatProps): React.JSX.Element {
  return (
    <View style={styles.stat}>
      <Text variant="caption" color="inkSubtle" numberOfLines={1}>
        {label}
      </Text>
      <Text variant="bodyStrong" color={valueColor} tabular numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { gap: 6 },
  stats: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 20,
    paddingTop: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  stat: { flex: 1, gap: 4 },
});
