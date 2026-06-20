import { useState } from 'react';
import { DocumentSide, FleetDocumentType } from '@veo/shared-types';
import { useDocumentScanner } from '../../../../core/di/useDi';
import { scannedImageToPickedImage } from '../../../documents/data';
import {
  isDocumentScannerError,
  parseDni,
  type DocumentSideFile,
  type PickedImage,
} from '../../../documents/domain';
import type { PersonalData } from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';
import { useUploadAndRegisterDocument } from './useRegistrationDocuments';

/**
 * Estado del flujo de escaneo del DNI (mismo vocabulario HONESTO que el sheet de documentos): nunca se
 * marca un éxito que no ocurrió.
 *  - `idle`: aún no se escaneó.
 *  - `scanning`: el escáner nativo está abierto.
 *  - `captured`: el DNI se escaneó y previsualizó (caras listas), aún sin subir.
 *  - `uploading`: presign + PUT de las caras + registro en curso.
 *  - `success`: el DNI quedó subido y registrado (en revisión).
 *  - `error`: falló alguna etapa; se muestra el motivo y se permite reintentar.
 */
export type ScanDniState = 'idle' | 'scanning' | 'captured' | 'uploading' | 'success' | 'error';

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
 * Hook que orquesta el flujo de captura del DNI por escaneo (sub-lote 3B): abre el escáner nativo a 2
 * páginas (anverso + reverso), corre el OCR del FRENTE con `parseDni`, PRELLENA de forma NO DESTRUCTIVA
 * los datos personales del wizard (solo campos vacíos) y deja las caras listas para subir como documento
 * `DNI` (FRONT + BACK) por el camino multi-cara del presign del 3A.
 *
 * Reusa por DI el `DocumentScannerService` (no conoce el módulo nativo), el parser PURO `parseDni` y el
 * caso de uso `UploadAndRegisterDocument` (vía `useUploadAndRegisterDocument`). Degradación HONESTA: el
 * escáner no disponible (`E_UNAVAILABLE`) se surfacea como `unavailable` para que la pantalla caiga al
 * tipeo manual + galería; los campos OCR ausentes quedan manuales (nunca se inventan).
 */
export function useScanDni() {
  const scanner = useDocumentScanner();
  const personal = useRegistrationStore((s) => s.personal);
  const setPersonal = useRegistrationStore((s) => s.setPersonal);
  const upload = useUploadAndRegisterDocument();

  const [state, setState] = useState<ScanDniState>('idle');
  /** El escáner no está disponible en este device → fallback honesto a tipeo manual + galería. */
  const [unavailable, setUnavailable] = useState(false);
  /** Motivo accionable del último fallo (cancelación/escaneo/subida), o `null` si no hay. */
  const [message, setMessage] = useState<string | null>(null);
  /** Caras capturadas a la espera de subir (front siempre; back si se escaneó el reverso). */
  const [sides, setSides] = useState<{ front: PickedImage; back: PickedImage | null } | null>(null);
  /** Qué campos personales se prellenaron desde el OCR (para los marcadores de la UI). */
  const [autofilled, setAutofilled] = useState<DniAutofillResult>(NO_AUTOFILL);

  /**
   * PRELLENADO NO DESTRUCTIVO de los datos personales desde el OCR del frente. Solo escribe un campo si:
   *  (1) el parser lo extrajo con confianza, Y
   *  (2) el campo del store está VACÍO (el conductor no lo tipeó/corrigió todavía).
   * Así, un dato que el conductor ya editó NUNCA lo pisa el OCR (su edición gana). Mapea los nombres del
   * parser a los del store: `documentNumber→dni`, `fullName→fullName`, `birthDate→birthdate` (este último
   * ya viene en ISO `AAAA-MM-DD`, compatible con el `DateField`). Devuelve qué campos se escribieron.
   */
  const applyAutofill = (frontLines: readonly string[]): DniAutofillResult => {
    const parsed = parseDni(frontLines);
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
    if (state === 'scanning' || state === 'uploading') {
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
        setMessage('scanFailed');
        return null;
      }
      const front = scannedImageToPickedImage(frontBase64, 'dni-front.jpg');
      // Si solo vino una imagen, asumimos FRONT y dejamos el reverso pendiente (el conductor reescanea).
      const backBase64 = images[1];
      const back = backBase64 ? scannedImageToPickedImage(backBase64, 'dni-back.jpg') : null;

      // OCR del FRENTE (la cédula peruana lleva nombre/DNI/nacimiento en el anverso). textLines[0] alinea
      // con images[0] por contrato del escáner. Prellenado NO destructivo.
      const result = applyAutofill(textLines[0] ?? []);

      setSides({ front, back });
      setAutofilled(result);
      setState('captured');
      return { front, back, autofilled: result };
    } catch (e) {
      if (isDocumentScannerError(e, 'E_CANCELLED')) {
        // Cancelar NO es un fallo: informamos que puede reintentar o tipear a mano.
        setState('idle');
        setMessage('scanCancelled');
        return null;
      }
      if (isDocumentScannerError(e, 'E_UNAVAILABLE')) {
        // Degradación honesta: el escáner no existe en este device → tipeo manual + galería.
        setState('idle');
        setUnavailable(true);
        return null;
      }
      setState('error');
      setMessage('scanFailed');
      return null;
    }
  };

  /**
   * Sube el DNI capturado como documento `DNI` por el camino multi-cara: presign con las caras presentes
   * (FRONT siempre; BACK si se capturó) → PUT de cada binario → registro con `images: [{ s3Key, side }]`
   * y `documentNumber` = el DNI CONFIRMADO (el del store, ya editable por el conductor). Nunca registra si
   * la subida falló (lo garantiza el caso de uso). Devuelve `true` si quedó subido, `false` si falló.
   */
  const submit = async (): Promise<boolean> => {
    if (!sides || state === 'uploading') {
      return false;
    }
    setMessage(null);
    setState('uploading');

    // Caras a subir: FRONT siempre; BACK solo si se capturó (degradación honesta: una cara es válida).
    const sideFiles: DocumentSideFile[] = [{ side: DocumentSide.FRONT, file: sides.front }];
    if (sides.back) {
      sideFiles.push({ side: DocumentSide.BACK, file: sides.back });
    }

    // El número del documento es el del store: o el extraído por OCR o el tipeado/corregido por el conductor.
    const documentNumber = useRegistrationStore.getState().personal.dni.trim();

    try {
      await upload.mutateAsync({
        type: FleetDocumentType.DNI,
        sides: sideFiles,
        ...(documentNumber.length > 0 ? { documentNumber } : {}),
      });
      setState('success');
      return true;
    } catch {
      setState('error');
      setMessage('uploadFailed');
      return false;
    }
  };

  /** Reinicia el flujo (al cerrar el sheet o reabrirlo limpio). */
  const reset = (): void => {
    setState('idle');
    setUnavailable(false);
    setMessage(null);
    setSides(null);
    setAutofilled(NO_AUTOFILL);
  };

  return {
    state,
    unavailable,
    /** Clave i18n del mensaje (bajo `registration.documents.*`/`registration.personal.scanDni.*`), o null. */
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
