import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  ACTIVE_VEHICLE_QUERY_KEY,
  REGISTRATION_VEHICLES_QUERY_KEY,
  RegisterVehicleUseCase,
  UpdatePersonalDataUseCase,
  type PersonalData,
  type VehicleData,
  type VehicleModelRequestInput,
  type VehicleType,
} from '../../domain';

// Las claves `REGISTRATION_VEHICLES_QUERY_KEY` y `ACTIVE_VEHICLE_QUERY_KEY` viven ahora en `domain`
// (cache compartido con turno/carpooling). Se re-exportan para no romper a los consumidores del barrel.
export { ACTIVE_VEHICLE_QUERY_KEY, REGISTRATION_VEHICLES_QUERY_KEY };

/**
 * Mutación: persiste los datos personales (`PATCH /drivers/me/personal`). Valida en cliente vía el
 * caso de uso (DNI 8 dígitos, fecha yyyy-mm-dd, nombre 1–120) antes de delegar en el repositorio
 * (abstracción `RegistrationRepository`). Lanza `PersonalDataValidationError` con errores por campo.
 */
export function useUpdatePersonalData() {
  const { registration } = useRepositories();
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
  const { registration } = useRepositories();
  return useMutation({
    mutationFn: (vehicle: VehicleData) => new RegisterVehicleUseCase(registration).execute(vehicle),
  });
}

/**
 * Query: vehículos del conductor (`GET /drivers/vehicles`). Rehidrata el paso de vehículo para
 * mostrar el vehículo ya registrado y su estado (`status`/`docStatus`, p. ej. PENDING_REVIEW).
 */
export function useDriverVehicles() {
  const { registration } = useRepositories();
  return useQuery({
    queryKey: REGISTRATION_VEHICLES_QUERY_KEY,
    queryFn: () => registration.listVehicles(),
  });
}

/** Clave de caché del catálogo de modelos (por tipo) para el selector del alta. */
export const VEHICLE_MODELS_QUERY_KEY = ['registration', 'vehicle-models'] as const;

/**
 * Query: catálogo de modelos APROBADOS por tipo (`GET /drivers/vehicle-models?vehicleType=`). Alimenta
 * el selector del alta (B5-2). El catálogo es chico; la búsqueda fina la hace el selector client-side.
 */
export function useVehicleModels(vehicleType: VehicleType) {
  const { registration } = useRepositories();
  return useQuery({
    queryKey: [...VEHICLE_MODELS_QUERY_KEY, vehicleType],
    queryFn: () => registration.listVehicleModels({ vehicleType }),
  });
}

/**
 * Mutación: solicita un modelo que no está en el catálogo (`POST /drivers/vehicle-models`). Al éxito,
 * invalida el catálogo del tipo para que reaparezca apenas el operador lo apruebe. El modelo queda
 * PENDING_REVIEW: NO se puede elegir aún (solo APPROVED se listan).
 */
export function useRequestVehicleModel() {
  const { registration } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: VehicleModelRequestInput) => registration.requestVehicleModel(input),
    onSuccess: (_result, input) => {
      queryClient.invalidateQueries({ queryKey: [...VEHICLE_MODELS_QUERY_KEY, input.vehicleType] });
    },
  });
}

/**
 * Query: vehículo ACTIVO (el que el conductor opera) — `GET /drivers/active-vehicle`. `null` si no
 * tiene ninguno operable. Es la FUENTE DE VERDAD del tipo: el dispatch lo deriva server-side, así que
 * la app refleja esto (no un toggle local). Alimenta el selector de turno y el pill del header.
 */
export function useActiveVehicle() {
  const { registration } = useRepositories();
  return useQuery({
    queryKey: ACTIVE_VEHICLE_QUERY_KEY,
    queryFn: () => registration.getActiveVehicle(),
  });
}

/**
 * Mutación: selecciona el vehículo ACTIVO (`PATCH /drivers/active-vehicle`). Server-authoritative: el
 * servidor valida pertenencia + docs vigentes. Al éxito invalida el activo y la lista (cambia `isActive`).
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
