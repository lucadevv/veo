import { useState } from 'react';
import { useDocumentScanner } from '../../../../core/di/useDi';
import { scannedImageToPickedImage } from '../../../../core/scanning/scanned-image-to-picked-image';
import {
  isDocumentScannerError,
  isParsableDocumentType,
  parseDocument,
  type PickedImage,
  type ScanMessage,
} from '../../../documents/domain';
import { registrationDocTypeToBackend, type RegistrationDocumentType } from '../../domain';
import {
  isCriticalFieldMissing,
  readoutFromParsed,
  type CapturedReadout,
} from '../components/documentCaptureReadout';
import { useRegistrationStore } from '../state/registrationStore';

/**
 * Estado del flujo de escaneo de la LICENCIA de conducir (CONDUCTOR · paso 1). MISMO vocabulario HONESTO
 * que el escaneo del DNI (`ScanDniState`): nunca se marca un éxito que no ocurrió.
 *  - `idle`: aún no se escaneó.
 *  - `scanning`: el escáner nativo está abierto.
 *  - `captured`: la licencia se escaneó y previsualizó (anverso listo, reverso si vino), aún sin confirmar.
 *    Si el OCR NO leyó un campo CRÍTICO (número/vencimiento), se llega igual a `captured` PERO con
 *    `criticalMissing = true` y SIN guardar `pendingLicense` (degradación honesta → reescaneo).
 *  - `ready`: la licencia quedó guardada en el store (`pendingLicense`) para subirse DESPUÉS del PATCH
 *    /personal (que crea el driver). El escaneo NUNCA sube en el momento: el presign de la licencia exige
 *    que el driver ya exista (mismo BUG de secuencia que el DNI, corregido con subida diferida).
 *  - `error`: falló el escaneo; se muestra el motivo y se permite reintentar.
 */
export type ScanLicenseState = 'idle' | 'scanning' | 'captured' | 'ready' | 'error';

/** Resultado del escaneo de la licencia: las caras capturadas + si faltó un campo crítico. */
export interface LicenseScanOutcome {
  /** Anverso (FRONT) de la licencia, listo para subir. Siempre presente cuando el escaneo resuelve. */
  front: PickedImage;
  /** Reverso (BACK) si el escáner capturó la 2ª página; `null` si solo vino el anverso (SOFT). */
  back: PickedImage | null;
  /**
   * `true` si el OCR NO leyó un campo CRÍTICO de la licencia (número o vencimiento). En ese caso NO se
   * guardó `pendingLicense` (la captura NO es válida): el conductor debe reescanear. Nunca se inventa un campo.
   */
  criticalMissing: boolean;
}

/** Etiqueta del wizard de la LICENCIA (documento del CONDUCTOR; mapea a `FleetDocumentType.LICENSE_A1`). */
const LICENSE_DOC_TYPE: RegistrationDocumentType = 'LICENSE';

/**
 * Tipo CANÓNICO de la licencia (`FleetDocumentType.LICENSE_A1`) resuelto EXACTAMENTE como el sheet/la
 * pantalla: `registrationDocTypeToBackend('LICENSE')`. Es a la vez el tipo del parser (`ParsableDocumentType`,
 * tras el guard `isParsableDocumentType`) y el tipo de la config del formulario (`RegistrationDocumentFormType`,
 * que consume `isCriticalFieldMissing`). No se inventan tipos nuevos: se reusan los del alta.
 */
const LICENSE_BACKEND_TYPE = registrationDocTypeToBackend(LICENSE_DOC_TYPE);

/** Máximo de páginas del escaneo de la licencia: anverso + reverso en una misma sesión nativa (reverso SOFT). */
const LICENSE_MAX_PAGES = 2;

/**
 * Corre el OCR del ANVERSO de la licencia y lo mapea a un `CapturedReadout` (número/vencimiento leídos +
 * `extractedData` del contrato), MISMA lógica que el `processScan` del `RegistrationDocumentSheet`: si el tipo
 * no es parseable o no hay texto, devuelve `null` (sin lectura → el gating crítico lo tratará como faltante).
 * El guard `isParsableDocumentType` NARROWEA el tipo a `ParsableDocumentType` para `parseDocument` sin castear.
 */
function readLicense(lines: readonly string[]): CapturedReadout | null {
  if (!isParsableDocumentType(LICENSE_BACKEND_TYPE) || lines.length === 0) {
    return null;
  }
  return readoutFromParsed(parseDocument(LICENSE_BACKEND_TYPE, lines));
}

/**
 * Hook que orquesta el flujo de captura de la LICENCIA de conducir por escaneo (CONDUCTOR · paso 1),
 * ESPEJO de `useScanDni` pero para la licencia: abre el escáner nativo a 2 páginas (anverso + reverso),
 * corre el OCR del ANVERSO con `parseDocument`/`readoutFromParsed`, aplica el GATING del campo CRÍTICO
 * (`isCriticalFieldMissing`: la licencia EXIGE número Y vencimiento) y, si NO falta crítico, GUARDA la
 * captura en el store (`pendingLicense`) para subirla DESPUÉS del `PATCH /drivers/me/personal`.
 *
 * Es un hook de captura + OCR PURO: NO toca la red ni sube nada. El presign de la licencia exige que el
 * driver YA exista (creado en el PATCH del continue del paso 1); subir antes daría 404. La subida diferida
 * (número + vencimiento críticos + `POST /drivers/onboard`) la hace `useLicenseSubmit` tras el PATCH.
 *
 * Reusa por DI el `DocumentScannerService` (no conoce el módulo nativo) y los parsers PUROS del alta.
 * Degradación HONESTA:
 *  - `E_CANCELLED`: cancelar NO es error → vuelve a `idle` con un mensaje accionable.
 *  - `E_UNAVAILABLE`: el escáner no existe en este device → `unavailable` (fallback manual/galería).
 *  - resto → `error` + `message` tipado (`ScanMessage`), con reintento.
 *  - campo CRÍTICO ausente (número/vencimiento) → `captured` con `criticalMissing`, SIN guardar
 *    `pendingLicense` (reescaneo). Nunca se inventa un campo ni se marca un éxito que no ocurrió.
 */
export function useScanLicense() {
  const scanner = useDocumentScanner();
  const setPendingLicense = useRegistrationStore((s) => s.setPendingLicense);
  const setSendPhase = useRegistrationStore((s) => s.setSendPhase);

  const [state, setState] = useState<ScanLicenseState>('idle');
  /** El escáner no está disponible en este device → fallback honesto a la carga manual + galería. */
  const [unavailable, setUnavailable] = useState(false);
  /** Motivo accionable TIPADO del último fallo (cancelación/escaneo), o `null` si no hay. */
  const [message, setMessage] = useState<ScanMessage | null>(null);
  /** Caras capturadas a la espera de subir (front siempre; back si se escaneó el reverso). */
  const [sides, setSides] = useState<{ front: PickedImage; back: PickedImage | null } | null>(null);
  /**
   * Lectura OCR de la licencia (número/vencimiento + `extractedData` del contrato), o `null` si no se leyó.
   * Se computa UNA vez por scan y alimenta el guardado en `pendingLicense` (y el reguardado idempotente del
   * `submit`), sin re-parsear.
   */
  const [readout, setReadout] = useState<CapturedReadout | null>(null);
  /**
   * `true` si el OCR NO leyó un campo CRÍTICO (número o vencimiento). La captura NO se guarda como
   * `pendingLicense` (degradación honesta): la UI pide REESCANEAR en vez de fingir "capturada ✓".
   */
  const [criticalMissing, setCriticalMissing] = useState(false);

  /**
   * Abre el escáner de la licencia (2 páginas) y, al capturar, corre el OCR del anverso y aplica el gating
   * del campo crítico. Resuelve con el resultado (`LicenseScanOutcome`) o `null` si no hubo captura
   * (cancelado/no disponible/fallo). Degradación por código tipado (sin strings mágicos): `E_CANCELLED` no
   * es error, `E_UNAVAILABLE` cae a manual, el resto es un fallo accionable con reintento.
   */
  const scan = async (): Promise<LicenseScanOutcome | null> => {
    if (state === 'scanning') {
      return null;
    }
    setMessage(null);
    setUnavailable(false);
    setCriticalMissing(false);
    setState('scanning');
    try {
      const { images, textLines } = await scanner.scan({ maxPages: LICENSE_MAX_PAGES });
      const frontBase64 = images[0];
      if (!frontBase64) {
        // El escáner resolvió sin imágenes: lo tratamos como fallo de captura (no éxito silencioso).
        setState('error');
        setMessage('scan-failed');
        return null;
      }
      const front = scannedImageToPickedImage(frontBase64, 'license-front.jpg');
      // Reverso SOFT: si solo vino una imagen, asumimos ANVERSO y dejamos el reverso en `null` (el par
      // FRONT+BACK se sube si hay reverso; sin él, una sola cara SINGLE — igual criterio que el DNI/sheet).
      const backBase64 = images[1];
      const back = backBase64 ? scannedImageToPickedImage(backBase64, 'license-back.jpg') : null;

      // Captura NUEVA ⇒ resetea la fase de envío de la licencia (ambas caras) a `idle`: una captura recién
      // escaneada NUNCA hereda el `sent` verde de un envío previo (sino se vería "enviada" sin subir). Solo
      // aquí (captura nueva), NO en `reset()`/apertura, para no borrar el `sent` legítimo al reabrir el sheet.
      setSendPhase('license', 'front', 'idle');
      setSendPhase('license', 'back', 'idle');

      // OCR de la licencia: `textLines[0]` = ANVERSO (número/categoría/vencimiento). El reverso NO se parsea
      // (imagen para la verificación del operador). Se parsea UNA vez: alimenta el gating Y el guardado.
      const data = readLicense(textLines[0] ?? []);
      // Gating del campo CRÍTICO (lógica PURA compartida con el sheet): la licencia EXIGE número Y vencimiento.
      const critical = isCriticalFieldMissing(LICENSE_BACKEND_TYPE, data);

      setSides({ front, back });
      setReadout(data);
      setCriticalMissing(critical);
      // El escaneo deja la captura SOLO en el estado LOCAL del hook (para la preview + el extract del sheet).
      // NO persiste `pendingLicense`: si el conductor CANCELA el sheet sin confirmar, no debe subirse un
      // documento que no confirmó. Solo `submit()` persiste (única fuente del efecto eager de subida).
      setState('captured');
      return { front, back, criticalMissing: critical };
    } catch (e) {
      if (isDocumentScannerError(e, 'E_CANCELLED')) {
        // Cancelar NO es un fallo: informamos que puede reintentar o cargar a mano.
        setState('idle');
        setMessage('scan-cancelled');
        return null;
      }
      if (isDocumentScannerError(e, 'E_UNAVAILABLE')) {
        // Degradación honesta: el escáner no existe en este device → carga manual + galería.
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
   * CONFIRMA la licencia capturada: NO sube en el momento (el presign exige que el driver YA exista, creado
   * en el `PATCH /drivers/me/personal` del continue). Re-GUARDA la captura en el store (`pendingLicense`,
   * idempotente) y pasa a `ready`. Solo procede si hay una captura VÁLIDA (caras + número + vencimiento leídos,
   * sin crítico faltante): devuelve `true` si quedó lista para subir, `false` si no había captura válida.
   */
  const submit = (): boolean => {
    if (!sides || criticalMissing || !readout?.number || !readout.expiry) {
      return false;
    }
    setMessage(null);
    setPendingLicense({
      file: sides.front,
      back: sides.back,
      documentNumber: readout.number,
      expiresAt: readout.expiry,
      extractedData: readout.extractedData,
    });
    setState('ready');
    return true;
  };

  /** Reinicia el flujo (al cerrar el sheet o reabrirlo limpio). */
  const reset = (): void => {
    setState('idle');
    setUnavailable(false);
    setMessage(null);
    setSides(null);
    setReadout(null);
    setCriticalMissing(false);
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
    /** ¿Faltó un campo CRÍTICO (número/vencimiento) tras el OCR? → la UI pide reescanear (no se guardó). */
    criticalMissing,
    /** Número de licencia leído por OCR (para que el sheet lo muestre), o `null` si no se leyó. */
    licenseNumber: readout?.number ?? null,
    /** Vencimiento de la licencia leído por OCR en ISO-8601 (para el sheet), o `null` si no se leyó. */
    expiresAt: readout?.expiry ?? null,
    scan,
    submit,
    reset,
  };
}
