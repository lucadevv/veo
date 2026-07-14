import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text, useTheme } from '@veo/ui-kit';
import { IconManeuver, type ManeuverGlyphName } from '../../../../shared/presentation/icons';
import {
  arriveRoadName,
  formatManeuverDistance,
  maneuverGlyph,
  type TripRouteStep,
} from '../../domain';

export interface ManeuverBannerProps {
  /** Próxima maniobra a anunciar (derivada por `upcomingManeuver` del dominio). */
  step: TripRouteStep;
  /** Distancia a la maniobra — VIVA (conductor→punto de maniobra por GPS), no el largo del tramo. */
  distanceMeters: number;
  /** Cuántos pasos quedan en total (para el contador "1 de N"). Opcional. */
  remaining?: number;
  /**
   * `true` con el pasajero a bordo (IN_PROGRESS): el `arrive` del tramo es el destino REAL. Antes
   * (ACCEPTED/ARRIVING), el "destino" de la ruta es el punto de RECOJO — el copy genérico del
   * contrato ("Has llegado a tu destino") confunde, así que el banner lo reemplaza por fase.
   */
  onboard?: boolean;
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
  onboard = false,
}: ManeuverBannerProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const glyph: ManeuverGlyphName = maneuverGlyph(step.maneuver);

  // El `arrive` lleva copy PROPIO por fase (la instrucción del contrato dice "destino" también
  // yendo al recojo); la vía se rescata de la instrucción armada porque el contrato no la trae suelta.
  let instruction = step.instruction;
  if (step.maneuver === 'arrive') {
    const road = arriveRoadName(step.instruction);
    const base = onboard ? 'trips.maneuver.arriveDropoff' : 'trips.maneuver.arrivePickup';
    instruction = road ? t(`${base}Road`, { road }) : t(base);
  }

  return (
    <View
      accessibilityRole="header"
      accessibilityLabel={`${formatManeuverDistance(distanceMeters)}. ${instruction}`}
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
          {instruction}
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
