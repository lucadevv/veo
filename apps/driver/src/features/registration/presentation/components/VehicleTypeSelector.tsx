import React, {useEffect} from 'react';
import {Pressable, StyleSheet, View} from 'react-native';
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {Text, useTheme, useReducedMotion} from '@veo/ui-kit';
import {useTranslation} from 'react-i18next';
import {IconCar, IconMoto} from '../../../../shared/presentation/icons';
import type {VehicleType} from '../../domain';

interface VehicleTypeSelectorProps {
  value: VehicleType;
  onChange: (type: VehicleType) => void;
}

interface OptionProps {
  type: VehicleType;
  label: string;
  selected: boolean;
  onPress: () => void;
  icon: (color: string) => React.ReactNode;
}

/** Tarjeta de tipo de vehículo: anima borde, fondo y glow cian al seleccionarse. */
function Option({label, selected, onPress, icon}: OptionProps): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(selected ? 1 : 0);

  useEffect(() => {
    const target = selected ? 1 : 0;
    progress.value = reduced
      ? withTiming(target, {duration: theme.motion.duration.fast})
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
    transform: [{scale: 1 + progress.value * 0.01}],
  }));

  const iconColor = selected ? theme.colors.accent : theme.colors.inkMuted;

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{selected}}
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.flex}>
      <Animated.View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.lg,
            borderWidth: 2,
            shadowColor: theme.colors.accent,
            shadowOffset: {width: 0, height: 0},
            gap: theme.spacing.md,
          },
          cardStyle,
        ]}>
        {icon(iconColor)}
        <Text variant="bodyStrong" color={selected ? 'ink' : 'inkMuted'}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

/**
 * Selector segmentado de tipo de vehículo (Moto / Auto). Una sola selección (rol radiogroup); la
 * tarjeta activa se resalta con borde y glow cian animados, respetando reduce-motion.
 */
export function VehicleTypeSelector({value, onChange}: VehicleTypeSelectorProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  return (
    <View accessibilityRole="radiogroup" style={[styles.row, {gap: theme.spacing.lg}]}>
      <Option
        type="MOTO"
        label={t('registration.vehicle.typeMoto')}
        selected={value === 'MOTO'}
        onPress={() => onChange('MOTO')}
        icon={color => <IconMoto size={44} color={color} strokeWidth={1.8} />}
      />
      <Option
        type="CAR"
        label={t('registration.vehicle.typeCar')}
        selected={value === 'CAR'}
        onPress={() => onChange('CAR')}
        icon={color => <IconCar size={44} color={color} strokeWidth={1.8} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignSelf: 'stretch'},
  flex: {flex: 1},
  card: {alignItems: 'center', justifyContent: 'center', paddingVertical: 28, elevation: 0},
});
