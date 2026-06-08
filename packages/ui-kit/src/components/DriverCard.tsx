import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { Avatar } from './Avatar';
import { StarGlyph } from './internal/StarGlyph';
import { Text } from './Text';

export interface DriverCardProps {
  /** Nombre del conductor. */
  name: string;
  /** Calificación (0–5), se muestra con estrella y un decimal. */
  rating?: number;
  /** Vehículo (p. ej. "Toyota Yaris · Blanco"). */
  vehicle?: string;
  /** Placa (se muestra en una etiqueta tipo matrícula, tabular). */
  plate?: string;
  /** ETA grande de llegada (p. ej. "3 min"). */
  eta?: string;
  /** Foto del conductor. */
  avatarUri?: string;
  onPress?: () => void;
  style?: ViewStyle;
}

/**
 * Tarjeta del conductor asignado: avatar circular + nombre + rating + vehículo/placa, con la ETA
 * destacada a la derecha. Presentacional. Superficie elevada con sombra de nivel 2.
 */
export function DriverCard({
  name,
  rating,
  vehicle,
  plate,
  eta,
  avatarUri,
  onPress,
  style,
}: DriverCardProps) {
  const theme = useTheme();

  const content = (
    <>
      <Avatar uri={avatarUri} name={name} size="lg" />
      <View style={styles.body}>
        <Text variant="title3" numberOfLines={1}>
          {name}
        </Text>
        {typeof rating === 'number' ? (
          <View style={styles.ratingRow}>
            <StarGlyph color={theme.colors.brand} size={13} />
            <Text variant="footnote" color="inkMuted" tabular>
              {rating.toFixed(1)}
            </Text>
          </View>
        ) : null}
        {vehicle ? (
          <Text variant="footnote" color="inkMuted" numberOfLines={1}>
            {vehicle}
          </Text>
        ) : null}
        {plate ? (
          <View
            style={[
              styles.plate,
              { backgroundColor: theme.colors.surfaceElevated, borderColor: theme.colors.border, borderRadius: theme.radii.sm },
            ]}
          >
            <Text variant="label" color="ink" tabular>
              {plate}
            </Text>
          </View>
        ) : null}
      </View>
      {eta ? (
        <View style={styles.eta}>
          <Text variant="title1" color="brand" tabular numberOfLines={1}>
            {eta}
          </Text>
          <Text variant="caption" color="inkSubtle">
            llega en
          </Text>
        </View>
      ) : null}
    </>
  );

  const surface: ViewStyle = {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.lg,
    padding: theme.spacing.lg,
    gap: theme.spacing.lg,
    ...theme.elevation.level2,
  };

  if (!onPress) {
    return <View style={[styles.row, surface, style]}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}${eta ? `, llega en ${eta}` : ''}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, surface, pressed ? { opacity: 0.9 } : null, style]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' },
  body: { flex: 1, gap: 2 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  plate: { alignSelf: 'flex-start', marginTop: 4, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  eta: { alignItems: 'flex-end', justifyContent: 'center' },
});
