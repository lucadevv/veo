import type {MobileVehicleType} from '@veo/api-client';
import {Text} from '@veo/ui-kit';
import React from 'react';
import {offeringGlyph} from '../../../../shared/presentation/components/offeringGlyphs';

/**
 * Glifo del tipo de vehículo de una opción de tarifa. ADR 013 §1.6 (UI data-driven): emoji y tono
 * salen del registro token→glyph de la app, resuelto desde el `icon` del quote cuando viene
 * (additive; token desconocido → fallback explícito a auto) o desde la clase de vehículo para
 * quotes de server viejo sin `icon`. El tono (lima para moto, tinta para auto) refuerza la
 * distinción visual entre tiers y es del registro, no del consumidor.
 */
export function VehicleIcon({
  icon,
  vehicleType,
  color,
}: {
  /** Token de ícono de la opción (`options[].icon`, ADR 013 additive). Ausente en server viejo. */
  icon?: string;
  /** Clase de vehículo de la opción: fallback para datos que NO traen `icon`. */
  vehicleType: MobileVehicleType;
  /** Override del tono; por defecto, el del registro de glyphs. */
  color?: React.ComponentProps<typeof Text>['color'];
}): React.JSX.Element {
  const glyph = offeringGlyph({icon, vehicleType});
  return (
    <Text
      variant="title3"
      color={color ?? glyph.tone}
      accessibilityElementsHidden
      importantForAccessibility="no">
      {glyph.emoji}
    </Text>
  );
}
