import { DocumentSide, FleetDocumentType } from '@veo/shared-types';
import type { DocumentSideFile } from '../../../documents/domain';
import { ocrEngineForPlatform, ocrTimestampNow } from '../../../documents/data';
import { PersonalDataValidationError, type PersonalData, type PersonalDataErrors } from '../../domain';
import { isConflictError } from '../../../../shared/presentation/errors';
import { useRegistrationStore } from '../state/registrationStore';
import { useUpdatePersonalData } from './useRegistrationWizard';
import { useUploadAndRegisterDocument } from './useRegistrationDocuments';

/**
 * Resultado del "Continuar" del paso 1. Discriminado por `status` para que la pantalla pinte el feedback
 * correcto SIN strings mágicos ni ambigüedad:
 *  - `ok`: PATCH + (subida del DNI si la había) OK → la pantalla navega al paso 2.
 *  - `field-errors`: el PATCH falló por validación de cliente → errores junto a cada campo.
 *  - `server-error`: el PATCH falló por red/servidor → banner de servidor.
 *  - `dni-upload-failed`: el PATCH creó el driver pero la SUBIDA del DNI escaneado falló. Se conservan las
 *    caras (`pendingDni`) para reintentar; la pantalla muestra un aviso y NO avanza (el DNI es requerido).
 */
export type PersonalDataContinueResult =
  | { status: 'ok' }
  | { status: 'field-errors'; errors: PersonalDataErrors }
  | { status: 'server-error'; error: unknown }
  | { status: 'dni-upload-failed' };

/**
 * Orquesta el "Continuar" del paso 1 (Datos Personales) en el ORDEN CORRECTO, corrigiendo el BUG de
 * secuencia del onboarding:
 *
 *  1) `PATCH /drivers/me/personal` (upsert idempotente) → CREA el perfil del conductor.
 *  2) Recién entonces sube el DNI que el escaneo dejó PENDIENTE (`pendingDni`) reusando el MISMO
 *     uploader/use-case del paso de Documentos. El presign del DNI exige que el driver ya exista; si la
 *     subida ocurría en el momento del escaneo (antes del PATCH), devolvía 404 "no existe perfil".
 *
 * Caminos infelices (degradación HONESTA, sin perder progreso ni imágenes):
 *  - PATCH inválido → `field-errors`; error de red/servidor → `server-error`. No avanza.
 *  - DNI escaneado pero la SUBIDA falla (el driver YA existe) → `dni-upload-failed`; se CONSERVA `pendingDni`
 *    para reintentar (re-ejecutar el continue repite el PATCH idempotente + la subida). El progreso del
 *    PATCH ya hecho NO se pierde.
 *  - Sin DNI escaneado (tipeo manual) → no hay nada que subir; procede.
 */
export interface PersonalDataContinue {
  /** Ejecuta PATCH + subida diferida del DNI. Resuelve el resultado discriminado para la pantalla. */
  submit: (personal: PersonalData) => Promise<PersonalDataContinueResult>;
  /** ¿Hay una operación en curso (PATCH o subida del DNI)? Para el estado de carga del botón. */
  isPending: boolean;
}

export function usePersonalDataContinue(): PersonalDataContinue {
  const pendingDni = useRegistrationStore((s) => s.pendingDni);
  const clearPendingDni = useRegistrationStore((s) => s.clearPendingDni);
  const updatePersonalData = useUpdatePersonalData();
  // Reusa el MISMO uploader/use-case del paso de Documentos (no se duplica el pipeline presign→PUT→registro).
  const uploadDni = useUploadAndRegisterDocument();

  /**
   * Sube el DNI escaneado pendiente (si lo hay) AHORA que el driver existe. FRONT siempre; BACK solo si se
   * capturó (una cara es válida; el reverso se completa luego). Caras tipadas del enum, sin strings mágicos.
   * Devuelve `true` si subió o si no había nada que subir; `false` si la subida falló (conserva `pendingDni`).
   */
  const uploadPendingDni = async (documentNumber: string): Promise<boolean> => {
    if (!pendingDni) {
      return true;
    }
    const sides: DocumentSideFile[] = [{ side: DocumentSide.FRONT, file: pendingDni.front }];
    if (pendingDni.back) {
      sides.push({ side: DocumentSide.BACK, file: pendingDni.back });
    }
    try {
      await uploadDni.mutateAsync({
        type: FleetDocumentType.DNI,
        sides,
        ...(documentNumber.length > 0 ? { documentNumber } : {}),
        // Lote 1: la data OCR del DNI (mapeada en el scan) + su trazabilidad viajan al registrar. Solo si
        // el escaneo extrajo algo (`extractedData` no nulo): el DNI tipeado a mano se sube sin OCR.
        ...(pendingDni.extractedData
          ? {
              extractedData: pendingDni.extractedData,
              ocrEngine: ocrEngineForPlatform(),
              ocrAt: ocrTimestampNow(),
            }
          : {}),
      });
      clearPendingDni();
      return true;
    } catch (e) {
      // Retry legítimo del "escaneá y listo": el DNI YA fue registrado en un intento previo y el backend
      // responde 409 ConflictError ("Ya existe un documento activo de ese tipo"). El DNI YA está → es
      // ÉXITO, no error: limpiamos `pendingDni` (igual que el éxito normal) y avanzamos al paso siguiente.
      // Detectado por status 409 tipado (`isConflictError`/`ApiError`), no por el texto del mensaje.
      // Coherente con el FIX C de `DocumentsScreen` (Licencia/SOAT).
      if (isConflictError(e)) {
        clearPendingDni();
        return true;
      }
      // Cualquier otro fallo (red/5xx): el driver YA existe (lo creó el PATCH) pero el binario no subió.
      // NO perdemos las caras → se conserva `pendingDni` para reintentar.
      return false;
    }
  };

  const submit = async (personal: PersonalData): Promise<PersonalDataContinueResult> => {
    // 1) Crea/actualiza el perfil (upsert idempotente). DEBE ir ANTES de subir el DNI.
    try {
      await updatePersonalData.mutateAsync(personal);
    } catch (e) {
      if (e instanceof PersonalDataValidationError) {
        return { status: 'field-errors', errors: e.errors };
      }
      return { status: 'server-error', error: e };
    }

    // 2) Sube el DNI escaneado pendiente (si lo hubo). Si falla, conservamos las caras y no avanzamos.
    const dniUploaded = await uploadPendingDni(personal.dni.trim());
    if (!dniUploaded) {
      return { status: 'dni-upload-failed' };
    }
    return { status: 'ok' };
  };

  return {
    submit,
    isPending: updatePersonalData.isPending || uploadDni.isPending,
  };
}
