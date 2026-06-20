import { useState } from 'react';
import type { ExtractedDniData } from '@veo/api-client';
import { useDocumentScanner } from '../../../../core/di/useDi';
import { scannedImageToPickedImage } from '../../../documents/data';
import {
  isDocumentScannerError,
  parseDni,
  parsedDniToExtracted,
  type ParsedDni,
  type PickedImage,
  type ScanMessage,
} from '../../../documents/domain';
import type { PersonalData } from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';

/**
 * Estado del flujo de escaneo del DNI (mismo vocabulario HONESTO que el sheet de documentos): nunca se
 * marca un éxito que no ocurrió.
 *  - `idle`: aún no se escaneó.
 *  - `scanning`: el escáner nativo está abierto.
 *  - `captured`: el DNI se escaneó y previsualizó (caras listas), aún sin confirmar.
 *  - `ready`: las caras quedaron guardadas en el store para subirse DESPUÉS del PATCH /personal (que
 *    crea el driver). El escaneo NUNCA sube en el momento: el presign del DNI exige que el driver ya
 *    exista, y eso ocurre recién en el `onContinue` de los datos personales (BUG de secuencia corregido).
 *  - `error`: falló el escaneo; se muestra el motivo y se permite reintentar.
 */
export type ScanDniState = 'idle' | 'scanning' | 'captured' | 'ready' | 'error';

/**
 * Campos de los datos personales que el OCR del DNI pudo PRELLENAR. La presentación los usa para marcar
 * "Extraído de tu DNI — confirma" en cada campo que vino del escaneo (y limpiar el marcador al editar).
 * Solo se incluye un campo si el parser lo extrajo con confianza Y el campo del store estaba vacío.
 */
export interface DniAutofillResult {
  dni: boolean;
  fullName: boolean;
  birthdate: boolean;
}

/** Resultado del escaneo del DNI: las caras capturadas + qué campos personales se prellenaron. */
export interface DniScanOutcome {
  /** Imagen del anverso (FRONT), lista para subir. Siempre presente cuando el escaneo resuelve. */
  front: PickedImage;
  /** Imagen del reverso (BACK) si el escáner capturó la 2ª página; `null` si solo vino una. */
  back: PickedImage | null;
  /** Qué campos del store se prellenaron desde el OCR del frente (para los marcadores de la UI). */
  autofilled: DniAutofillResult;
}

const NO_AUTOFILL: DniAutofillResult = { dni: false, fullName: false, birthdate: false };

/** Máximo de páginas del escaneo del DNI: anverso + reverso en una misma sesión nativa. */
const DNI_MAX_PAGES = 2;

/**
 * Mapea un `ParsedDni` a la `ExtractedDniData` del contrato, o `null` si el OCR no extrajo NINGÚN campo
 * (el mapper siempre devuelve al menos el discriminante `type`; un objeto con SOLO `type` no aporta data
 * y se trata como ausencia → el DNI se sube sin `extractedData`). Degradación honesta: nunca se envía un
 * `extractedData` vacío fingiendo que el OCR leyó algo.
 */
function toExtractedDniOrNull(parsed: ParsedDni): ExtractedDniData | null {
  const extracted = parsedDniToExtracted(parsed);
  // Solo el discriminante presente → sin campos leídos.
  return Object.keys(extracted).length > 1 ? extracted : null;
}

/**
 * Hook que orquesta el flujo de captura del DNI por escaneo (sub-lote 3B): abre el escáner nativo a 2
 * páginas (anverso + reverso), corre el OCR del FRENTE con `parseDni`, PRELLENA de forma NO DESTRUCTIVA
 * los datos personales del wizard (solo campos vacíos) y GUARDA las caras en el store (`pendingDni`)
 * para subirlas DESPUÉS del `PATCH /drivers/me/personal`.
 *
 * BUG de secuencia (corregido): el escaneo NUNCA sube en el momento. El presign del DNI exige que el
 * driver YA exista, y el driver se crea recién en el PATCH del `onContinue` del paso 1; subir antes daba
 * 404 "no existe perfil". La subida diferida (reusando el `UploadAndRegisterDocument`) la hace
 * `usePersonalDataContinue` tras el PATCH. Este hook solo escanea + prellena + deja las caras pendientes.
 *
 * Reusa por DI el `DocumentScannerService` (no conoce el módulo nativo) y el parser PURO `parseDni`.
 * Degradación HONESTA: el escáner no disponible (`E_UNAVAILABLE`) se surfacea como `unavailable` para
 * que la pantalla caiga al tipeo manual + galería; los campos OCR ausentes quedan manuales (no se inventan).
 */
export function useScanDni() {
  const scanner = useDocumentScanner();
  const personal = useRegistrationStore((s) => s.personal);
  const setPersonal = useRegistrationStore((s) => s.setPersonal);
  const setPendingDni = useRegistrationStore((s) => s.setPendingDni);

  const [state, setState] = useState<ScanDniState>('idle');
  /** El escáner no está disponible en este device → fallback honesto a tipeo manual + galería. */
  const [unavailable, setUnavailable] = useState(false);
  /** Motivo accionable TIPADO del último fallo (cancelación/escaneo), o `null` si no hay. */
  const [message, setMessage] = useState<ScanMessage | null>(null);
  /** Caras capturadas a la espera de subir (front siempre; back si se escaneó el reverso). */
  const [sides, setSides] = useState<{ front: PickedImage; back: PickedImage | null } | null>(null);
  /** Qué campos personales se prellenaron desde el OCR (para los marcadores de la UI). */
  const [autofilled, setAutofilled] = useState<DniAutofillResult>(NO_AUTOFILL);
  /**
   * Lote 1: data OCR del DNI mapeada al contrato (`ExtractedDniData`), capturada en el scan para enviarla
   * al registrar el DNI tras el PATCH. `null` si el OCR no extrajo ningún campo con confianza (se sube
   * sin `extractedData` — degradación honesta). Se computa una sola vez por scan (sin re-parsear).
   */
  const [extractedData, setExtractedData] = useState<ExtractedDniData | null>(null);

  /**
   * PRELLENADO NO DESTRUCTIVO de los datos personales desde un `ParsedDni` ya resuelto. Solo escribe un
   * campo si:
   *  (1) el parser lo extrajo con confianza, Y
   *  (2) el campo del store está VACÍO (el conductor no lo tipeó/corrigió todavía).
   * Así, un dato que el conductor ya editó NUNCA lo pisa el OCR (su edición gana). El `parsed` lo computa
   * `scan` UNA sola vez (con `parseDni`, que prioriza el MRZ TD1 del reverso del DNIe y cae a las etiquetas
   * del frente). Mapea los nombres del parser a los del store: `documentNumber→dni`, `fullName→fullName`,
   * `birthDate→birthdate` (ISO `AAAA-MM-DD`, compatible con el `DateField`). Devuelve qué campos se escribieron.
   */
  const applyAutofill = (parsed: ParsedDni): DniAutofillResult => {
    const current = useRegistrationStore.getState().personal;
    const isEmpty = (field: keyof PersonalData): boolean => current[field].trim().length === 0;

    const patch: Partial<PersonalData> = {};
    const result: DniAutofillResult = { ...NO_AUTOFILL };

    if (parsed.documentNumber && isEmpty('dni')) {
      patch.dni = parsed.documentNumber;
      result.dni = true;
    }
    if (parsed.fullName && isEmpty('fullName')) {
      patch.fullName = parsed.fullName;
      result.fullName = true;
    }
    if (parsed.birthDate && isEmpty('birthdate')) {
      patch.birthdate = parsed.birthDate;
      result.birthdate = true;
    }

    if (Object.keys(patch).length > 0) {
      setPersonal(patch);
    }
    return result;
  };

  /**
   * Abre el escáner del DNI (2 páginas) y, al capturar, corre el OCR del frente y PRELLENA el store.
   * Resuelve con el resultado (`DniScanOutcome`) o `null` si no hubo captura (cancelado/no disponible/
   * fallo). Degradación por código tipado (sin strings mágicos): `E_CANCELLED` no es error, `E_UNAVAILABLE`
   * cae a manual + galería, el resto es un fallo accionable con reintento.
   */
  const scan = async (): Promise<DniScanOutcome | null> => {
    if (state === 'scanning') {
      return null;
    }
    setMessage(null);
    setUnavailable(false);
    setState('scanning');
    try {
      const { images, textLines } = await scanner.scan({ maxPages: DNI_MAX_PAGES });
      const frontBase64 = images[0];
      if (!frontBase64) {
        // El escáner resolvió sin imágenes: lo tratamos como fallo de captura (no éxito silencioso).
        setState('error');
        setMessage('scan-failed');
        return null;
      }
      const front = scannedImageToPickedImage(frontBase64, 'dni-front.jpg');
      // Si solo vino una imagen, asumimos FRONT y dejamos el reverso pendiente (el conductor reescanea).
      const backBase64 = images[1];
      const back = backBase64 ? scannedImageToPickedImage(backBase64, 'dni-back.jpg') : null;

      // OCR del DNI: `textLines[0]` = ANVERSO (etiquetas), `textLines[1]` = REVERSO (MRZ TD1 del DNIe).
      // `parseDni` prioriza el MRZ del reverso (plan A) y cae a las etiquetas del frente (DNI viejo).
      // Se parsea UNA vez: el resultado alimenta el prellenado NO destructivo Y la data OCR del contrato.
      const parsed = parseDni(textLines[0] ?? [], textLines[1] ?? []);
      const result = applyAutofill(parsed);
      // Lote 1: mapea el `ParsedDni` a `ExtractedDniData` (traduce `birthDate→birthdate`, omite lo no leído).
      // `null` si el OCR no extrajo NINGÚN campo (solo quedaría el discriminante): se sube sin `extractedData`.
      const extracted = toExtractedDniOrNull(parsed);

      setSides({ front, back });
      setAutofilled(result);
      setExtractedData(extracted);
      // Guarda las caras + la data OCR como DNI pendiente apenas se capturan: el `onContinue` del paso 1 las
      // sube DESPUÉS del PATCH /personal (que crea el driver). Idempotente: re-escanear reemplaza, no duplica.
      setPendingDni({ front, back, extractedData: extracted });
      setState('captured');
      return { front, back, autofilled: result };
    } catch (e) {
      if (isDocumentScannerError(e, 'E_CANCELLED')) {
        // Cancelar NO es un fallo: informamos que puede reintentar o tipear a mano.
        setState('idle');
        setMessage('scan-cancelled');
        return null;
      }
      if (isDocumentScannerError(e, 'E_UNAVAILABLE')) {
        // Degradación honesta: el escáner no existe en este device → tipeo manual + galería.
        setState('idle');
        setUnavailable(true);
        return null;
      }
      setState('error');
      setMessage('scan-failed');
      return null;
    }
  };

  /**
   * CONFIRMA el DNI capturado: NO sube en el momento (el presign del DNI exige que el driver YA exista,
   * y el driver recién se crea en el `PATCH /drivers/me/personal` del `onContinue`). En su lugar GUARDA
   * las caras (FRONT siempre; BACK si se capturó) en el store (`pendingDni`) para que el continue de los
   * datos personales las suba DESPUÉS del PATCH. Idempotente: re-confirmar reemplaza las caras pendientes
   * (no duplica). Devuelve `true` si quedaron listas para subir, `false` si no había captura.
   */
  const submit = (): boolean => {
    if (!sides) {
      return false;
    }
    setMessage(null);
    setPendingDni({ front: sides.front, back: sides.back, extractedData });
    setState('ready');
    return true;
  };

  /** Reinicia el flujo (al cerrar el sheet o reabrirlo limpio). */
  const reset = (): void => {
    setState('idle');
    setUnavailable(false);
    setMessage(null);
    setSides(null);
    setAutofilled(NO_AUTOFILL);
    setExtractedData(null);
  };

  return {
    state,
    unavailable,
    /** Motivo TIPADO del último fallo de escaneo (`ScanMessage`), o null. La UI lo mapea a i18n. */
    message,
    front: sides?.front ?? null,
    back: sides?.back ?? null,
    /** ¿Se capturó el reverso? (para avisar honestamente si falta). */
    hasBack: sides?.back != null,
    autofilled,
    /** Datos personales vivos (para que el sheet muestre lo que se prellenó). */
    personal,
    scan,
    submit,
    reset,
  };
}
