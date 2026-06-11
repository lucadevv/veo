import React from 'react';
import {
  MAP_GLYPH_DEFAULTS,
  offeringGlyph,
} from '../../../../shared/presentation/components/offeringGlyphs';
import type { NearbyVehicleType } from '../../domain/dispatchRepository';

/**
 * Vehículo de AMBIENTE visto DESDE ARRIBA (top-down) para el mapa del pasajero "Midnight Motion".
 * Dibujado con `react-native-svg`, color por prop, tamaño por prop — los tokens del DS son los
 * defaults (`MAP_GLYPH_DEFAULTS`), NUNCA hex inline.
 *
 * ADR 013 §1.6 (UI data-driven): la silueta sale del registro token→glyph de la app
 * (`offeringGlyphs`), no de un ternario por tipo. Sin `vehicleType` (ambiente sin dato) el registro
 * cae a su fallback EXPLÍCITO (auto, el default histórico del mapa).
 */

export interface VehicleIconProps {
  /** Tipo de vehículo: `CAR` (auto) o `MOTO` (moto-taxi). Ausente → fallback del registro (auto). */
  vehicleType?: NearbyVehicleType;
  /** Lado del recuadro (px). Default 30 (ambiente chico). */
  size?: number;
  /** Color del cuerpo. Default token lima de la ruta del pasajero. */
  bodyColor?: string;
  /** Color de los vidrios. Default fondo del lienzo (corte oscuro). */
  glassColor?: string;
}

/**
 * Ícono de vehículo de ambiente. Decorativo: el contenedor (el MarkerView del mapa) aporta el
 * etiquetado accesible si corresponde — acá no, porque es ambiente.
 */
export function VehicleIcon({
  vehicleType,
  size = MAP_GLYPH_DEFAULTS.size,
  bodyColor = MAP_GLYPH_DEFAULTS.bodyColor,
  glassColor = MAP_GLYPH_DEFAULTS.glassColor,
}: VehicleIconProps): React.JSX.Element {
  const { MapGlyph } = offeringGlyph({ vehicleType });
  return <MapGlyph size={size} bodyColor={bodyColor} glassColor={glassColor} />;
}
