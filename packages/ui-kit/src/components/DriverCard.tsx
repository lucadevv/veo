import { useId, useState, type ReactNode } from 'react';
import { Image, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { useTheme } from '../theme/ThemeProvider';
import { StarGlyph } from './internal/StarGlyph';
import { Text } from './Text';

/** Cantidad de estrellas de la escala de rating. */
const STAR_SCALE = 5;
/** Lado del avatar (design/veo.pen z2MKq · DriverCard · Avatar = 56). */
const AVATAR = 56;

export interface DriverCardProps {
  /** Nombre del conductor. */
  name: string;
  /**
   * Sello de VERIFICADO junto al nombre (design/veo.pen z2MKq · círculo `success` + check blanco): el
   * conductor pasó el background check. El consumidor lo deriva del contrato (no se asume).
   */
  verified?: boolean;
  /** Etiqueta accesible del sello (p. ej. "Conductor verificado"); el glyph es decorativo. */
  verifiedLabel?: string;
  /** Calificación (0–5): rellena las estrellas (redondeada) y, sin `ratingText`, se muestra como número. */
  rating?: number;
  /**
   * Línea de rating YA compuesta por el consumidor con i18n ("4.9 · 1,890 viajes", design z2MKq). Se
   * separa de `rating` para que el conteo de viajes (real, del contrato) y su copy vivan en la app, no
   * en el ui-kit. Sin `ratingText` se cae al número `rating.toFixed(1)`. Si el conductor NO tiene rating
   * (`rating` undefined) PERO se pasa `ratingText` (p. ej. "Conductor nuevo"), la línea se muestra SIN
   * estrellas — así un conductor sin calificaciones no queda en blanco (degradación honesta).
   */
  ratingText?: string;
  /** Vehículo (p. ej. "Toyota Yaris · Plata"). */
  vehicle?: string;
  /** Placa (etiqueta tipo matrícula: monoespaciada, tracking). */
  plate?: string;
  /** Foto del conductor; sin ella, el avatar es el gradiente verde con iniciales. */
  avatarUri?: string;
  /**
   * Slot inferior OPCIONAL (bajo la placa, con su divisor): para componer la MISMA identidad canónica con
   * un bloque de precio + acción — el caso de la OFERTA de PUJA (el pasajero ve la card del conductor que
   * ofertó y su precio/CTA). FIXED no lo pasa → la card queda idéntica a antes (backward-compatible).
   */
  footer?: ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
}

/** Iniciales (hasta 2) del nombre para el fallback del avatar. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join('');
}

/**
 * Tarjeta del conductor asignado (design/veo.pen z2MKq · DriverCard). Layout VERTICAL:
 *  · Fila superior — avatar (gradiente verde de confianza + iniciales, o la foto) · nombre + sello
 *    verificado · estrellas + "4.9 · N viajes".
 *  · Divisor sutil.
 *  · Fila inferior — vehículo (izq.) ↔ placa en matrícula monoespaciada (der.).
 * Presentacional; degrada campo a campo (sin rating no hay estrellas; sin vehículo/placa no hay divisor).
 * El VERDE sale de los tokens `successText`→`success`: en el conductor es el verde exacto del board
 * (#00873A→#00C853), en el pasajero el jade de su identidad. Cero color crudo.
 */
export function DriverCard({
  name,
  verified = false,
  verifiedLabel,
  rating,
  ratingText,
  vehicle,
  plate,
  avatarUri,
  footer,
  onPress,
  style,
}: DriverCardProps) {
  const theme = useTheme();
  // `useId()` trae dos puntos (`:r0:`) que son INVÁLIDOS como id de SVG / referencia `url(#…)`: se sanean.
  const gradientId = `driverAvatar-${useId().replace(/:/g, '')}`;
  const [imageFailed, setImageFailed] = useState(false);
  const showPhoto = Boolean(avatarUri) && !imageFailed;
  const filledStars = rating != null ? Math.round(rating) : 0;

  const content = (
    <>
      <View style={styles.top}>
        {/* Avatar: la foto real si la hay; si no, el círculo con gradiente verde de confianza + iniciales
            en blanco (design z2MKq · linear-gradient(-135°, successText → success)). */}
        <View style={styles.avatar}>
          {showPhoto ? (
            <Image
              accessibilityRole="image"
              accessibilityLabel={`Foto de ${name}`}
              source={{ uri: avatarUri }}
              onError={() => setImageFailed(true)}
              style={styles.avatarImage}
            />
          ) : (
            <>
              <Svg width={AVATAR} height={AVATAR} style={StyleSheet.absoluteFill}>
                <Defs>
                  <LinearGradient id={gradientId} x1="1" y1="0" x2="0" y2="1">
                    <Stop offset="0.15" stopColor={theme.colors.successText} />
                    <Stop offset="0.85" stopColor={theme.colors.success} />
                  </LinearGradient>
                </Defs>
                <Rect
                  width={AVATAR}
                  height={AVATAR}
                  rx={AVATAR / 2}
                  ry={AVATAR / 2}
                  fill={`url(#${gradientId})`}
                />
              </Svg>
              <View
                accessibilityRole="image"
                accessibilityLabel={`Avatar de ${name}`}
                style={[StyleSheet.absoluteFill, styles.center]}
              >
                {/* Iniciales BLANCAS sobre el verde (onBrand = blanco del DS, el texto sobre relleno saturado). */}
                <Text variant="title3" style={{ color: theme.colors.onBrand }}>
                  {initials(name)}
                </Text>
              </View>
            </>
          )}
        </View>

        <View style={styles.identity}>
          <View style={styles.nameRow}>
            <Text variant="headline" color="ink" numberOfLines={1} style={styles.name}>
              {name}
            </Text>
            {verified ? (
              <View
                accessibilityLabel={verifiedLabel}
                accessible={Boolean(verifiedLabel)}
                style={[styles.verified, { backgroundColor: theme.colors.success }]}
              >
                <Svg width={11} height={11} viewBox="0 0 24 24" fill="none">
                  <Path
                    d="M5 12.5l4.5 4.5L19 7"
                    stroke={theme.colors.surface}
                    strokeWidth={2.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </Svg>
              </View>
            ) : null}
          </View>
          {rating != null || ratingText ? (
            <View style={styles.ratingRow}>
              {rating != null ? (
                <View style={styles.stars}>
                  {Array.from({ length: STAR_SCALE }, (_, i) => (
                    <StarGlyph
                      key={i}
                      color={theme.colors.warn}
                      size={13}
                      filled={i < filledStars}
                    />
                  ))}
                </View>
              ) : null}
              <Text variant="footnote" color="inkMuted" tabular>
                {ratingText ?? rating?.toFixed(1)}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {vehicle || plate ? (
        <>
          <View style={[styles.divider, { backgroundColor: theme.colors.divider }]} />
          <View style={styles.plateRow}>
            {vehicle ? (
              <Text variant="footnote" color="inkMuted" numberOfLines={1} style={styles.vehicle}>
                {vehicle}
              </Text>
            ) : (
              <View />
            )}
            {plate ? (
              <View
                style={[
                  styles.plate,
                  {
                    backgroundColor: theme.colors.surfaceMuted,
                    borderColor: theme.colors.border,
                    borderRadius: theme.radii.sm,
                  },
                ]}
              >
                <Text
                  variant="footnote"
                  color="ink"
                  tabular
                  style={{ fontFamily: theme.typography.fontFamily.mono, letterSpacing: 1 }}
                >
                  {plate}
                </Text>
              </View>
            ) : null}
          </View>
        </>
      ) : null}
      {footer ? (
        <>
          <View style={[styles.divider, { backgroundColor: theme.colors.divider }]} />
          {footer}
        </>
      ) : null}
    </>
  );

  const surface: ViewStyle = {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radii.lg,
    padding: theme.spacing['2xl'],
    gap: theme.spacing.lg,
    ...theme.elevation.level2,
  };

  if (!onPress) {
    return <View style={[styles.card, surface, style]}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={onPress}
      style={({ pressed }) => [styles.card, surface, pressed ? { opacity: 0.9 } : null, style]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'column', alignSelf: 'stretch' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: { width: AVATAR, height: AVATAR },
  avatarImage: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2 },
  center: { alignItems: 'center', justifyContent: 'center' },
  identity: { flex: 1, gap: 4 },
  // Nombre + sello: misma línea; el nombre cede espacio, el sello no se aplasta.
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  name: { flexShrink: 1 },
  verified: {
    width: 19,
    height: 19,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stars: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  divider: { height: 1, alignSelf: 'stretch' },
  plateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  vehicle: { flexShrink: 1 },
  plate: { paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1 },
});
