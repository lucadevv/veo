import React from 'react';
import {StyleSheet, View} from 'react-native';
import type {TFunction} from 'i18next';
import type {EarningsSummary} from '@veo/api-client';
import {Text, useTheme} from '@veo/ui-kit';
import {IconClock, IconEarnings, IconReceipt} from '../../../../shared/presentation/icons';
import {formatPEN} from '../../../../shared/presentation/format';
import {useCountUp} from './motion';

export interface EarningsHeroCardProps {
  /** Resumen real de ganancias (céntimos PEN). No se transforma ni se inventan datos. */
  summary: EarningsSummary;
  t: TFunction;
}

/**
 * Tarjeta "hero" de ganancias (lenguaje Midnight Motion).
 *
 * Muestra el neto total como métrica protagonista con tinte cian y, debajo, una fila de
 * estadísticas compactas con íconos. SOLO usa campos presentes en `EarningsSummary`:
 * `totalNetCents`, `totalGrossCents`, `paidNetCents`, `pendingNetCents`, `totalCommissionCents`
 * y `currency`. No hay serie temporal en el contrato, por eso no se dibuja ninguna gráfica:
 * la única línea cian es un detalle ornamental, nunca un dato.
 */
export function EarningsHeroCard({summary, t}: EarningsHeroCardProps): React.JSX.Element {
  const theme = useTheme();
  // Cuenta ascendente sutil del neto total al cargar (respeta reduce-motion).
  const animatedNet = useCountUp(summary.totalNetCents);

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderRadius: theme.radii.xl,
          padding: theme.spacing['2xl'],
          gap: theme.spacing.lg,
        },
      ]}>
      {/* Encabezado: ícono de acento + etiqueta + chip de moneda real del summary. */}
      <View style={[styles.heroHead, {gap: theme.spacing.md}]}>
        <View
          style={[
            styles.iconBadge,
            {
              backgroundColor: theme.colors.bg,
              borderRadius: theme.radii.md,
              borderColor: theme.colors.border,
            },
          ]}>
          <IconEarnings size={20} color={theme.colors.accent} strokeWidth={2} />
        </View>
        <Text variant="subhead" color="inkMuted" style={styles.flex}>
          {t('earnings.netTotal')}
        </Text>
        <View
          style={[
            styles.currencyChip,
            {backgroundColor: theme.colors.bg, borderRadius: theme.radii.pill},
          ]}>
          <Text variant="label" color="inkSubtle">
            {summary.currency}
          </Text>
        </View>
      </View>

      {/* Métrica protagonista: neto total con tinte cian y numerales tabulares. */}
      <View style={styles.amountBlock}>
        {/* Detalle ornamental (no es un dato): subraya el acento Midnight Motion. */}
        <View style={[styles.accentRule, {backgroundColor: theme.colors.accent}]} />
        <Text variant="display" color="accent" tabular>
          {formatPEN(animatedNet)}
        </Text>
        <Text variant="footnote" color="inkSubtle" tabular>
          {t('earnings.grossTotal')} · {formatPEN(summary.totalGrossCents)}
        </Text>
      </View>

      <View style={[styles.divider, {backgroundColor: theme.colors.border}]} />

      {/* Fila de estadísticas compactas: solo campos reales del summary. */}
      <View style={[styles.statsRow, {gap: theme.spacing.md}]}>
        <StatTile
          icon={<IconReceipt size={18} color={theme.colors.success} strokeWidth={2} />}
          label={t('earnings.paidNet')}
          value={formatPEN(summary.paidNetCents)}
          valueColor="success"
        />
        <StatTile
          icon={<IconClock size={18} color={theme.colors.warn} strokeWidth={2} />}
          label={t('earnings.pendingNet')}
          value={formatPEN(summary.pendingNetCents)}
          valueColor="warn"
        />
        <StatTile
          icon={<IconEarnings size={18} color={theme.colors.inkMuted} strokeWidth={2} />}
          label={t('earnings.commission')}
          value={formatPEN(summary.totalCommissionCents)}
          valueColor="ink"
        />
      </View>
    </View>
  );
}

interface StatTileProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueColor: 'ink' | 'success' | 'warn';
}

/** Celda de estadística compacta (ícono + etiqueta + monto). Privada de la tarjeta hero. */
function StatTile({icon, label, value, valueColor}: StatTileProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.statTile}>
      <View
        style={[
          styles.statIcon,
          {backgroundColor: theme.colors.bg, borderRadius: theme.radii.sm},
        ]}>
        {icon}
      </View>
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
  flex: {flex: 1},
  card: {alignSelf: 'stretch'},
  heroHead: {flexDirection: 'row', alignItems: 'center'},
  iconBadge: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  currencyChip: {paddingHorizontal: 10, paddingVertical: 4},
  amountBlock: {gap: 6},
  accentRule: {width: 36, height: 3, borderRadius: 999, marginBottom: 4},
  divider: {height: StyleSheet.hairlineWidth, alignSelf: 'stretch'},
  statsRow: {flexDirection: 'row'},
  statTile: {flex: 1, gap: 6},
  statIcon: {width: 32, height: 32, alignItems: 'center', justifyContent: 'center'},
});
