import { IconButton, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { MAX_WAYPOINTS, type RoutePlace } from '../../domain/entities';
import { IconClose } from '../../../trip/presentation/components/icons';

export interface RoutePointsListProps {
  origin: RoutePlace | null;
  destination: RoutePlace | null;
  /** Paradas intermedias ordenadas (Ola 2B). */
  waypoints: RoutePlace[];
  onEditOrigin: () => void;
  onEditDestination: () => void;
  onEditWaypoint: (index: number) => void;
  onRemoveWaypoint: (index: number) => void;
  onAddWaypoint: () => void;
}

/**
 * Lista del trayecto: origen → paradas → destino. Cada punto es editable (toca para buscar otra
 * dirección) y las paradas se pueden quitar. El botón "+ Agregar parada" aparece hasta el máximo
 * del contrato (3). Conector vertical entre puntos (lenguaje de mapa, no sólo texto).
 */
export function RoutePointsList({
  origin,
  destination,
  waypoints,
  onEditOrigin,
  onEditDestination,
  onEditWaypoint,
  onRemoveWaypoint,
  onAddWaypoint,
}: RoutePointsListProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const canAdd = waypoints.length < MAX_WAYPOINTS;

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <PointRow
        dotColor={theme.colors.brand}
        label={origin?.title ?? t('waypoints.origin')}
        muted={!origin}
        showConnector
        onPress={onEditOrigin}
      />

      {waypoints.map((stop, index) => (
        <PointRow
          key={`stop-${index}`}
          dotColor={theme.colors.inkSubtle}
          label={stop.title.trim().length > 0 ? stop.title : t('waypoints.stopLabel', { index: index + 1 })}
          muted={stop.title.trim().length === 0}
          showConnector
          onPress={() => onEditWaypoint(index)}
          trailing={
            <IconButton
              accessibilityLabel={t('waypoints.remove')}
              variant="surface"
              size="sm"
              onPress={() => onRemoveWaypoint(index)}
              icon={<IconClose color={theme.colors.inkMuted} size={16} />}
            />
          }
        />
      ))}

      <PointRow
        dotColor={theme.colors.accent}
        label={destination?.title ?? t('waypoints.destination')}
        muted={!destination}
        onPress={onEditDestination}
      />

      {canAdd ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('waypoints.add')}
          onPress={onAddWaypoint}
          style={({ pressed }) => [
            styles.addRow,
            {
              opacity: pressed ? 0.6 : 1,
              paddingVertical: theme.spacing.sm,
              marginLeft: theme.spacing.xs,
            },
          ]}
        >
          <Text variant="subhead" color="brand">
            {t('waypoints.add')}
          </Text>
        </Pressable>
      ) : (
        <Text variant="footnote" color="inkSubtle" style={{ marginLeft: theme.spacing.xs }}>
          {t('waypoints.max')}
        </Text>
      )}
    </View>
  );
}

interface PointRowProps {
  dotColor: string;
  label: string;
  muted: boolean;
  showConnector?: boolean;
  onPress: () => void;
  trailing?: React.ReactNode;
}

function PointRow({
  dotColor,
  label,
  muted,
  showConnector,
  onPress,
  trailing,
}: PointRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <View style={styles.rail}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        {showConnector ? (
          <View style={[styles.connector, { backgroundColor: theme.colors.border }]} />
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => [
          styles.pressable,
          {
            backgroundColor: pressed ? theme.colors.surface : 'transparent',
            borderRadius: theme.radii.md,
            paddingVertical: theme.spacing.sm,
            paddingHorizontal: theme.spacing.sm,
          },
        ]}
      >
        <Text
          variant="body"
          color={muted ? 'inkSubtle' : 'ink'}
          numberOfLines={1}
          style={styles.label}
        >
          {label}
        </Text>
        {trailing}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'stretch', minHeight: 40 },
  rail: { width: 24, alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 14 },
  connector: { width: 2, flex: 1, marginTop: 2, marginBottom: -2 },
  pressable: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { flex: 1 },
  addRow: { alignSelf: 'flex-start' },
});
