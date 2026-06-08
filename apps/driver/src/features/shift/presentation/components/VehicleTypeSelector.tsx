import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {Text, useTheme} from '@veo/ui-kit';
import {IconCar, IconMoto} from '../../../../shared/presentation/icons';
import {VEHICLE_TYPES, type VehicleType} from '../../domain';
import {useVehicleTypeStore} from '../state/vehicleTypeStore';
import {PressableScale} from './motion';

export interface VehicleTypeSelectorProps {
  /** Deshabilita el cambio (p. ej. con un viaje en curso). */
  disabled?: boolean;
}

const ICONS: Record<VehicleType, typeof IconCar> = {
  CAR: IconCar,
  MOTO: IconMoto,
};

/**
 * Selector segmentado Auto | Moto para declarar el tipo de vehículo ACTIVO del turno.
 *
 * El valor se persiste en preferencias (MMKV) y se propaga en el reporte de ubicación del socket
 * `/driver`; el dispatch lo usa para ofrecer viajes MOTO solo a motos. El color nunca es el único
 * indicador del estado activo: hay relleno de superficie, borde acento e ícono + etiqueta.
 */
export const VehicleTypeSelector = ({disabled = false}: VehicleTypeSelectorProps): React.JSX.Element => {
  const {t} = useTranslation();
  const theme = useTheme();
  const vehicleType = useVehicleTypeStore(s => s.vehicleType);
  const setVehicleType = useVehicleTypeStore(s => s.setVehicleType);

  return (
    <View>
      <Text variant="footnote" color="inkMuted">
        {t('shift.vehicleType.label')}
      </Text>
      <View
        accessibilityRole="radiogroup"
        style={[
          styles.track,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderRadius: theme.radii.pill,
            padding: theme.spacing.xxs,
            opacity: disabled ? 0.5 : 1,
          },
        ]}>
        {VEHICLE_TYPES.map(type => {
          const active = type === vehicleType;
          const Icon = ICONS[type];
          const labelColor = active ? theme.colors.onAccent : theme.colors.inkMuted;
          return (
            <PressableScale
              key={type}
              accessibilityRole="radio"
              accessibilityState={{selected: active, disabled}}
              accessibilityLabel={t(`shift.vehicleType.${type === 'CAR' ? 'car' : 'moto'}`)}
              disabled={disabled}
              onPress={() => setVehicleType(type)}
              style={[
                styles.segment,
                {
                  borderRadius: theme.radii.pill,
                  backgroundColor: active ? theme.colors.accent : 'transparent',
                },
              ]}>
              <Icon size={18} color={labelColor} />
              <Text variant="subhead" style={{color: labelColor}}>
                {t(`shift.vehicleType.${type === 'CAR' ? 'car' : 'moto'}`)}
              </Text>
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  track: {flexDirection: 'row', gap: 4, marginTop: 8},
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
  },
});
