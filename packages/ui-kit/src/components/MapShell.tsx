import { type ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { StatusPill } from './StatusPill';
import { Text } from './Text';

export interface MapShellProps {
  /** El mapa real (react-native-maps / MapLibre) que la app inyecta. */
  children?: ReactNode;
  /** Muestra estado de carga (placeholder) sobre el área del mapa. */
  loading?: boolean;
  /** Indicador "EN VIVO" pulsante (arriba a la izquierda). */
  live?: boolean;
  /** Slot superpuesto superior (botones flotantes, búsqueda). */
  topOverlay?: ReactNode;
  /** Slot superpuesto inferior (resumen del viaje, controles). */
  bottomOverlay?: ReactNode;
  /** Redondea las esquinas del contenedor del mapa. */
  rounded?: boolean;
  style?: ViewStyle;
}

/**
 * Contenedor del mapa: enmarca el lienzo (el mapa lo provee la app), gestiona estado de carga
 * y expone slots superpuestos sin que el contenido quede bajo el chrome del SO (combinar con
 * SafeScreen). El mapa es el héroe; los overlays respiran.
 */
export function MapShell({
  children,
  loading = false,
  live = false,
  topOverlay,
  bottomOverlay,
  rounded = false,
  style,
}: MapShellProps) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderRadius: rounded ? theme.radii.lg : 0,
        },
        style,
      ]}
    >
      <View style={styles.fill}>{children}</View>

      {loading ? (
        <View style={[styles.center, { backgroundColor: theme.colors.surfaceElevated }]} pointerEvents="none">
          <Text variant="subhead" color="inkMuted">
            Cargando mapa…
          </Text>
        </View>
      ) : null}

      {live ? (
        <View style={styles.live} pointerEvents="box-none">
          <StatusPill label="EN VIVO" tone="accent" live />
        </View>
      ) : null}

      {topOverlay ? (
        <View style={styles.top} pointerEvents="box-none">
          {topOverlay}
        </View>
      ) : null}

      {bottomOverlay ? (
        <View style={styles.bottom} pointerEvents="box-none">
          {bottomOverlay}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
  fill: { ...StyleSheet.absoluteFillObject },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  live: { position: 'absolute', top: 12, left: 12 },
  top: { position: 'absolute', top: 12, left: 12, right: 12 },
  bottom: { position: 'absolute', left: 12, right: 12, bottom: 12 },
});
