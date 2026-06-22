import { DocumentSide, FleetDocumentType } from '@veo/shared-types';
import type { DocumentSideFile, PickedImage } from '../../../documents/domain';
import { ocrEngineForPlatform, ocrTimestampNow } from '../../../documents/data';
import { PersonalDataValidationError, type PersonalData, type PersonalDataErrors } from '../../domain';
import { isConflictError } from '../../../../shared/presentation/errors';
import { useRegistrationStore } from '../state/registrationStore';
import { useUpdatePersonalData } from './useRegistrationWizard';
import { useOnboardLicense, useUploadAndRegisterDocument } from './useRegistrationDocuments';

/**
 * Documento del paso 1 (CONDUCTOR) cuya subida DIFERIDA puede fallar tras el PATCH. Discriminador TIPADO
 * (no string mágico) para que la pantalla muestre el aviso correcto (DNI vs licencia) sin ambigüedad.
 */
export type DeferredDocument = 'dni' | 'license';

/**
 * Resultado del "Continuar" del paso 1. Discriminado por `status` para que la pantalla pinte el feedback
 * correcto SIN strings mágicos ni ambigüedad:
 *  - `ok`: PATCH + subidas diferidas (DNI y licencia, si las había) OK → la pantalla navega al paso 2.
 *  - `field-errors`: el PATCH falló por validación de cliente → errores junto a cada campo.
 *  - `server-error`: el PATCH falló por red/servidor → banner de servidor.
 *  - `document-upload-failed`: el PATCH creó el driver pero la SUBIDA de un documento escaneado (DNI o
 *    licencia, indicado por `document`) falló. Se conserva la captura (`pendingDni`/`pendingLicense`) para
 *    reintentar; la pantalla muestra un aviso y NO avanza (ambos documentos son requeridos).
 */
export type PersonalDataContinueResult =
  | { status: 'ok' }
  | { status: 'field-errors'; errors: PersonalDataErrors }
  | { status: 'server-error'; error: unknown }
  | { status: 'document-upload-failed'; document: DeferredDocument };

/**
 * Orquesta el "Continuar" del paso 1 (Datos Personales) en el ORDEN CORRECTO, corrigiendo el BUG de
 * secuencia del onboarding:
 *
 *  1) `PATCH /drivers/me/personal` (upsert idempotente) → CREA el perfil del conductor.
 *  2) Recién entonces sube el DNI que el escaneo dejó PENDIENTE (`pendingDni`) reusando el MISMO
 *     uploader/use-case del paso de Documentos. El presign del DNI exige que el driver ya exista; si la
 *     subida ocurría en el momento del escaneo (antes del PATCH), devolvía 404 "no existe perfil".
 *  3) Y DESPUÉS sube la LICENCIA pendiente (`pendingLicense`) + su `POST /drivers/onboard`, espejando el
 *     patrón del DNI: el presign de la licencia exige el driver creado, así que también se DIFIERE acá (antes
 *     se subía en el escaneo → 404 "no existe perfil" para conductor nuevo).
 *
 * ORDEN final (conductor nuevo): PATCH /personal (crea driver) → subir DNI → subir licencia + onboard.
 *
 * Caminos infelices (degradación HONESTA, sin perder progreso ni imágenes):
 *  - PATCH inválido → `field-errors`; error de red/servidor → `server-error`. No avanza.
 *  - DNI/licencia escaneados pero la SUBIDA falla (el driver YA existe) → `document-upload-failed` (con el
 *    `document` que falló); se CONSERVA `pendingDni`/`pendingLicense` para reintentar (re-ejecutar el continue
 *    repite el PATCH idempotente + las subidas). El progreso del PATCH ya hecho NO se pierde.
 *  - Sin DNI/licencia escaneados → no hay nada que subir para ese documento; procede.
 */
/**
 * Parámetros del "Continuar". `driverExists` unifica la FUENTE DE VERDAD del paso (mata el dead-end "los
 * datos no son válidos"): cuando el SERVIDOR ya tiene al conductor (resume), sus datos personales YA están
 * seteados server-side, así que NO se re-PATCHea (el `personal` local está vacío al reanudar y el PATCH
 * vacío rompía la validación → field-errors sin campo editable). Solo en un alta FRESCA (driver inexistente)
 * el PATCH crea el driver con el `personal` que pobló el escaneo del DNI.
 */
export interface PersonalDataContinueParams {
  /** Datos personales LOCALES del wizard (poblados por el escaneo en alta fresca; vacíos al reanudar). */
  personal: PersonalData;
  /** ¿El servidor YA tiene al conductor? `true` (resume) ⇒ salta el PATCH; `false`/unknown ⇒ PATCH (crea). */
  driverExists: boolean;
}

export interface PersonalDataContinue {
  /** Ejecuta PATCH (solo en alta fresca) + subidas diferidas (DNI y licencia). Resuelve el resultado discriminado. */
  submit: (params: PersonalDataContinueParams) => Promise<PersonalDataContinueResult>;
  /** ¿Hay una operación en curso (PATCH o subidas)? Para el estado de carga del botón. */
  isPending: boolean;
}

export function usePersonalDataContinue(): PersonalDataContinue {
  const pendingDni = useRegistrationStore((s) => s.pendingDni);
  const clearPendingDni = useRegistrationStore((s) => s.clearPendingDni);
  const pendingLicense = useRegistrationStore((s) => s.pendingLicense);
  const clearPendingLicense = useRegistrationStore((s) => s.clearPendingLicense);
  const updatePersonalData = useUpdatePersonalData();
  // Reusa el MISMO uploader/use-case del paso de Documentos (no se duplica el pipeline presign→PUT→registro).
  const uploadDni = useUploadAndRegisterDocument();
  // Subida + onboarding de la licencia: el MISMO pipeline canónico que usaba la pantalla al escanear.
  const uploadLicense = useUploadAndRegisterDocument();
  const onboardLicense = useOnboardLicense();

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

  /**
   * Sube la LICENCIA escaneada pendiente (si la hay) AHORA que el driver existe, y dispara su onboarding
   * (`POST /drivers/onboard` con `{ licenseNumber, licenseExpiresAt }`). ESPEJA `uploadPendingDni`: una sola
   * imagen (`SINGLE`), el `documentNumber`/`expiresAt` críticos los garantiza el sheet al capturar, y la
   * data OCR + trazabilidad viajan solo si el escaneo las produjo. Devuelve `true` si subió (o no había nada);
   * `false` si la subida/onboarding falló (conserva `pendingLicense` para reintentar en el próximo Continuar).
   */
  const uploadPendingLicense = async (): Promise<boolean> => {
    if (!pendingLicense) {
      return true;
    }
    const file: PickedImage = pendingLicense.file;
    try {
      await uploadLicense.mutateAsync({
        type: FleetDocumentType.LICENSE_A1,
        file,
        documentNumber: pendingLicense.documentNumber,
        expiresAt: pendingLicense.expiresAt,
        ...(pendingLicense.extractedData
          ? {
              extractedData: pendingLicense.extractedData,
              ocrEngine: ocrEngineForPlatform(),
              ocrAt: ocrTimestampNow(),
            }
          : {}),
      });
      // La licencia alimenta el onboarding del conductor (driverOnboardRequest). Número + vencimiento son
      // críticos (el sheet solo captura cuando el OCR los leyó), así que acá están garantizados.
      await onboardLicense.mutateAsync({
        licenseNumber: pendingLicense.documentNumber,
        licenseExpiresAt: pendingLicense.expiresAt,
      });
      clearPendingLicense();
      return true;
    } catch (e) {
      // 409 = la licencia (o su onboarding) YA se registró en un intento previo → ÉXITO, no error. Mismo
      // criterio 409-como-éxito tipado (`isConflictError`) que el DNI: limpiamos y avanzamos.
      if (isConflictError(e)) {
        clearPendingLicense();
        return true;
      }
      // Otro fallo (red/5xx): el driver YA existe pero la licencia no subió. NO perdemos la captura →
      // se conserva `pendingLicense` para reintentar (PATCH idempotente + re-subida en el próximo Continuar).
      return false;
    }
  };

  const submit = async ({
    personal,
    driverExists,
  }: PersonalDataContinueParams): Promise<PersonalDataContinueResult> => {
    // 1) Crea el perfil del conductor — SOLO en un alta FRESCA. El `PATCH /drivers/me/personal` existe para
    //    CREAR el driver con el `personal` que pobló el escaneo del DNI. Si el driver YA EXISTE en el server
    //    (RESUME), sus datos personales ya están seteados server-side: re-PATCHear es innecesario Y rompe,
    //    porque al reanudar el `personal` local está vacío (`fullName`/`birthdate` no se rehidratan: el
    //    contrato del server no los expone) y el PATCH vacío hace que `validatePersonalData` rechace
    //    (name_required + birthdate_required) → el dead-end "los datos leídos no son válidos" sin campo
    //    editable. La fuente de verdad es el SERVER: si ya tiene al conductor, no lo re-mandamos.
    if (!driverExists) {
      try {
        await updatePersonalData.mutateAsync(personal);
      } catch (e) {
        if (e instanceof PersonalDataValidationError) {
          return { status: 'field-errors', errors: e.errors };
        }
        return { status: 'server-error', error: e };
      }
    }

    // 2) Sube el DNI escaneado pendiente (si lo hubo). Si falla, conservamos las caras y no avanzamos.
    const dniUploaded = await uploadPendingDni(personal.dni.trim());
    if (!dniUploaded) {
      return { status: 'document-upload-failed', document: 'dni' };
    }

    // 3) Sube la LICENCIA escaneada pendiente (si la hubo) + su onboarding. Si falla, conservamos la
    //    captura y no avanzamos (la licencia es requerida igual que el DNI).
    const licenseUploaded = await uploadPendingLicense();
    if (!licenseUploaded) {
      return { status: 'document-upload-failed', document: 'license' };
    }

    return { status: 'ok' };
  };

  return {
    submit,
    isPending:
      updatePersonalData.isPending ||
      uploadDni.isPending ||
      uploadLicense.isPending ||
      onboardLicense.isPending,
  };
}
