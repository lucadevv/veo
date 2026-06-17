import { create } from 'zustand';
import { prefsStore, type KeyValueStore } from '../../../../core/storage/mmkv';
import { PrefKey } from '../../../../core/storage/keys';
import { DEFAULT_VEHICLE_TYPE, parseVehicleType, type VehicleType } from '../../domain';

/**
 * Tipo de vehículo activo del conductor (Auto | Moto), persistido en preferencias (MMKV).
 *
 * Es estado de sesión/UI en vivo, no estado de servidor: vive en Zustand y se hidrata al arrancar
 * desde `prefsStore`. El publisher de GPS lo lee con `getState()` para sellar cada reporte de
 * ubicación con el `vehicleType` correcto (así el dispatch indexa al conductor y le ofrece MOTO).
 */
export interface VehicleTypeState {
  vehicleType: VehicleType;
  /** Cambia el tipo activo y lo persiste en preferencias. */
  setVehicleType(type: VehicleType): void;
}

/** Lee el tipo persistido (o el default) desde un almacén de preferencias. */
export function readPersistedVehicleType(store: KeyValueStore): VehicleType {
  return parseVehicleType(store.getString(PrefKey.VehicleType));
}

export const useVehicleTypeStore = create<VehicleTypeState>((set) => ({
  vehicleType: readPersistedVehicleType(prefsStore),
  setVehicleType: (type) => {
    prefsStore.setString(PrefKey.VehicleType, type);
    set({ vehicleType: type });
  },
}));

/**
 * Lee el tipo de vehículo activo SIN suscribirse a React (uso fuera de render, p. ej. el publisher
 * de GPS). Cae al default si el store aún no se hidrató.
 */
export function currentVehicleType(): VehicleType {
  return useVehicleTypeStore.getState().vehicleType ?? DEFAULT_VEHICLE_TYPE;
}
