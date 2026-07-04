import { DocumentSide, FleetDocumentType } from '@veo/shared-types';
import type { DocumentSideFile } from '../../../documents/domain';
import { ocrEngineForPlatform, ocrTimestampNow } from '../../../documents/data';
import type { PersonalData } from '../../domain';
import {
  isConflictError,
  isDniAlreadyRegisteredError,
} from '../../../../shared/presentation/errors';
import { useRegistrationStore } from '../state/registrationStore';
import { useUpdatePersonalData } from './useRegistrationWizard';
import { useCheckDni, useUploadAndRegisterDocument } from './useRegistrationDocuments';

/**
 * Resultado TIPADO de la subida EAGER del DNI en su propio sheet (Lote 1). Discriminado por `status`
 * para que la pantalla pinte el feedback correcto SIN strings mágicos sueltos:
 *  - `ok`: el DNI se chequeó (no está tomado), el driver se creó (alta fresca) y el binario se subió →
 *    las caras quedan `sent`. Un 409 del registro (DNI ya activo · retry) también es `ok`.
 *  - `dni-taken`: el DNI YA pertenece a OTRA cuenta — detectado por el pre-check `POST /drivers/me/check-dni`
 *    (`{ exists: true }`) o, como backstop de carrera, por el `code` `DNI_ALREADY_REGISTERED` del PATCH. NO
 *    se sube nada.
 *  - `error`: el pre-check, el PATCH (validación/red/servidor) o la subida del binario fallaron. Se CONSERVA
 *    `pendingDni` (la captura no se pierde) para reintentar; la fase derivada del DNI queda `error`.
 */
export type DniSubmitResult =
  | { status: 'ok' }
  | { status: 'dni-taken' }
  | { status: 'error'; error: unknown };

/**
 * Parámetros de la subida eager del DNI. Espeja `PersonalDataContinueParams`: `driverExists` unifica la
 * FUENTE DE VERDAD (en RESUME el driver ya existe server-side → NO se re-PATCHea; en alta fresca el PATCH
 * lo crea con el `personal` que pobló el escaneo).
 */
export interface DniSubmitParams {
  /** Datos personales LOCALES del wizard (poblados por el escaneo del DNI). */
  personal: PersonalData;
  /** ¿El servidor YA tiene al conductor? `true` (resume) ⇒ salta el PATCH; `false`/unknown ⇒ PATCH (crea). */
  driverExists: boolean;
}

export interface DniSubmit {
  /** Ejecuta checkDni → PATCH (alta fresca) → subir DNI (fase por cara). Resuelve el resultado discriminado. */
  submit: (params: DniSubmitParams) => Promise<DniSubmitResult>;
  /** ¿Hay una operación en curso (check / PATCH / subida)? Para el estado de carga del sheet. */
  isPending: boolean;
}

/** Mapea la cara del uploader (FRONT/BACK/SINGLE) a la clave de fase del store. SINGLE cuenta como anverso. */
function faceForSide(side: DocumentSide): 'front' | 'back' {
  return side === DocumentSide.BACK ? 'back' : 'front';
}

/**
 * Orquesta la subida EAGER del DNI en su propio sheet (Lote 1), en el ORDEN CORRECTO y con estados POR CARA:
 *
 *  1) `POST /drivers/me/check-dni` — pre-check de unicidad. Si `{ exists: true }` → `dni-taken`, NO sube nada.
 *  2) `PATCH /drivers/me/personal` (SOLO alta fresca) — crea el driver. Si el backend responde el `code`
 *     `DNI_ALREADY_REGISTERED` (backstop de carrera del pre-check) → `dni-taken`. Otro fallo → `error`.
 *  3) Sube el DNI pendiente (`pendingDni`) reusando el MISMO pipeline presign→PUT→registro, con el callback
 *     POR CARA que escribe `setSendPhase('dni', side, phase)` en el store (el sheet pinta anverso/reverso en
 *     vivo). CON reverso → par FRONT+BACK; SIN reverso → una sola cara SINGLE (regla de caras del backend).
 *  4) Éxito → `clearPendingDni()` → `ok`. El 409 del registro (DNI ya activo · retry) también es `ok`.
 *
 * Degradación HONESTA: ante un fallo real la captura se CONSERVA (`pendingDni`) y la fase derivada queda
 * `error` (el sheet ofrece reintentar). NUNCA se marca un envío que no ocurrió.
 */
export function useDniSubmit(): DniSubmit {
  const checkDni = useCheckDni();
  const updatePersonalData = useUpdatePersonalData();
  // Reusa el MISMO uploader/use-case del paso de Documentos (no se duplica el pipeline presign→PUT→registro).
  const uploadDni = useUploadAndRegisterDocument();
  const setSendPhase = useRegistrationStore((s) => s.setSendPhase);
  const clearPendingDni = useRegistrationStore((s) => s.clearPendingDni);

  /**
   * Sube el DNI pendiente (si lo hay) AHORA que el driver existe, reportando la fase POR CARA vía el callback
   * del uploader. Devuelve `ok` si subió (o no había nada / 409-como-éxito); `error` si la subida falló real
   * (conserva `pendingDni`). El `documentNumber` y la data OCR viajan como en `usePersonalDataContinue`.
   */
  const uploadPendingDni = async (): Promise<DniSubmitResult> => {
    const pendingDni = useRegistrationStore.getState().pendingDni;
    if (!pendingDni) {
      // El PATCH ya creó el driver, pero no hay captura para subir: nada que hacer, el flujo procede.
      return { status: 'ok' };
    }
    const documentNumber = useRegistrationStore.getState().personal.dni.trim();
    // Número (si lo hay) + data OCR/trazabilidad (solo si el escaneo extrajo algo) — comunes a ambas formas.
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
    // Fase POR CARA: el uploader llama este callback (sending→sent/error) por cada cara mientras sube.
    const onSidePhase = (side: DocumentSide, phase: 'idle' | 'sending' | 'sent' | 'error'): void => {
      setSendPhase('dni', faceForSide(side), phase);
    };
    try {
      // MISMA regla de caras que la licencia (fleet `normalizeDocumentImages`): un FRONT solo se RECHAZA.
      // CON reverso → par FRONT+BACK; SIN reverso → una sola cara SINGLE (`{file}`).
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
      return { status: 'ok' };
    } catch (e) {
      // 409 = el DNI YA fue registrado en un intento previo (retry legítimo) → ÉXITO. Los PUT de las caras
      // fueron OK antes del registro, así que el callback ya las dejó en `sent`; limpiamos y avanzamos.
      if (isConflictError(e)) {
        clearPendingDni();
        return { status: 'ok' };
      }
      // Fallo real: si rompió el PUT de una cara, el callback ya la marcó `error`. Si rompió el REGISTRO
      // (post-PUT, con las caras en `sent`), el documento NO quedó registrado → forzamos `error` en el anverso
      // para que la fase DERIVADA del DNI sea honesta (`error`), no un `sent` que mentiría "enviado".
      setSendPhase('dni', 'front', 'error');
      return { status: 'error', error: e };
    }
  };

  const submit = async ({ personal, driverExists }: DniSubmitParams): Promise<DniSubmitResult> => {
    const dni = personal.dni.trim();

    // 1) Pre-check de unicidad del DNI (blind index). Si ya está tomado, cortamos SIN subir nada.
    try {
      const { exists } = await checkDni.mutateAsync({ dni });
      if (exists) {
        return { status: 'dni-taken' };
      }
    } catch (e) {
      // El pre-check falló (red/validación de cliente del contrato): no podemos garantizar unicidad →
      // error honesto, no subimos. La captura se conserva; el reintento re-ejecuta el flujo completo.
      return { status: 'error', error: e };
    }

    // 2) Crea el perfil del conductor — SOLO en alta FRESCA (en resume ya existe server-side).
    if (!driverExists) {
      try {
        await updatePersonalData.mutateAsync(personal);
      } catch (e) {
        // Backstop de carrera del pre-check: si entre el check y el PATCH otra cuenta registró el mismo DNI,
        // el backend responde el `code` `DNI_ALREADY_REGISTERED` (tipado, no el mensaje) → `dni-taken`.
        if (isDniAlreadyRegisteredError(e)) {
          return { status: 'dni-taken' };
        }
        // Validación de cliente (DNI/fecha/nombre) o red/servidor → error. Se conserva la captura.
        return { status: 'error', error: e };
      }
    }

    // 3) Sube el DNI escaneado (fase por cara). Éxito → clearPendingDni; fallo → conserva la captura.
    return uploadPendingDni();
  };

  return {
    submit,
    isPending: checkDni.isPending || updatePersonalData.isPending || uploadDni.isPending,
  };
}
