import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  ACTIVE_VEHICLE_QUERY_KEY,
  REGISTRATION_VEHICLES_QUERY_KEY,
} from '../../../registration/domain';

/**
 * Hooks FINOS del catálogo/vehículo activo del conductor que consume el TURNO (selector de vehículo,
 * pill del header). Envuelven el `RegistrationRepository` (inyectado por DI) sobre las claves
 * COMPARTIDAS de `registration/domain`: MISMO cache que `registration/presentation` (coherente), SIN
 * importar sus hooks internos (feature-isolation).
 */

/** Query: vehículos del conductor (`GET /drivers/vehicles`). */
export function useDriverVehicles() {
  const { registration } = useRepositories();
  return useQuery({
    queryKey: REGISTRATION_VEHICLES_QUERY_KEY,
    queryFn: () => registration.listVehicles(),
  });
}

/**
 * Query: vehículo ACTIVO (el que el conductor opera) — `GET /drivers/active-vehicle`. `null` si no
 * tiene ninguno operable. Fuente de verdad del tipo (server-authoritative).
 */
export function useActiveVehicle() {
  const { registration } = useRepositories();
  return useQuery({
    queryKey: ACTIVE_VEHICLE_QUERY_KEY,
    queryFn: () => registration.getActiveVehicle(),
  });
}

/**
 * Mutación: selecciona el vehículo ACTIVO (`PATCH /drivers/active-vehicle`). Server-authoritative. Al
 * éxito invalida el activo y la lista (cambia `isActive`).
 */
export function useSetActiveVehicle() {
  const { registration } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vehicleId: string) => registration.setActiveVehicle(vehicleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ACTIVE_VEHICLE_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: REGISTRATION_VEHICLES_QUERY_KEY });
    },
  });
}
