import { useQuery } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import { ACTIVE_VEHICLE_QUERY_KEY } from '../../../registration/domain';

/**
 * Query FINA: vehículo ACTIVO del conductor, para prellenar la publicación de un carpool con su
 * vehículo/tipo. Envuelve el `RegistrationRepository` (inyectado por DI) sobre la clave COMPARTIDA
 * `ACTIVE_VEHICLE_QUERY_KEY` (registration/domain): MISMO cache que `registration/presentation`
 * (coherente), SIN importar sus hooks internos (feature-isolation).
 */
export function useActiveVehicle() {
  const { registration } = useRepositories();
  return useQuery({
    queryKey: ACTIVE_VEHICLE_QUERY_KEY,
    queryFn: () => registration.getActiveVehicle(),
  });
}
