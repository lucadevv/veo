import {useMutation, useQuery} from '@tanstack/react-query';
import {useRepositories} from '../../../../core/di/useDi';
import {
  RegisterVehicleUseCase,
  UpdatePersonalDataUseCase,
  type PersonalData,
  type VehicleData,
} from '../../domain';

/** Clave de caché del listado de vehículos del conductor (rehidratación del paso de vehículo). */
export const REGISTRATION_VEHICLES_QUERY_KEY = ['registration', 'vehicles'] as const;

/**
 * Mutación: persiste los datos personales (`PATCH /drivers/me/personal`). Valida en cliente vía el
 * caso de uso (DNI 8 dígitos, fecha yyyy-mm-dd, nombre 1–120) antes de delegar en el repositorio
 * (abstracción `RegistrationRepository`). Lanza `PersonalDataValidationError` con errores por campo.
 */
export function useUpdatePersonalData() {
  const {registration} = useRepositories();
  return useMutation({
    mutationFn: (personal: PersonalData) =>
      new UpdatePersonalDataUseCase(registration).execute(personal),
  });
}

/**
 * Mutación: alta del vehículo (`POST /drivers/vehicles`). Valida en cliente vía el caso de uso
 * (placa, marca/modelo 1–60, año) antes de delegar en el repositorio. El vehículo queda
 * `PENDING_REVIEW`. Lanza `VehicleValidationError` con errores por campo.
 */
export function useRegisterVehicle() {
  const {registration} = useRepositories();
  return useMutation({
    mutationFn: (vehicle: VehicleData) =>
      new RegisterVehicleUseCase(registration).execute(vehicle),
  });
}

/**
 * Query: vehículos del conductor (`GET /drivers/vehicles`). Rehidrata el paso de vehículo para
 * mostrar el vehículo ya registrado y su estado (`status`/`docStatus`, p. ej. PENDING_REVIEW).
 */
export function useDriverVehicles() {
  const {registration} = useRepositories();
  return useQuery({
    queryKey: REGISTRATION_VEHICLES_QUERY_KEY,
    queryFn: () => registration.listVehicles(),
  });
}
