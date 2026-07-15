import { VehicleValidationError, type VehicleData, type VehicleErrors } from '../../domain';
import { isConflictError } from '../../../../shared/presentation/errors';
import { useRegisterVehicle } from './useRegistrationWizard';

/**
 * Resultado del "Registrar vehículo" del paso 2. Discriminado por `status` para que la pantalla pinte el
 * feedback correcto SIN strings mágicos ni ambigüedad (mismo patrón que `usePersonalDataContinue`):
 *  - `ok`: alta del vehículo OK → la pantalla navega al paso 3.
 *  - `field-errors`: la validación de cliente falló → errores junto a cada campo.
 *  - `plate-taken`: 409 del alta = la placa pertenece a OTRO conductor (la propia es idempotente). Se
 *    surfacea como error INLINE del campo placa (accionable), no como banner genérico.
 *  - `server-error`: el alta falló por red/servidor → banner de servidor.
 */
export type VehicleContinueResult =
  | { status: 'ok' }
  | { status: 'field-errors'; errors: VehicleErrors }
  | { status: 'plate-taken' }
  | { status: 'server-error'; error: unknown };

export interface VehicleContinue {
  /** Ejecuta el alta del vehículo. Resuelve el resultado discriminado para la pantalla. */
  submit: (vehicle: VehicleData) => Promise<VehicleContinueResult>;
  /** ¿Hay un alta en curso? Para el estado de carga del botón. */
  isPending: boolean;
}

/**
 * Orquesta el "Registrar vehículo" del paso 2 (Vehículo · Lote 2 · scan-first): un solo
 * `POST /drivers/vehicles` que CREA el vehículo (queda PENDING_REVIEW). Toma la rama del contrato según el
 * wizard: `modelSpecId` (catálogo) o `make`+`model` a texto libre (scan-first del OCR), resuelto en
 * `validateVehicle`. El `vehicleType` ya viene derivado de la categoría MTC de la tarjeta (o manual).
 *
 * LOTE A (subida unificada e INMEDIATA): la IMAGEN de la tarjeta de propiedad YA NO se sube acá de forma
 * diferida. Ahora se sube al SERVER apenas el escaneo tiene imagen + placa (ver `VehicleScreen`: efecto
 * `uploadPropertyCardNow`), igual que la foto y el SOAT — es un documento DRIVER-scoped que NO referencia
 * ningún `vehicleId`, así que no depende del alta. El gating del botón exige que la tarjeta YA esté en el
 * server (`cardImageReady`) antes de permitir el alta. Por eso este hook solo crea el vehículo.
 *
 * Caminos infelices (degradación HONESTA): validación de cliente → `field-errors`; 409 del alta (placa
 * ajena) → `plate-taken`; red/servidor → `server-error`. No avanza.
 */
export function useVehicleContinue(): VehicleContinue {
  const registerVehicle = useRegisterVehicle();

  const submit = async (vehicle: VehicleData): Promise<VehicleContinueResult> => {
    try {
      await registerVehicle.mutateAsync(vehicle);
    } catch (e) {
      if (e instanceof VehicleValidationError) {
        return { status: 'field-errors', errors: e.errors };
      }
      if (isConflictError(e)) {
        // 409 del alta = la placa pertenece a OTRO conductor (la propia es idempotente server-side).
        return { status: 'plate-taken' };
      }
      return { status: 'server-error', error: e };
    }
    return { status: 'ok' };
  };

  return {
    submit,
    isPending: registerVehicle.isPending,
  };
}
