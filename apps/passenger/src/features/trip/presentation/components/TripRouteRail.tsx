import { Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { StyleSheet, View } from 'react-native';

export interface TripRouteRailProps {
  /** Texto del extremo de ORIGEN (hora de salida, o etiqueta de punto si se conoce). */
  origin: string;
  /** Texto del extremo de DESTINO (distancia·duración, o etiqueta de punto si se conoce). */
  destination: string;
  /** Secundario bajo el origen (p. ej. coordenada), opcional. */
  originHint?: string;
  /** Secundario bajo el destino (p. ej. coordenada), opcional. */
  destinationHint?: string;
}

/**
 * Riel origen → destino del DS: un punto-anillo (origen) y un punto sólido (destino) unidos por una
 * línea vertical. Es el patrón canónico de ruta de la app (mismo lenguaje que `RoutePin`/el mapa),
 * traído a la lista y al detalle para que un viaje se LEA como un trayecto, no como una fila de datos.
 *
 * HONESTIDAD: el snapshot del viaje guarda origen/destino como coordenadas, sin nombre de calle. No
 * inventamos direcciones; el riel transporta lo que SÍ es real (hora de salida, distancia, duración)
 * y, si existe, la coordenada como pista discreta. La forma del trayecto la da el riel, no un texto falso.
 */
export function TripRouteRail({
  origin,
  destination,
  originHint,
  destinationHint,
}: TripRouteRailProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.root}>
      <View style={styles.rail} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={[styles.originDot, { borderColor: theme.colors.brand }]} />
        <View style={[styles.line, { backgroundColor: theme.colors.border }]} />
        <View style={[styles.destDot, { backgroundColor: theme.colors.ink }]} />
      </View>
      <View style={styles.labels}>
        <View style={styles.endpoint}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {origin}
          </Text>
          {originHint ? (
            <Text variant="caption" color="inkSubtle" numberOfLines={1} tabular>
              {originHint}
            </Text>
          ) : null}
        </View>
        <View style={[styles.endpoint, styles.destEndpoint]}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {destination}
          </Text>
          {destinationHint ? (
            <Text variant="caption" color="inkSubtle" numberOfLines={1} tabular>
              {destinationHint}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const DOT = 11;

const styles = StyleSheet.create({
  root: { flexDirection: 'row', gap: 12 },
  rail: { width: DOT, alignItems: 'center', paddingTop: 5 },
  originDot: { width: DOT, height: DOT, borderRadius: DOT / 2, borderWidth: 2.5 },
  line: { width: 2, flex: 1, marginVertical: 3, minHeight: 18 },
  destDot: { width: DOT, height: DOT, borderRadius: 2 },
  labels: { flex: 1, justifyContent: 'space-between', gap: 14 },
  endpoint: { gap: 1 },
  destEndpoint: {},
});
