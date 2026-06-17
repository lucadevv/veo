import type {GeoPoint} from '@veo/api-client';
import {useEffect, useState} from 'react';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {useRideDraftStore} from '../../../maps/presentation/stores/rideDraftStore';

export interface PickupPinController {
  /**
   * Centro INICIAL del mapa idle: se captura UNA vez (GPS) y NO se actualiza → un refresh de GPS no hace
   * snap-back que deshaga el pan del usuario (mismo patrón que MapPick). `null` hasta el primer fix.
   */
  initialCenter: GeoPoint | null;
  /** El AppMap reporta el centro VIVO al hacer pan (throttle interno 120ms). */
  onCenterChange: (center: GeoPoint) => void;
}

/**
 * MODELO CABIFY · recojo con PIN en el Home. En el Home idle el mapa es interactivo y un pin FIJO al
 * centro marca el RECOJO: arrastrás el mapa y el origen SIGUE al centro (reverse-geocode en vivo). Antes
 * el origen se clavaba al GPS sin forma de elegir el punto.
 *
 * @param enabled `pickupMode`: Home idle (no buscando, no en cotización/viaje) — lo compone la pantalla
 *   desde el descriptor de fase + el eje local del sheet.
 */
export function usePickupPin(
  enabled: boolean,
  myLocation: GeoPoint | null,
): PickupPinController {
  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const setOrigin = useRideDraftStore(s => s.setOrigin);

  // Centro VIVO que reporta el AppMap al hacer pan (throttle interno 120ms).
  const [pickupCenter, setPickupCenter] = useState<GeoPoint | null>(null);
  const [pickupInitial, setPickupInitial] = useState<GeoPoint | null>(null);
  useEffect(() => {
    if (!pickupInitial && myLocation) setPickupInitial(myLocation);
  }, [pickupInitial, myLocation]);

  // Debounce del centro → reverse-geocode → el origen sigue al pin. Solo en pickupMode. Degradación
  // honesta: si el reverse falla (red), se conserva el origen previo (no inventamos una dirección).
  useEffect(() => {
    if (!enabled || !pickupCenter) return;
    const id = setTimeout(() => {
      void reverseGeocode
        .execute({lat: pickupCenter.lat, lng: pickupCenter.lon})
        .then(place =>
          setOrigin({
            point: {lat: pickupCenter.lat, lng: pickupCenter.lon},
            title: place.title,
            subtitle: place.subtitle,
          }),
        )
        .catch(() => undefined);
    }, 350);
    return () => clearTimeout(id);
  }, [enabled, pickupCenter, reverseGeocode, setOrigin]);

  return {initialCenter: pickupInitial, onCenterChange: setPickupCenter};
}
