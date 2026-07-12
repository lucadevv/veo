import type {MobileVehicleType} from '@veo/api-client';
import {useTheme} from '@veo/ui-kit';
import React from 'react';
import {offeringGlyph} from '../../../../shared/presentation/components/offeringGlyphs';

/**
 * Glifo del tipo de vehículo de una opción de tarifa. ADR 013 §1.6 (UI data-driven): el ícono y su
 * tono salen del registro token→glyph de la app, resuelto desde el `icon` del quote cuando viene
 * (additive; token desconocido → fallback explícito a auto) o desde la clase de vehículo para
 * quotes de server viejo sin `icon`. Renderiza el ícono de LÍNEA real del registro (car/moto), no un
 * emoji — fiel al diseño (design/veo.pen) y a la regla no-emoji. El tono (lima para moto, tinta para
 * auto) refuerza la distinción entre tiers y es del registro, no del consumidor.
 */
export function VehicleIcon({
  icon,
  vehicleType,
  color,
  size = 26,
}: {
  /** Token de ícono de la opción (`options[].icon`, ADR 013 additive). Ausente en server viejo. */
  icon?: string;
  /** Clase de vehículo de la opción: fallback para datos que NO traen `icon`. */
  vehicleType: MobileVehicleType;
  /** Override del color (ya resuelto); por defecto, el tono del registro de glyphs. */
  color?: string;
  /** Lado del recuadro del ícono (px). */
  size?: number;
}): React.JSX.Element {
  const theme = useTheme();
  const glyph = offeringGlyph({icon, vehicleType});
  const Icon = glyph.LineIcon;
  // El registro distingue la moto en lima de marca; los autos, en tinta.
  const toneColor = glyph.tone === 'brand' ? theme.colors.brand : theme.colors.ink;
  return <Icon color={color ?? toneColor} size={size} />;
}
