import { registrationDocTypeToBackend, VehicleValidationError, type VehicleData, type VehicleErrors } from '../../domain';
import { ocrEngineForPlatform, ocrTimestampNow } from '../../../documents/data';
import { isConflictError } from '../../../../shared/presentation/errors';
import { useRegistrationStore } from '../state/registrationStore';
import { useRegisterVehicle } from './useRegistrationWizard';
import { useUploadAndRegisterDocument } from './useRegistrationDocuments';

/**
 * Resultado del "Registrar vehículo" del paso 2. Discriminado por `status` para que la pantalla pinte el
 * feedback correcto SIN strings mágicos ni ambigüedad (mismo patrón que `usePersonalDataContinue`):
 *  - `ok`: alta del vehículo + (subida de la tarjeta si la había) OK → la pantalla navega al paso 3.
 *  - `field-errors`: la validación de cliente falló → errores junto a cada campo.
 *  - `plate-taken`: 409 del alta = la placa pertenece a OTRO conductor (la propia es idempotente). Se
 *    surfacea como error INLINE del campo placa (accionable), no como banner genérico.
 *  - `server-error`: el alta falló por red/servidor → banner de servidor.
 *  - `card-upload-failed`: el vehículo se creó pero la SUBIDA de la tarjeta escaneada falló. Se conserva
 *    `pendingPropertyCard` para reintentar; la pantalla muestra un aviso y NO avanza (la tarjeta es
 *    documentación del vehículo: si se escaneó, debe subir).
 */
export type VehicleContinueResult =
  | { status: 'ok' }
  | { status: 'field-errors'; errors: VehicleErrors }
  | { status: 'plate-taken' }
  | { status: 'server-error'; error: unknown }
  | { status: 'card-upload-failed' };

export interface VehicleContinue {
  /** Ejecuta el alta del vehículo + subida diferida de la tarjeta. Resuelve el resultado para la pantalla. */
  submit: (vehicle: VehicleData) => Promise<VehicleContinueResult>;
  /** ¿Hay una operación en curso (alta o subida de la tarjeta)? Para el estado de carga del botón. */
  isPending: boolean;
}

/** `FleetDocumentType` canónico de la tarjeta de propiedad (la etiqueta del wizard mapea a PROPERTY_CARD). */
const PROPERTY_CARD_BACKEND_TYPE = registrationDocTypeToBackend('VEHICLE_REGISTRATION');

/**
 * Orquesta el "Registrar vehículo" del paso 2 (Vehículo · Lote 2 · scan-first) en el ORDEN CORRECTO,
 * MISMO patrón que `usePersonalDataContinue` (subida diferida + 409-como-éxito):
 *
 *  1) `POST /drivers/vehicles` → CREA el vehículo (queda PENDING_REVIEW). Toma la rama del contrato según
 *     el wizard: `modelSpecId` (catálogo) o `make`+`model` a texto libre (scan-first del OCR), resuelto en
 *     `validateVehicle`. El `vehicleType` ya viene derivado de la categoría MTC de la tarjeta (o manual).
 *  2) Recién entonces sube la tarjeta de propiedad que el escaneo dejó PENDIENTE (`pendingPropertyCard`)
 *     reusando el MISMO uploader/use-case del paso de Documentos. La tarjeta se registra como documento del
 *     CONDUCTOR (DRIVER-scoped: `drivers/{driverId}/...`), NO referencia ningún `vehicleId`, así que ningún
 *     seam del vehículo exige este orden. El alta va primero solo por COHERENCIA del flujo (un vehículo y su
 *     tarjeta juntos), no por una dependencia del presign del documento.
 *
 * Caminos infelices (degradación HONESTA, sin perder progreso ni la imagen):
 *  - Validación de cliente → `field-errors`. 409 del alta (placa ajena) → `plate-taken`. Red/servidor →
 *    `server-error`. No avanza.
 *  - Tarjeta escaneada pero la SUBIDA falla (el vehículo YA existe) → `card-upload-failed`; se CONSERVA
 *    `pendingPropertyCard` para reintentar. El alta ya hecha NO se pierde (re-ejecutar repite el alta
 *    idempotente — un re-submit de la placa propia avanza — + la subida).
 *  - Sin tarjeta escaneada (carga manual de los datos) → no hay nada que subir; procede.
 */
export function useVehicleContinue(): VehicleContinue {
  const pendingPropertyCard = useRegistrationStore((s) => s.pendingPropertyCard);
  const clearPendingPropertyCard = useRegistrationStore((s) => s.clearPendingPropertyCard);
  const registerVehicle = useRegisterVehicle();
  // Reusa el MISMO uploader/use-case del paso de Documentos (no se duplica el pipeline presign→PUT→registro).
  const uploadCard = useUploadAndRegisterDocument();

  /**
   * Sube la tarjeta de propiedad escaneada pendiente (si la hay) AHORA que el vehículo existe. UNA cara
   * (`SINGLE`, vía `file`). Devuelve `true` si subió o si no había nada que subir; `false` si la subida
   * falló (conserva `pendingPropertyCard`). Un 409 (tarjeta ya registrada) es ÉXITO, no error.
   *
   * `documentNumber` = la PLACA del vehículo: el backend EXIGE `documentNumber` para todo doc que no sea
   * `VEHICLE_PHOTO` (`@ValidateIf(type !== VEHICLE_PHOTO) @IsNotEmpty @Length(1,60)`), y la tarjeta de
   * propiedad NO tiene un "número" propio — su identificador natural es la placa que la tarjeta acredita.
   * La placa es el campo CRÍTICO del gating del scan (sin placa no se confirma la captura ni se registra el
   * vehículo), así que al llegar acá SIEMPRE existe → `documentNumber` siempre presente (evita el 400).
   */
  const uploadPendingCard = async (plate: string): Promise<boolean> => {
    if (!pendingPropertyCard) {
      return true;
    }
    try {
      await uploadCard.mutateAsync({
        type: PROPERTY_CARD_BACKEND_TYPE,
        file: pendingPropertyCard.front,
        // La placa es el `documentNumber` de la tarjeta de propiedad (ver doc del método): el backend lo
        // exige para todo doc ≠ VEHICLE_PHOTO; sin esto la subida diferida daría 400 SIEMPRE.
        documentNumber: plate,
        // Lote 2: la data OCR de la tarjeta (mapeada en el scan) + su trazabilidad viajan al registrar.
        // Solo si el escaneo extrajo algo (`extractedData` no nulo): la carga manual se sube sin OCR.
        ...(pendingPropertyCard.extractedData
          ? {
              extractedData: pendingPropertyCard.extractedData,
              ocrEngine: ocrEngineForPlatform(),
              ocrAt: ocrTimestampNow(),
            }
          : {}),
      });
      clearPendingPropertyCard();
      return true;
    } catch (e) {
      // Retry legítimo del "escaneá y listo": la tarjeta YA fue registrada en un intento previo y el
      // backend responde 409 ConflictError. La tarjeta YA está → es ÉXITO, no error: limpiamos pendiente
      // (igual que el éxito normal) y avanzamos. Detectado por status 409 tipado (`isConflictError`), no
      // por el texto del mensaje. Coherente con el flujo del DNI (usePersonalDataContinue).
      if (isConflictError(e)) {
        clearPendingPropertyCard();
        return true;
      }
      // Cualquier otro fallo (red/5xx): el vehículo YA existe pero el binario no subió. NO perdemos la
      // imagen → se conserva `pendingPropertyCard` para reintentar.
      return false;
    }
  };

  const submit = async (vehicle: VehicleData): Promise<VehicleContinueResult> => {
    // 1) Crea el vehículo. Va ANTES de subir la tarjeta por COHERENCIA del flujo (no por el presign: la
    //    tarjeta es un doc DRIVER-scoped y no referencia al vehículo).
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

    // 2) Sube la tarjeta escaneada pendiente (si la hubo). Si falla, conservamos la imagen y no avanzamos.
    // La placa va como `documentNumber` de la tarjeta. Se normaliza IGUAL que en `validateVehicle`
    // (mayúsculas, sin espacios) para que coincida con lo que el alta acaba de persistir.
    const plate = vehicle.plate.trim().toUpperCase().replace(/\s+/g, '');
    const cardUploaded = await uploadPendingCard(plate);
    if (!cardUploaded) {
      return { status: 'card-upload-failed' };
    }
    return { status: 'ok' };
  };

  return {
    submit,
    isPending: registerVehicle.isPending || uploadCard.isPending,
  };
}
