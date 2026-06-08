import React, {useState} from 'react';
import {LayoutAnimation, Platform, Pressable, StyleSheet, UIManager, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {Text, useReducedMotion, useTheme} from '@veo/ui-kit';
import {
  IconChevronRight,
  IconManeuver,
  type ManeuverGlyphName,
} from '../../../../shared/presentation/icons';
import {metersToKm} from '../../../../shared/presentation/format';
import {formatManeuverDistance, maneuverGlyph, type TripRouteStep} from '../../domain';

// Habilita LayoutAnimation en Android (no-op en iOS / Fabric ya lo soporta).
if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export interface RouteStepsListProps {
  /** Pasos de la ruta en orden (incluye los ya recorridos si el server no los filtra). */
  steps: ReadonlyArray<TripRouteStep>;
  /** Distancia total de la ruta (m) para el encabezado. */
  totalDistanceMeters: number;
}

/**
 * Lista desplegable de los pasos de navegación de la ruta. Cerrada por defecto (el banner de la
 * próxima maniobra es lo prioritario); el conductor la abre para previsualizar el trayecto cuando
 * está detenido. La transición de despliegue usa `LayoutAnimation` (ease-out corto) y se degrada a
 * instantánea con reduce-motion. Cada fila: ícono de maniobra + instrucción + distancia.
 */
export function RouteStepsList({
  steps,
  totalDistanceMeters,
}: RouteStepsListProps): React.JSX.Element {
  const {t} = useTranslation();
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);

  const toggle = () => {
    if (!reduceMotion) {
      LayoutAnimation.configureNext({
        duration: 220,
        update: {type: LayoutAnimation.Types.easeInEaseOut},
        delete: {type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity},
        create: {type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity},
      });
    }
    setOpen(prev => !prev);
  };

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
        },
      ]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{expanded: open}}
        accessibilityLabel={t('navigation.stepsToggle', {count: steps.length})}
        onPress={toggle}
        style={({pressed}) => [styles.header, {opacity: pressed ? 0.85 : 1, padding: theme.spacing.lg}]}>
        <View style={styles.headerText}>
          <Text variant="subhead">{t('navigation.stepsTitle')}</Text>
          <Text variant="footnote" color="inkMuted" tabular>
            {t('navigation.stepsSummary', {
              count: steps.length,
              km: metersToKm(totalDistanceMeters),
            })}
          </Text>
        </View>
        <View style={[styles.chevron, open && styles.chevronOpen]}>
          <IconChevronRight size={18} color={theme.colors.inkSubtle} />
        </View>
      </Pressable>

      {open ? (
        <View style={[styles.list, {paddingBottom: theme.spacing.xs}]}>
          {steps.map((step, index) => (
            <StepRow
              key={`${index}-${step.maneuver}`}
              step={step}
              showDivider={index > 0}
            />
          ))}
          {steps.length === 0 ? (
            <Text variant="footnote" color="inkSubtle" style={styles.empty}>
              {t('navigation.stepsEmpty')}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

interface StepRowProps {
  step: TripRouteStep;
  showDivider: boolean;
}

/** Fila de un paso: ícono de maniobra + instrucción + distancia a recorrer hasta ese paso. */
function StepRow({step, showDivider}: StepRowProps): React.JSX.Element {
  const theme = useTheme();
  const glyph: ManeuverGlyphName = maneuverGlyph(step.maneuver);
  return (
    <View
      style={[
        styles.row,
        {paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md},
        showDivider && {borderTopColor: theme.colors.border, borderTopWidth: StyleSheet.hairlineWidth},
      ]}>
      <IconManeuver glyph={glyph} size={22} color={theme.colors.inkMuted} strokeWidth={2} />
      <Text variant="callout" style={styles.rowText} numberOfLines={2}>
        {step.instruction}
      </Text>
      <Text variant="footnote" color="inkSubtle" tabular>
        {formatManeuverDistance(step.distanceMeters)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden'},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12},
  headerText: {flex: 1, gap: 2},
  chevron: {transform: [{rotate: '90deg'}]},
  chevronOpen: {transform: [{rotate: '270deg'}]},
  list: {},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12},
  rowText: {flex: 1},
  empty: {paddingHorizontal: 16, paddingBottom: 12},
});
