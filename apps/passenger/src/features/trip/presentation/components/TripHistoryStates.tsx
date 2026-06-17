import { Button, hexAlpha, Skeleton, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { IconRoute } from './icons';

/**
 * Skeleton del historial: la SILUETA real de la fila (cabecera, riel, pie con tarifa), no un spinner
 * pelado ni barras genéricas. Reserva el mismo espacio que el contenido (anti-CLS) para que la carga
 * se sienta como "el contenido está llegando", no como "algo se rompió". Respeta reduce-motion (lo
 * hace el propio `Skeleton` del kit).
 */
export function TripHistorySkeleton(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ padding: theme.spacing.xl, gap: theme.spacing.md }} accessibilityLabel={undefined}>
      <Skeleton width="34%" height={14} radius={theme.radii.sm} style={{ marginBottom: theme.spacing.xs }} />
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={[
            styles.card,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border, borderRadius: theme.radii.lg, padding: theme.spacing.lg },
          ]}
        >
          <View style={styles.cardHeader}>
            <Skeleton width="42%" height={16} radius={theme.radii.sm} />
            <Skeleton width={84} height={22} radius={theme.radii.pill} />
          </View>
          <View style={styles.railRow}>
            <Skeleton variant="circle" height={11} />
            <Skeleton width="58%" height={14} radius={theme.radii.sm} />
          </View>
          <View style={styles.railRow}>
            <Skeleton variant="circle" height={11} />
            <Skeleton width="46%" height={14} radius={theme.radii.sm} />
          </View>
          <View style={[styles.cardFooter, { borderTopColor: theme.colors.border }]}>
            <Skeleton width={92} height={22} radius={theme.radii.sm} />
          </View>
        </View>
      ))}
    </View>
  );
}

export interface TripHistoryEmptyProps {
  onRequestRide: () => void;
}

/**
 * Vacío CON ALMA: un emblema de ruta (el lenguaje visual de la app, no un doodle genérico) sobre un
 * disco tintado de marca, copy VEO cálido en tuteo peruano, y un CTA que invita a pedir el primer
 * viaje. No confunde "vacío" con "cargando" (la pantalla decide explícitamente cuál mostrar).
 */
export function TripHistoryEmpty({ onRequestRide }: TripHistoryEmptyProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View style={[styles.empty, { padding: theme.spacing['3xl'], gap: theme.spacing.lg }]}>
      <View
        style={[
          styles.emblem,
          { backgroundColor: hexAlpha(theme.colors.brand, theme.scheme === 'dark' ? 0.18 : 0.1) },
        ]}
      >
        <IconRoute color={theme.colors.brand} size={36} />
      </View>
      <View style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
        <Text variant="title2" align="center">
          {t('history.emptyTitle')}
        </Text>
        <Text variant="callout" color="inkMuted" align="center" style={styles.emptyBody}>
          {t('history.emptyBody')}
        </Text>
      </View>
      <Button label={t('history.emptyCta')} variant="accent" onPress={onRequestRide} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, gap: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  railRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardFooter: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emblem: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center' },
  emptyBody: { maxWidth: 280 },
});
