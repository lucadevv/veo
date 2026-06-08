import type { MobileVehicleType } from '@veo/api-client';
import { Text } from '@veo/ui-kit';
import React from 'react';

/**
 * Glifo del tipo de vehículo de una opción de tarifa (Ola 2B · tier moto-taxi). El color lo aporta
 * el consumidor (lima para MOTO, tinta para CAR) para reforzar la distinción visual entre tiers.
 */
export function VehicleIcon({
  vehicleType,
  color = 'ink',
}: {
  vehicleType: MobileVehicleType;
  color?: React.ComponentProps<typeof Text>['color'];
}): React.JSX.Element {
  return (
    <Text variant="title3" color={color} accessibilityElementsHidden importantForAccessibility="no">
      {vehicleType === 'MOTO' ? '🏍️' : '🚗'}
    </Text>
  );
}
