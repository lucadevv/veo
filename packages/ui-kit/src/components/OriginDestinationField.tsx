import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { TOUCH_TARGET } from '../tokens/spacing';
import { MarkerGlyph } from './internal/MarkerGlyph';
import { Text } from './Text';

/** Un extremo del trayecto (origen o destino). */
export interface RouteEndpoint {
  /** Valor elegido (dirección). Si falta, se muestra el placeholder. */
  value?: string;
  placeholder?: string;
  onPress?: () => void;
  accessibilityLabel?: string;
}

export interface OriginDestinationFieldProps {
  origin: RouteEndpoint;
  destination: RouteEndpoint;
  style?: ViewStyle;
}

const DOT = 14;
const RAIL_WIDTH = 28;

/**
 * Segmento Origen → Destino con puntos lima y una línea conectora vertical. Dos filas
 * presionables (cada una abre su buscador). Presentacional: el consumidor maneja la navegación.
 */
export function OriginDestinationField({ origin, destination, style }: OriginDestinationFieldProps) {
  const theme = useTheme();

  const renderRow = (endpoint: RouteEndpoint, kind: 'origin' | 'destination') => {
    const hasValue = Boolean(endpoint.value);
    const isOrigin = kind === 'origin';
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={endpoint.accessibilityLabel ?? endpoint.value ?? endpoint.placeholder}
        onPress={endpoint.onPress}
        style={({ pressed }) => [
          styles.row,
          { minHeight: TOUCH_TARGET, borderRadius: theme.radii.sm },
          pressed ? { backgroundColor: theme.colors.surfaceElevated } : null,
        ]}
      >
        <View style={[styles.rail, { width: RAIL_WIDTH }]}>
          <MarkerGlyph kind={kind} size={DOT} />
        </View>
        <Text
          variant="bodyStrong"
          color={hasValue ? 'ink' : 'inkSubtle'}
          numberOfLines={1}
          style={styles.value}
        >
          {hasValue ? endpoint.value : (endpoint.placeholder ?? (isOrigin ? 'Punto de recogida' : '¿A dónde vamos?'))}
        </Text>
      </Pressable>
    );
  };

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          paddingVertical: theme.spacing.sm,
          paddingHorizontal: theme.spacing.md,
        },
        style,
      ]}
    >
      {/* Conector vertical entre el punto de origen y el de destino. */}
      <View
        pointerEvents="none"
        style={[
          styles.connector,
          { left: theme.spacing.md + RAIL_WIDTH / 2 - 1, backgroundColor: theme.colors.borderStrong },
        ]}
      />
      {renderRow(origin, 'origin')}
      <View style={[styles.divider, { backgroundColor: theme.colors.border, marginLeft: RAIL_WIDTH + theme.spacing.sm }]} />
      {renderRow(destination, 'destination')}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', borderWidth: 1, position: 'relative' },
  row: { flexDirection: 'row', alignItems: 'center' },
  rail: { alignItems: 'center', justifyContent: 'center' },
  value: { flex: 1 },
  divider: { height: StyleSheet.hairlineWidth },
  connector: { position: 'absolute', top: TOUCH_TARGET / 2, bottom: TOUCH_TARGET / 2, width: 2, borderRadius: 1 },
});
