import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';
import { IconTrips } from '../../../../shared/presentation/icons';
import { Appear, Pulse } from './motion';

export interface TripsEmptyStateProps {
  /** Titular honesto del estado vacío. */
  title: string;
  /** Texto de apoyo (muted) explicando por qué aún no hay viajes. */
  description: string;
}

/**
 * Estado vacío premium para el historial de viajes (Midnight Motion).
 *
 * HONESTO POR DISEÑO: el driver-bff aún no expone `GET /trips` (historial), así que NO se
 * inventan viajes de ejemplo. Se centra un ícono grande en un círculo de superficie con un
 * halo de acento cian ornamental, el titular y un texto muted.
 */
export function TripsEmptyState({ title, description }: TripsEmptyStateProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.container}>
      {/* Halo de acento (ornamental) que respira detrás del ícono. */}
      <Appear style={styles.iconWrap} distance={6}>
        <Pulse
          active
          period={2600}
          minOpacity={theme.scheme === 'dark' ? 0.06 : 0.04}
          maxOpacity={theme.scheme === 'dark' ? 0.16 : 0.1}
          maxScale={1.12}
          style={[styles.halo, { backgroundColor: theme.colors.accent }]}
        >
          {null}
        </Pulse>
        <View
          style={[
            styles.iconCircle,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
            },
          ]}
        >
          <IconTrips size={44} color={theme.colors.accent} strokeWidth={1.75} />
        </View>
      </Appear>

      <Appear delay={90} distance={8}>
        <Text variant="title3" align="center" style={{ marginTop: theme.spacing['2xl'] }}>
          {title}
        </Text>
      </Appear>
      <Appear delay={150} distance={8}>
        <Text
          variant="callout"
          color="inkMuted"
          align="center"
          style={[styles.description, { marginTop: theme.spacing.sm }]}
        >
          {description}
        </Text>
      </Appear>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 48 },
  iconWrap: { alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: 140, height: 140, borderRadius: 999 },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  description: { maxWidth: 300 },
});
