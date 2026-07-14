import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';
import { IconManeuver, type ManeuverGlyphName } from '../../../../shared/presentation/icons';
import { formatManeuverDistance, maneuverGlyph, type TripRouteStep } from '../../domain';

export interface ManeuverBannerProps {
  /** Próxima maniobra a anunciar (derivada por `upcomingManeuver` del dominio). */
  step: TripRouteStep;
  /** Distancia a la maniobra — VIVA (conductor→punto de maniobra por GPS), no el largo del tramo. */
  distanceMeters: number;
  /** Cuántos pasos quedan en total (para el contador "1 de N"). Opcional. */
  remaining?: number;
}

/**
 * Banner de la PRÓXIMA maniobra: lo que el conductor necesita de un vistazo. Ícono direccional
 * grande + distancia destacada + instrucción. Pensado para leerse sin distraerse del volante:
 * jerarquía clara (distancia protagonista en acento cian, instrucción de apoyo), alto contraste
 * sobre superficie elevada, una sola línea de instrucción truncada. Sin animación de entrada para
 * no parpadear al recalcular la ruta (respeta reduce-motion por defecto).
 */
export function ManeuverBanner({
  step,
  distanceMeters,
  remaining,
}: ManeuverBannerProps): React.JSX.Element {
  const theme = useTheme();
  const glyph: ManeuverGlyphName = maneuverGlyph(step.maneuver);

  return (
    <View
      accessibilityRole="header"
      accessibilityLabel={`${formatManeuverDistance(distanceMeters)}. ${step.instruction}`}
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.lg,
          gap: theme.spacing.lg,
          ...theme.elevation.level2,
        },
      ]}
    >
      <View
        style={[
          styles.iconWrap,
          { backgroundColor: theme.colors.brandDim, borderRadius: theme.radii.md },
        ]}
      >
        <IconManeuver glyph={glyph} size={36} color={theme.colors.accent} strokeWidth={2.2} />
      </View>
      <View style={styles.body}>
        <Text variant="title2" color="accent" tabular numberOfLines={1}>
          {formatManeuverDistance(distanceMeters)}
        </Text>
        <Text variant="callout" numberOfLines={2}>
          {step.instruction}
        </Text>
      </View>
      {remaining && remaining > 0 ? (
        <View
          style={[
            styles.counter,
            { backgroundColor: theme.colors.bg, borderRadius: theme.radii.pill },
          ]}
        >
          <Text variant="footnote" color="inkSubtle" tabular>
            {remaining}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth },
  iconWrap: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
  counter: {
    minWidth: 28,
    height: 28,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
