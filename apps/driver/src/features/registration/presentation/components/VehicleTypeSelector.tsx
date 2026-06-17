import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Text, useTheme, useReducedMotion } from '@veo/ui-kit';
import { useTranslation } from 'react-i18next';
import { VehicleClass } from '@veo/shared-types';
import { IconCar, IconMoto } from '../../../../shared/presentation/icons';
import type { VehicleType } from '../../domain';

interface VehicleTypeSelectorProps {
  value: VehicleType;
  onChange: (type: VehicleType) => void;
}

/** Presentación de una clase en el alta: etiqueta propia del wizard + glyph + orden (Moto primero). */
interface VehicleClassOption {
  labelKey: string;
  Icon: typeof IconCar;
  sortOrder: number;
}

/**
 * Registro EXHAUSTIVO clase→presentación (ADR 013 §1.6): agregar una `VehicleClass` al catálogo
 * exige su entrada acá (no compila sin ella) y la tarjeta aparece sola en el selector.
 */
const VEHICLE_CLASS_OPTIONS: Record<VehicleClass, VehicleClassOption> = {
  [VehicleClass.MOTO]: { labelKey: 'registration.vehicle.typeMoto', Icon: IconMoto, sortOrder: 0 },
  [VehicleClass.CAR]: { labelKey: 'registration.vehicle.typeCar', Icon: IconCar, sortOrder: 1 },
};

/** Clases en orden de presentación del alta (Moto primero, como el flujo histórico). */
const ORDERED_CLASSES: readonly VehicleClass[] = Object.values(VehicleClass).sort(
  (a, b) => VEHICLE_CLASS_OPTIONS[a].sortOrder - VEHICLE_CLASS_OPTIONS[b].sortOrder,
);

interface OptionProps {
  type: VehicleType;
  label: string;
  selected: boolean;
  onPress: () => void;
  icon: (color: string) => React.ReactNode;
}

/** Tarjeta de tipo de vehículo: anima borde, fondo y glow cian al seleccionarse. */
function Option({ label, selected, onPress, icon }: OptionProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(selected ? 1 : 0);

  useEffect(() => {
    const target = selected ? 1 : 0;
    progress.value = reduced
      ? withTiming(target, { duration: theme.motion.duration.fast })
      : withTiming(target, {
          duration: theme.motion.duration.base,
          easing: Easing.bezier(...theme.motion.easing.standard),
        });
  }, [selected, progress, reduced, theme]);

  const cardStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(
      progress.value,
      [0, 1],
      [theme.colors.border, theme.colors.accent],
    ),
    // Glow cian sutil del seleccionado (sombra de color, no borde+sombra decorativo doble).
    shadowOpacity: progress.value * 0.55,
    shadowRadius: 6 + progress.value * 12,
    transform: [{ scale: 1 + progress.value * 0.01 }],
  }));

  const iconColor = selected ? theme.colors.accent : theme.colors.inkMuted;

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.flex}
    >
      <Animated.View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.lg,
            borderWidth: 2,
            shadowColor: theme.colors.accent,
            shadowOffset: { width: 0, height: 0 },
            gap: theme.spacing.md,
          },
          cardStyle,
        ]}
      >
        {icon(iconColor)}
        <Text variant="bodyStrong" color={selected ? 'ink' : 'inkMuted'}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

/**
 * Selector segmentado de tipo de vehículo, data-driven desde el enum canónico `VehicleClass`
 * (ADR 013 §1.6): itera el registro en vez de chips hardcodeados. Una sola selección (rol
 * radiogroup); la tarjeta activa se resalta con borde y glow cian animados, respetando reduce-motion.
 */
export function VehicleTypeSelector({
  value,
  onChange,
}: VehicleTypeSelectorProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  return (
    <View accessibilityRole="radiogroup" style={[styles.row, { gap: theme.spacing.lg }]}>
      {ORDERED_CLASSES.map((vehicleClass) => {
        const { labelKey, Icon } = VEHICLE_CLASS_OPTIONS[vehicleClass];
        return (
          <Option
            key={vehicleClass}
            type={vehicleClass}
            label={t(labelKey)}
            selected={value === vehicleClass}
            onPress={() => onChange(vehicleClass)}
            icon={(color) => <Icon size={44} color={color} strokeWidth={1.8} />}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignSelf: 'stretch' },
  flex: { flex: 1 },
  card: { alignItems: 'center', justifyContent: 'center', paddingVertical: 28, elevation: 0 },
});
