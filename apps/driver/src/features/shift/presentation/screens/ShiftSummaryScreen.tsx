import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeScreen, Skeleton, Text, useTheme } from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { formatPEN } from '../../../../shared/presentation/format';
import {
  IconClock,
  IconCoins,
  IconCar,
  IconFlag,
  IconRoute,
  type IconProps,
} from '../../../../shared/presentation/icons';
import { useEarningsBreakdown } from '../hooks/useEarnings';
import { formatShiftDurationShort, shiftElapsedMinutes } from '../../domain';
import { Appear, PressableScale } from '../components/motion';

type Props = NativeStackScreenProps<RootStackParamList, 'ShiftSummary'>;

/** Marcador honesto para una métrica que el backend no expone (recorrido) o que no se pudo medir. */
const NO_DATA = '—';

/**
 * Resumen de CIERRE de turno (frame C/CierreTurno). Se llega al FINALIZAR el turno (reemplaza al dock
 * offline): celebra el cierre y muestra lo ganado hoy + stats del turno. "Ver mis ganancias" lleva a la
 * pestaña Ganancias; "Listo" vuelve al dashboard (ya fuera de turno).
 *
 * DATOS:
 *  - Ganado hoy / nº de viajes / propinas → REALES, de `GET /earnings/breakdown` (`today`, agregado sobre
 *    cobros CAPTURED de payment-service). Mientras carga → skeleton; si falla → "—" honesto (no S/ 0.00).
 *  - Duración del turno → reloj LOCAL: el backend no expone `startedAt`, así que se mide desde la marca
 *    sellada al abrir turno (`shiftStartedAt`). Si no hay marca (turno viejo / marca perdida) → "—".
 *  - Recorrido (km) → el backend no lo expone hoy → "—" (degradación honesta, como en TripComplete),
 *    nunca un valor inventado.
 */
export const ShiftSummaryScreen = ({ navigation, route }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { shiftStartedAt } = route.params;

  const breakdown = useEarningsBreakdown();
  const today = breakdown.data?.today;

  // "Ahora" se congela al montar: el resumen es una foto del cierre, no un contador vivo.
  const durationMinutes = useMemo(
    () => (shiftStartedAt != null ? shiftElapsedMinutes(shiftStartedAt, Date.now()) : null),
    [shiftStartedAt],
  );

  // U2 · dedup: la DURACIÓN la porta la stat "En turno" de la grilla — el subtítulo queda como cierre
  // cálido, sin repetir el dato.
  const subtitle = t('shift.summary.subtitle');

  const earnedText = today ? formatPEN(today.netCents) : null;
  const tripsText = today ? String(today.tripCount) : NO_DATA;
  const tipsText = today ? formatPEN(today.tipCents) : NO_DATA;
  const durationText = durationMinutes != null ? formatShiftDurationShort(durationMinutes) : NO_DATA;

  const goToEarnings = (): void => navigation.navigate('Main', { screen: 'Ganancias' });
  const goHome = (): void => navigation.navigate('Main', { screen: 'Inicio' });

  return (
    <SafeScreen>
      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <Appear style={styles.hero}>
          <View
            style={[
              styles.badge,
              {
                backgroundColor: `${theme.colors.brand}26`,
                borderColor: theme.colors.brand,
                shadowColor: theme.colors.brand,
              },
            ]}
          >
            <IconFlag size={36} color={theme.colors.brand} strokeWidth={2} />
          </View>
          <Text variant="titleEditorial" align="center">
            {t('shift.summary.title')}
          </Text>
          <Text variant="footnote" color="inkSubtle" align="center">
            {subtitle}
          </Text>
        </Appear>

        <Appear delay={80}>
          <View
            style={[
              styles.earn,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                // frame $r-xl = 20 → token `lg` del ui-kit (la escala de radios difiere del .pen).
                borderRadius: theme.radii.lg,
              },
            ]}
          >
            <Text variant="label" color="inkSubtle">
              {t('shift.summary.earnedLabel')}
            </Text>
            {earnedText ? (
              <Text variant="display" color="success" tabular>
                {earnedText}
              </Text>
            ) : breakdown.isLoading ? (
              <Skeleton width={180} height={44} radius={theme.radii.sm} />
            ) : (
              <Text variant="display" color="inkSubtle" tabular>
                {NO_DATA}
              </Text>
            )}
          </View>
        </Appear>

        <Appear delay={140} style={styles.grid}>
          <View style={styles.gridRow}>
            <StatCell
              icon={IconCar}
              value={tripsText}
              label={t('shift.summary.stats.trips')}
              loading={breakdown.isLoading && !today}
            />
            <StatCell
              icon={IconClock}
              value={durationText}
              label={t('shift.summary.stats.online')}
            />
          </View>
          <View style={styles.gridRow}>
            <StatCell
              icon={IconRoute}
              value={NO_DATA}
              label={t('shift.summary.stats.distance')}
            />
            <StatCell
              icon={IconCoins}
              value={tipsText}
              label={t('shift.summary.stats.tips')}
              loading={breakdown.isLoading && !today}
            />
          </View>
        </Appear>

        <View style={styles.grow} />

        <Appear delay={200} style={styles.actions}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('shift.summary.viewEarnings')}
            onPress={goToEarnings}
            style={[
              styles.cta,
              { backgroundColor: theme.colors.brand, borderRadius: theme.radii.pill },
            ]}
          >
            <Text variant="bodyStrong" color="onBrand">
              {t('shift.summary.viewEarnings')}
            </Text>
          </PressableScale>

          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('shift.summary.done')}
            onPress={goHome}
            style={styles.ghost}
          >
            <Text variant="subhead" color="inkMuted">
              {t('shift.summary.done')}
            </Text>
          </PressableScale>
        </Appear>
      </ScrollView>
    </SafeScreen>
  );
};

interface StatCellProps {
  icon: (props: IconProps) => React.JSX.Element;
  value: string;
  label: string;
  loading?: boolean;
}

/**
 * Celda de estadística del grid 2×2: disco con ícono + valor (display) + etiqueta. Ocupa medio ancho
 * (`flex:1`); las dos celdas de una fila comparten el `gap`. Muestra un skeleton fino en el valor mientras
 * el desglose carga (solo para las métricas que dependen del backend).
 */
function StatCell({ icon: Icon, value, label, loading = false }: StatCellProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.cell,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          // frame $r-lg = 16 → token `md` del ui-kit.
          borderRadius: theme.radii.md,
        },
      ]}
    >
      <View style={[styles.cellIcon, { backgroundColor: theme.colors.divider }]}>
        <Icon size={17} color={theme.colors.inkMuted} strokeWidth={2} />
      </View>
      <View style={styles.cellText}>
        {loading ? (
          <Skeleton width={40} height={17} radius={theme.radii.sm} />
        ) : (
          <Text variant="title3" style={styles.cellValue} tabular numberOfLines={1}>
            {value}
          </Text>
        )}
        <Text variant="caption" color="inkSubtle" numberOfLines={1}>
          {label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flexGrow: 1, gap: 20, paddingTop: 16, paddingBottom: 20 },
  hero: { gap: 12, alignItems: 'center', paddingTop: 8 },
  badge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    // Halo de marca simétrico (glow azul), sin offset — el "brand glow" del frame.
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 12,
  },
  earn: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 2,
    padding: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  grid: { gap: 12 },
  gridRow: { flexDirection: 'row', gap: 12 },
  cell: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cellIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellText: { flex: 1, gap: 1 },
  cellValue: { fontSize: 17, lineHeight: 22 },
  grow: { flex: 1, minHeight: 12 },
  actions: { gap: 4 },
  cta: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  ghost: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
});
