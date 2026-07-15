import { DocumentSide, FleetDocumentType } from '@veo/shared-types';
import type { DocumentSideFile } from '../../../documents/domain';
import { ocrEngineForPlatform, ocrTimestampNow } from '../../../../core/scanning/ocr-engine';
import { isConflictError } from '../../../../shared/presentation/errors';
import { useRegistrationStore } from '../state/registrationStore';
import { useOnboardLicense, useUploadAndRegisterDocument } from './useRegistrationDocuments';

/**
 * Resultado TIPADO de la subida EAGER de la LICENCIA en su propio sheet (Lote 3). ESPEJO del DNI
 * (`DniSubmitResult`), discriminado por `status` para que la pantalla pinte el feedback correcto SIN
 * strings mágicos sueltos:
 *  - `ok`: la licencia se subió (caras `sent`) y su `POST /drivers/onboard` corrió. Un 409 del registro o
 *    del onboard (licencia ya activa · retry) también es `ok`. Sin captura pendiente → también `ok` (nada
 *    que hacer).
 *  - `needs-dni`: el conductor AÚN no existe server-side (el DNI, que lo crea vía su PATCH, todavía no se
 *    escaneó/subió). La licencia NO puede subir (su presign da 404 "no existe perfil"), así que NO se sube
 *    nada y el sheet avisa "primero escaneá tu DNI".
 *  - `error`: la subida del binario o el onboarding fallaron (red/servidor). Se CONSERVA `pendingLicense`
 *    (la captura no se pierde) para reintentar; la fase derivada de la licencia queda `error`.
 */
export type LicenseSubmitResult =
  | { status: 'ok' }
  | { status: 'needs-dni' }
  | { status: 'error'; error: unknown };

/**
 * Parámetros de la subida eager de la licencia. ESPEJA `DniSubmitParams` pero SIN `personal`: la licencia
 * NO crea el driver (lo crea el PATCH del DNI). `driverExists` es la FUENTE DE VERDAD del guard "needs-dni":
 * la licencia solo puede subir cuando el conductor YA existe server-side.
 */
export interface LicenseSubmitParams {
  /** ¿El servidor YA tiene al conductor (creado por el DNI)? `false`/unknown ⇒ `needs-dni` (no sube nada). */
  driverExists: boolean;
}

export interface LicenseSubmit {
  /** Ejecuta guard needs-dni → subir licencia (fase por cara) → onboard. Resuelve el resultado discriminado. */
  submit: (params: LicenseSubmitParams) => Promise<LicenseSubmitResult>;
  /** ¿Hay una operación en curso (subida / onboarding)? Para el estado de carga del sheet. */
  isPending: boolean;
}

/** Mapea la cara del uploader (FRONT/BACK/SINGLE) a la clave de fase del store. SINGLE cuenta como anverso. */
function faceForSide(side: DocumentSide): 'front' | 'back' {
  return side === DocumentSide.BACK ? 'back' : 'front';
}

/**
 * Orquesta la subida EAGER de la LICENCIA en su propio sheet (Lote 3), ESPEJO de `useDniSubmit` pero SIN el
 * pre-check de unicidad (la licencia no tiene blind index) y CON un guard "needs-dni" al frente:
 *
 *  1) Guard `needs-dni`: si el driver AÚN no existe (`!driverExists`), la licencia no puede subir (su presign
 *     exige el driver que crea el PATCH del DNI) → `needs-dni`, NO sube nada. El sheet pide escanear el DNI.
 *  2) Toma la licencia pendiente (`pendingLicense`). Si no hay captura → `ok` (nada que hacer).
 *  3) Sube la licencia reusando el MISMO pipeline presign→PUT→registro, con el callback POR CARA que escribe
 *     `setSendPhase('license', side, phase)` en el store (el sheet pinta anverso/reverso en vivo). CON reverso
 *     → par FRONT+BACK; SIN reverso → una sola cara SINGLE (regla de caras del backend). El `documentNumber`,
 *     el `expiresAt` (críticos, garantizados por el sheet) y la data OCR (solo si existe) viajan como en
 *     `uploadPendingLicense` de `usePersonalDataContinue`.
 *  4) Tras el upload OK, `POST /drivers/onboard` con `{ licenseNumber, licenseExpiresAt }` (la licencia
 *     alimenta el onboarding del conductor).
 *  5) Éxito → `clearPendingLicense()` → `ok`. El 409 del registro/onboard (licencia ya activa · retry) = `ok`.
 *
 * Degradación HONESTA: ante un fallo real la captura se CONSERVA (`pendingLicense`) y la fase derivada queda
 * `error` (el sheet ofrece reintentar). NUNCA se marca un envío que no ocurrió.
 */
export function useLicenseSubmit(): LicenseSubmit {
  // Reusa el MISMO uploader/use-case del paso de Documentos (no se duplica el pipeline presign→PUT→registro).
  const uploadLicense = useUploadAndRegisterDocument();
  // Subida + onboarding de la licencia: el MISMO pipeline canónico que usaba la pantalla al escanear.
  const onboardLicense = useOnboardLicense();
  const setSendPhase = useRegistrationStore((s) => s.setSendPhase);
  const clearPendingLicense = useRegistrationStore((s) => s.clearPendingLicense);

  /**
   * Sube la licencia pendiente (si la hay) AHORA que el driver existe, reportando la fase POR CARA vía el
   * callback del uploader, y dispara su onboarding. Devuelve `ok` si subió (o no había nada / 409-como-éxito);
   * `error` si la subida/onboard falló real (conserva `pendingLicense`). El `documentNumber`/`expiresAt` y la
   * data OCR viajan como en `usePersonalDataContinue`.
   */
  const uploadPendingLicense = async (): Promise<LicenseSubmitResult> => {
    const pendingLicense = useRegistrationStore.getState().pendingLicense;
    if (!pendingLicense) {
      // No hay captura para subir: nada que hacer, el flujo procede.
      return { status: 'ok' };
    }
    // Data OCR + trazabilidad (solo si el escaneo las produjo) — comunes a ambas formas de subida.
    const ocrFields = pendingLicense.extractedData
      ? {
          extractedData: pendingLicense.extractedData,
          ocrEngine: ocrEngineForPlatform(),
          ocrAt: ocrTimestampNow(),
        }
      : {};
    // Fase POR CARA: el uploader llama este callback (sending→sent/error) por cada cara mientras sube.
    const onSidePhase = (
      side: DocumentSide,
      phase: 'idle' | 'sending' | 'sent' | 'error',
    ): void => {
      setSendPhase('license', faceForSide(side), phase);
    };
    try {
      // MISMA regla de caras que el DNI (fleet `normalizeDocumentImages`): un FRONT solo se RECHAZA.
      // CON reverso → par FRONT+BACK; SIN reverso → una sola cara SINGLE (`{file}`).
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
      return { status: 'ok' };
    } catch (e) {
      // 409 = la licencia (o su onboarding) YA se registró en un intento previo (retry legítimo) → ÉXITO. Los
      // PUT de las caras fueron OK antes del registro, así que el callback ya las dejó en `sent`; limpiamos y
      // avanzamos. Detectado por status 409 tipado (`isConflictError`), no por el texto del mensaje.
      if (isConflictError(e)) {
        clearPendingLicense();
        return { status: 'ok' };
      }
      // Fallo real: si rompió el PUT de una cara, el callback ya la marcó `error`. Si rompió el REGISTRO u
      // ONBOARD (post-PUT, con las caras en `sent`), el documento NO quedó registrado → forzamos `error` en el
      // anverso para que la fase DERIVADA de la licencia sea honesta (`error`), no un `sent` que mentiría.
      setSendPhase('license', 'front', 'error');
      return { status: 'error', error: e };
    }
  };

  const submit = async ({ driverExists }: LicenseSubmitParams): Promise<LicenseSubmitResult> => {
    // 1) Guard `needs-dni`: la licencia necesita que el conductor EXISTA (lo crea el PATCH del DNI). Sin driver,
    //    el presign de la licencia da 404 → NO subimos nada; el sheet pide escanear primero el DNI.
    if (!driverExists) {
      return { status: 'needs-dni' };
    }

    // 2) Sube la licencia escaneada (fase por cara) + su onboarding. Éxito → clearPendingLicense; fallo →
    //    conserva la captura.
    return uploadPendingLicense();
  };

  return {
    submit,
    isPending: uploadLicense.isPending || onboardLicense.isPending,
  };
}
