import { useState } from 'react';
import { VehicleType } from '@veo/shared-types';
import type { ExtractedPropertyCardData } from '@veo/api-client';
import { useDocumentScanner } from '../../../../core/di/useDi';
import { scannedImageToPickedImage } from '../../../../core/scanning/scanned-image-to-picked-image';
import {
  isDocumentScannerError,
  mapMtcCategoryToVehicleType,
  parsePropertyCard,
  parsedPropertyCardToExtracted,
  type ParsedPropertyCard,
  type PickedImage,
  type ScanMessage,
} from '../../../documents/domain';
import { isVehicleYearValid, type VehicleData } from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';

/**
 * Estado del flujo de escaneo de la TARJETA DE PROPIEDAD (Lote 2 · scan-first del paso 2). Mismo
 * vocabulario HONESTO que el escaneo del DNI: nunca se marca un éxito que no ocurrió.
 *  - `idle`: aún no se escaneó.
 *  - `scanning`: el escáner nativo está abierto.
 *  - `captured`: la tarjeta se escaneó y previsualizó, aún sin confirmar.
 *  - `error`: falló el escaneo; se muestra el motivo y se permite reintentar.
 *
 * (No hay `ready` separado como en el DNI: la confirmación de la tarjeta es la creación del vehículo en
 * `useVehicleContinue`; este hook solo escanea + prellena + deja la imagen pendiente para la subida diferida.)
 */
export type ScanPropertyCardState = 'idle' | 'scanning' | 'captured' | 'error';

/**
 * Campos del vehículo que el OCR de la tarjeta pudo PRELLENAR. La presentación los usa para mostrar lo
 * que se leyó (read-only) y para el gating del campo crítico (placa). Solo se marca un campo si el parser
 * lo extrajo con confianza Y el campo del store estaba vacío (no pisa lo que el conductor ya tocó).
 */
export interface PropertyCardAutofillResult {
  plate: boolean;
  year: boolean;
  make: boolean;
  model: boolean;
  /** El color de carrocería se leyó de la tarjeta (`Color:`) y se prellenó en el store. */
  color: boolean;
  /** El tipo de vehículo se derivó de la categoría MTC (M1→CAR / L*→MOTO) y se fijó en el store. */
  vehicleType: boolean;
}

/** Resultado del escaneo de la tarjeta: imagen capturada + qué campos del vehículo se prellenaron. */
export interface PropertyCardScanOutcome {
  /** Imagen de la tarjeta, lista para subir. Siempre presente cuando el escaneo resuelve. */
  front: PickedImage;
  /** Qué campos del store se prellenaron desde el OCR (para los marcadores de la UI). */
  autofilled: PropertyCardAutofillResult;
  /** `VehicleType` derivado de la categoría MTC (`null` si la categoría no es soportada hoy). */
  derivedType: VehicleType | null;
  /**
   * La tarjeta trae una categoría MTC pero NO es soportada hoy (N1 furgón / M2·M3 buses / *SC especiales):
   * `mapMtcCategoryToVehicleType` devolvió `null`. La pantalla cae al selector manual de tipo (honesto).
   * Ampliar el enum `VehicleType` para esas categorías es un lote futuro.
   */
  mtcUnsupported: boolean;
}

const NO_AUTOFILL: PropertyCardAutofillResult = {
  plate: false,
  year: false,
  make: false,
  model: false,
  color: false,
  vehicleType: false,
};

/** La tarjeta de propiedad / TIVe es UNA sola página (a diferencia del DNI, anverso + reverso). */
const PROPERTY_CARD_MAX_PAGES = 1;

/**
 * Mapea un `ParsedPropertyCard` a la `ExtractedPropertyCardData` del contrato, o `null` si el OCR no
 * extrajo NINGÚN campo (el mapper siempre devuelve al menos el discriminante `type`; un objeto con SOLO
 * `type` se trata como ausencia → la tarjeta se sube sin `extractedData`). Degradación honesta: nunca se
 * envía un `extractedData` vacío fingiendo que el OCR leyó algo.
 */
function toExtractedOrNull(parsed: ParsedPropertyCard): ExtractedPropertyCardData | null {
  const extracted = parsedPropertyCardToExtracted(parsed);
  return Object.keys(extracted).length > 1 ? extracted : null;
}

/**
 * Hook que orquesta el flujo scan-first de la tarjeta de propiedad (Lote 2): abre el escáner nativo a UNA
 * página, corre el OCR con `parsePropertyCard`, DERIVA el `VehicleType` de la categoría MTC impresa
 * (`mapMtcCategoryToVehicleType`: M1→CAR, L*→MOTO, resto→null), PRELLENA de forma NO DESTRUCTIVA los datos
 * del vehículo del wizard (solo campos vacíos): placa, año, marca/modelo a TEXTO LIBRE, y fija el tipo si
 * la categoría es soportada. GUARDA la imagen + la data OCR (`ExtractedPropertyCardData`) en el store
 * (`pendingPropertyCard`) para la subida DIFERIDA tras crear el vehículo (igual patrón que el DNI del paso 1).
 *
 * modelSpecId es OPCIONAL en el contrato (`registerVehicleRequest.refine`): el scan toma la RAMA TEXTO
 * LIBRE (make/model del OCR), sin tocar el catálogo. El fuzzy-match a catálogo + crecimiento del mismo es
 * un Lote 3 — acá la marca/modelo viajan como texto y el backend usa el `vehicleType` derivado.
 *
 * Reusa por DI el `DocumentScannerService` (no conoce el módulo nativo) y los parsers PUROS. Degradación
 * HONESTA: el escáner no disponible (`E_UNAVAILABLE`) se surfacea como `unavailable` para que la pantalla
 * caiga a la carga manual; los campos OCR ausentes quedan manuales (no se inventan); categoría no soportada
 * cae al selector manual de tipo.
 */
export function useScanPropertyCard() {
  const scanner = useDocumentScanner();
  const vehicle = useRegistrationStore((s) => s.vehicle);
  const setVehicle = useRegistrationStore((s) => s.setVehicle);
  const setVehicleType = useRegistrationStore((s) => s.setVehicleType);
  const setPendingPropertyCard = useRegistrationStore((s) => s.setPendingPropertyCard);

  const [state, setState] = useState<ScanPropertyCardState>('idle');
  /** El escáner no está disponible en este device → fallback honesto a la carga manual. */
  const [unavailable, setUnavailable] = useState(false);
  /** Motivo accionable TIPADO del último fallo (cancelación/escaneo), o `null` si no hay. */
  const [message, setMessage] = useState<ScanMessage | null>(null);
  /** Imagen capturada a la espera de subir (siempre que haya captura). */
  const [front, setFront] = useState<PickedImage | null>(null);
  /** Qué campos del vehículo se prellenaron desde el OCR (para los marcadores de la UI). */
  const [autofilled, setAutofilled] = useState<PropertyCardAutofillResult>(NO_AUTOFILL);
  /** `VehicleType` derivado de la categoría MTC, o `null` si la categoría no es soportada hoy. */
  const [derivedType, setDerivedType] = useState<VehicleType | null>(null);
  /** La categoría MTC vino pero no es soportada hoy → la pantalla cae al selector manual de tipo. */
  const [mtcUnsupported, setMtcUnsupported] = useState(false);

  /**
   * PRELLENADO NO DESTRUCTIVO de los datos del vehículo desde un `ParsedPropertyCard` ya resuelto y el
   * `VehicleType` derivado de la categoría MTC. Solo escribe un campo si (1) el OCR lo extrajo con
   * confianza, Y (2) el campo del store está VACÍO (el conductor no lo tocó). Mapea los nombres del parser
   * a los del store: `make→brand`, `model→model`, `year(number)→year(string)`, `plate→plate`. El tipo se
   * fija solo si la categoría derivó a un `VehicleType` soportado (M1/L*); si no, queda el selector manual.
   * Devuelve qué campos se escribieron (incluido `vehicleType`).
   */
  const applyAutofill = (
    parsed: ParsedPropertyCard,
    type: VehicleType | null,
  ): PropertyCardAutofillResult => {
    const current = useRegistrationStore.getState().vehicle;
    const isEmpty = (field: 'plate' | 'year' | 'brand' | 'model' | 'color'): boolean =>
      current[field].trim().length === 0;

    const patch: Partial<VehicleData> = {};
    const result: PropertyCardAutofillResult = { ...NO_AUTOFILL };

    if (parsed.plate && isEmpty('plate')) {
      patch.plate = parsed.plate;
      result.plate = true;
    }
    // El parser del OCR acepta 1950..2099, MÁS LAXO que el contrato (`MIN_VEHICLE_YEAR`..actual+1). Solo
    // prellenamos el año si cae en el rango VÁLIDO: un año fuera de rango (p. ej. un modelo <2005) NO se
    // escribe → el campo queda VACÍO y la pantalla lo trata como CORREGIBLE (input de año en el camino scan),
    // en vez de fingir "capturada ✓" y reventar con `year_invalid` al Registrar (degradación honesta).
    if (parsed.year !== undefined && isVehicleYearValid(String(parsed.year)) && isEmpty('year')) {
      patch.year = String(parsed.year);
      result.year = true;
    }
    // Marca/modelo a TEXTO LIBRE (sin `modelSpecId`): el catálogo no se toca en Lote 2 (fuzzy-match = Lote 3).
    // El parser usa `make`; el store guarda la marca en `brand` (solo presentación + texto libre al body).
    if (parsed.make && isEmpty('brand')) {
      patch.brand = parsed.make;
      result.make = true;
    }
    if (parsed.model && isEmpty('model')) {
      patch.model = parsed.model;
      result.model = true;
    }
    // Color de carrocería leído de la tarjeta (`Color:`): no destructivo, igual que marca/modelo. Viaja
    // opcional al backend (`registerVehicleRequest.color`); vacío si el OCR no lo leyó (degradación honesta).
    if (parsed.color && isEmpty('color')) {
      patch.color = parsed.color;
      result.color = true;
    }

    if (Object.keys(patch).length > 0) {
      setVehicle(patch);
    }
    // LOTE 1: `mtcCategory` y `vehicleType` son AMBOS DERIVADOS de la tarjeta (no editables por el usuario)
    // y deben moverse JUNTOS en cada escaneo — NO de forma no-destructiva. Si se escribiera mtcCategory solo
    // cuando está vacía pero el tipo se reescribiera siempre, un re-escaneo dejaría la categoría STALE (la
    // previa) y el tipo nuevo: el backend re-deriva de la categoría vieja y descarta el tipo (divergencia
    // "auto silencioso"). Por eso, cuando el OCR trae categoría, se setea SIEMPRE, en sincronía con el tipo.
    if (parsed.mtcCategory) {
      setVehicle({ mtcCategory: parsed.mtcCategory });
    }
    // Tipo derivado de la categoría MTC impresa: solo se fija si es soportado (M1→CAR / L*→MOTO). Para una
    // categoría no soportada (null) NO se inventa un tipo → la pantalla muestra el selector manual.
    if (type !== null) {
      setVehicleType(type);
      result.vehicleType = true;
    }
    return result;
  };

  /**
   * Abre el escáner de la tarjeta (1 página) y, al capturar, corre el OCR y PRELLENA el store. Resuelve
   * con el resultado (`PropertyCardScanOutcome`) o `null` si no hubo captura (cancelado/no disponible/
   * fallo). Degradación por código tipado (sin strings mágicos): `E_CANCELLED` no es error, `E_UNAVAILABLE`
   * cae a manual, el resto es un fallo accionable con reintento.
   */
  const scan = async (): Promise<PropertyCardScanOutcome | null> => {
    if (state === 'scanning') {
      return null;
    }
    setMessage(null);
    setUnavailable(false);
    setState('scanning');
    try {
      const { images, textLines } = await scanner.scan({ maxPages: PROPERTY_CARD_MAX_PAGES });
      const frontBase64 = images[0];
      if (!frontBase64) {
        // El escáner resolvió sin imágenes: lo tratamos como fallo de captura (no éxito silencioso).
        setState('error');
        setMessage('scan-failed');
        return null;
      }
      const picked = scannedImageToPickedImage(frontBase64, 'property-card.jpg');

      // OCR de la tarjeta: una sola página → `textLines[0]`. Se parsea UNA vez: el resultado alimenta el
      // prellenado NO destructivo, la categoría MTC para derivar el tipo, Y la data OCR del contrato.
      const parsed = parsePropertyCard(textLines[0] ?? []);

      // Deriva el `VehicleType` de la categoría MTC impresa (M1→CAR, L*→MOTO, resto→null). Si la tarjeta
      // TRAE categoría pero no es soportada hoy (N1/M2/M3/*SC), `mtcUnsupported` activa el selector manual.
      const type = parsed.mtcCategory ? mapMtcCategoryToVehicleType(parsed.mtcCategory) : null;

      const unsupported = parsed.mtcCategory != null && type === null;

      const result = applyAutofill(parsed, type);
      const extracted = toExtractedOrNull(parsed);

      setFront(picked);
      setAutofilled(result);
      setDerivedType(type);
      setMtcUnsupported(unsupported);
      // Guarda la imagen + la data OCR como tarjeta pendiente apenas se captura: el continue del paso 2 la
      // sube DESPUÉS de crear el vehículo. Idempotente: re-escanear reemplaza, no duplica.
      setPendingPropertyCard({ front: picked, extractedData: extracted });
      setState('captured');
      return { front: picked, autofilled: result, derivedType: type, mtcUnsupported: unsupported };
    } catch (e) {
      if (isDocumentScannerError(e, 'E_CANCELLED')) {
        // Cancelar NO es un fallo: informamos que puede reintentar o cargar a mano.
        setState('idle');
        setMessage('scan-cancelled');
        return null;
      }
      if (isDocumentScannerError(e, 'E_UNAVAILABLE')) {
        // Degradación honesta: el escáner no existe en este device → carga manual.
        setState('idle');
        setUnavailable(true);
        return null;
      }
      setState('error');
      setMessage('scan-failed');
      return null;
    }
  };

  /** Reinicia el flujo (al cerrar el sheet o reabrirlo limpio). */
  const reset = (): void => {
    setState('idle');
    setUnavailable(false);
    setMessage(null);
    setFront(null);
    setAutofilled(NO_AUTOFILL);
    setDerivedType(null);
    setMtcUnsupported(false);
  };

  return {
    state,
    unavailable,
    /** Motivo TIPADO del último fallo de escaneo (`ScanMessage`), o null. La UI lo mapea a i18n. */
    message,
    front,
    autofilled,
    derivedType,
    mtcUnsupported,
    /** Datos del vehículo vivos (para que la pantalla muestre lo que se prellenó). */
    vehicle,
    scan,
    reset,
  };
}
