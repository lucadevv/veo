import { DocumentSide, FleetDocumentType } from '@veo/shared-types';
import type { DocumentSideFile } from '../../../documents/domain';
import { ocrEngineForPlatform, ocrTimestampNow } from '../../../documents/data';
import {
  PersonalDataValidationError,
  type PersonalData,
  type PersonalDataErrors,
} from '../../domain';
import { isConflictError } from '../../../../shared/presentation/errors';
import { deriveDocumentPhase, useRegistrationStore } from '../state/registrationStore';
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
  // Las capturas pendientes se leen FRESCAS del store al momento de cada corrida (`getState()`), no por
  // suscripción: el confirm del sheet guarda la captura y dispara la subida EN EL MISMO TICK — una
  // suscripción de hook todavía vería el valor viejo (null) y no subiría nada.
  const clearPendingDni = useRegistrationStore((s) => s.clearPendingDni);
  const clearPendingLicense = useRegistrationStore((s) => s.clearPendingLicense);
  // Fase de envío VISIBLE (pen: "Subiendo… / Enviado / Error·Reintentar"): el sheet y las cards del paso 1
  // la pintan en vivo mientras este hook sube. Se setea alrededor de CADA subida (sending→sent/error).
  const setSendPhase = useRegistrationStore((s) => s.setSendPhase);
  const updatePersonalData = useUpdatePersonalData();
  // Reusa el MISMO uploader/use-case del paso de Documentos (no se duplica el pipeline presign→PUT→registro).
  const uploadDni = useUploadAndRegisterDocument();
  // Subida + onboarding de la licencia: el MISMO pipeline canónico que usaba la pantalla al escanear.
  const uploadLicense = useUploadAndRegisterDocument();
  const onboardLicense = useOnboardLicense();

  /**
   * Sube el DNI escaneado pendiente (si lo hay) AHORA que el driver existe. CON reverso → par FRONT+BACK;
   * SIN reverso → una sola cara SINGLE (el backend exige el par EXACTO si se manda alguna cara FRONT/BACK,
   * así que un FRONT solo se rechazaría). Caras tipadas del enum, sin strings mágicos. Devuelve `true` si subió
   * o si no había nada que subir; `false` si la subida falló (conserva `pendingDni`).
   */
  const uploadPendingDni = async (documentNumber: string): Promise<boolean> => {
    // Lote 1: el DNI ahora sube EAGER en su propio sheet (`useDniSubmit`). Si ya quedó `sent` (ambas caras
    // subidas), este continue NO lo re-sube: es un BACKSTOP idempotente. Si por algún camino el DNI aún no
    // se subió (`idle`/`error`), este bloque lo sube igual (retry seguro; un 409 se trata como éxito).
    if (deriveDocumentPhase(useRegistrationStore.getState().sendPhases.dni) === 'sent') {
      return true;
    }
    const pendingDni = useRegistrationStore.getState().pendingDni;
    if (!pendingDni) {
      return true;
    }
    // Fase POR CARA: el uploader llama este callback (sending→sent/error) por cada cara mientras sube.
    const onSidePhase = (
      side: DocumentSide,
      phase: 'idle' | 'sending' | 'sent' | 'error',
    ): void => {
      setSendPhase('dni', side === DocumentSide.BACK ? 'back' : 'front', phase);
    };
    // Número (si lo hay) + data OCR/trazabilidad (solo si el escaneo extrajo algo: el DNI tipeado a mano se
    // sube sin OCR) — comunes a ambas formas de subida.
    const extraFields = {
      ...(documentNumber.length > 0 ? { documentNumber } : {}),
      ...(pendingDni.extractedData
        ? {
            extractedData: pendingDni.extractedData,
            ocrEngine: ocrEngineForPlatform(),
            ocrAt: ocrTimestampNow(),
          }
        : {}),
    };
    try {
      // MISMA regla de caras que la licencia (fleet `normalizeDocumentImages`): un FRONT solo se RECHAZA
      // ("Caras incoherentes"). CON reverso → par FRONT+BACK; SIN reverso → una sola cara SINGLE (`{file}`).
      // La fase POR CARA la escribe el `onSidePhase` del uploader (sending→sent/error), no este bloque.
      await uploadDni.mutateAsync(
        pendingDni.back
          ? {
              type: FleetDocumentType.DNI,
              sides: [
                { side: DocumentSide.FRONT, file: pendingDni.front },
                { side: DocumentSide.BACK, file: pendingDni.back },
              ] satisfies DocumentSideFile[],
              onSidePhase,
              ...extraFields,
            }
          : {
              type: FleetDocumentType.DNI,
              file: pendingDni.front,
              onSidePhase,
              ...extraFields,
            },
      );
      clearPendingDni();
      return true;
    } catch (e) {
      // Retry legítimo del "escaneá y listo": el DNI YA fue registrado en un intento previo y el backend
      // responde 409 ConflictError ("Ya existe un documento activo de ese tipo"). El DNI YA está → es
      // ÉXITO, no error: limpiamos `pendingDni` (igual que el éxito normal) y avanzamos al paso siguiente.
      // Los PUT de las caras fueron OK antes del registro, así que el callback ya las dejó en `sent`.
      // Detectado por status 409 tipado (`isConflictError`/`ApiError`), no por el texto del mensaje.
      if (isConflictError(e)) {
        clearPendingDni();
        return true;
      }
      // Cualquier otro fallo (red/5xx): el driver YA existe (lo creó el PATCH) pero el binario/registro no
      // subió. NO perdemos las caras → se conserva `pendingDni`. Si rompió el PUT, el callback ya marcó la
      // cara en `error`; si rompió el REGISTRO (post-PUT), forzamos `error` en el anverso para que la fase
      // derivada del DNI sea honesta (`error`), no un `sent` que mentiría.
      setSendPhase('dni', 'front', 'error');
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
    // Lote 3: la licencia ahora sube EAGER en su propio sheet (`useLicenseSubmit`), igual que el DNI. Si ya
    // quedó `sent` (subida + onboard hechos), este continue NO la re-sube: es un BACKSTOP idempotente. Si por
    // algún camino la licencia aún no se subió (`idle`/`error`), este bloque la sube igual (retry seguro; un
    // 409 se trata como éxito). Espeja EXACTO el guard del DNI de `uploadPendingDni`.
    if (deriveDocumentPhase(useRegistrationStore.getState().sendPhases.license) === 'sent') {
      return true;
    }
    const pendingLicense = useRegistrationStore.getState().pendingLicense;
    if (!pendingLicense) {
      return true;
    }
    // Data OCR + trazabilidad (solo si el escaneo las produjo) — comunes a ambas formas de subida.
    const ocrFields = pendingLicense.extractedData
      ? {
          extractedData: pendingLicense.extractedData,
          ocrEngine: ocrEngineForPlatform(),
          ocrAt: ocrTimestampNow(),
        }
      : {};
    // Fase POR CARA de la licencia: el uploader llama este callback (sending→sent/error) por cada cara.
    const onSidePhase = (
      side: DocumentSide,
      phase: 'idle' | 'sending' | 'sent' | 'error',
    ): void => {
      setSendPhase('license', side === DocumentSide.BACK ? 'back' : 'front', phase);
    };
    try {
      // El backend exige el PAR EXACTO {FRONT, BACK} si se manda ALGUNA cara (fleet `normalizeDocumentImages`):
      // un FRONT solo se rechaza ("Caras incoherentes"). Reverso SOFT: CON reverso → par FRONT+BACK; SIN reverso
      // → una sola imagen SINGLE (shape `{file}`, como hoy). La fase por cara la escribe `onSidePhase`.
      await uploadLicense.mutateAsync(
        pendingLicense.back
          ? {
              type: FleetDocumentType.LICENSE_A1,
              sides: [
                { side: DocumentSide.FRONT, file: pendingLicense.file },
                { side: DocumentSide.BACK, file: pendingLicense.back },
              ] satisfies DocumentSideFile[],
              onSidePhase,
              documentNumber: pendingLicense.documentNumber,
              expiresAt: pendingLicense.expiresAt,
              ...ocrFields,
            }
          : {
              type: FleetDocumentType.LICENSE_A1,
              file: pendingLicense.file,
              onSidePhase,
              documentNumber: pendingLicense.documentNumber,
              expiresAt: pendingLicense.expiresAt,
              ...ocrFields,
            },
      );
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
      // Otro fallo (red/5xx): el driver YA existe pero la licencia/onboarding no subió. NO perdemos la
      // captura → se conserva `pendingLicense`. Si rompió el PUT, el callback ya marcó la cara en `error`;
      // si rompió el REGISTRO/ONBOARD (post-PUT), forzamos `error` en el anverso para una fase honesta.
      setSendPhase('license', 'front', 'error');
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
        // El envío visible no puede quedar colgado en "sending": si el PATCH que crea el driver falla,
        // las capturas pendientes pasan a `error` (la card ofrece Reintentar, que repite el PATCH idempotente).
        const pending = useRegistrationStore.getState();
        if (pending.pendingDni) {
          setSendPhase('dni', 'front', 'error');
        }
        if (pending.pendingLicense) {
          setSendPhase('license', 'front', 'error');
        }
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
