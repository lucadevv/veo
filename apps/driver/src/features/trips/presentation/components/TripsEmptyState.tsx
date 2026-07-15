import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';
import { IconTrips } from '../../../../shared/presentation/icons';
import { Appear } from './motion';

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
 * inventan viajes de ejemplo. Se centra un ícono grande y neutro en un disco gris, el titular
 * y un texto muted. Diseño calmo/estático: sin halo animado.
 */
export function TripsEmptyState({ title, description }: TripsEmptyStateProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.container}>
      <Appear style={styles.iconWrap} distance={6}>
        <View
          style={[
            styles.iconCircle,
            {
              // Disco gris recesado (surfaceMuted #EEF1F5): surface === #FFFFFF sería invisible sobre el fondo blanco.
              backgroundColor: theme.colors.surfaceMuted,
              borderColor: theme.colors.border,
            },
          ]}
        >
          <IconTrips size={44} color={theme.colors.inkMuted} strokeWidth={1.75} />
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
