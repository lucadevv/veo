import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DocumentSide, type FleetDocumentType } from '@veo/shared-types';
import { ApiError, type ExtractedDocumentData, type OcrEngineValue } from '@veo/api-client';
import { useDocumentUploader, useRepositories } from '../../../../core/di/useDi';
import { useSessionStore } from '../../../../core/session/sessionStore';
import {
  UploadAndRegisterDocumentUseCase,
  type DocumentRegistrar,
  type DocumentSideFile,
  type DriverDocument,
  type PickedImage,
  type RegisterDocumentInput,
} from '../../../documents/domain';
import type {
  BiometricEnrollInput,
  LicenseOnboardInput,
  RegistrationDocumentRequest,
} from '../../domain';

/** Clave de caché del listado de documentos del alta (rehidratación de los chips). */
export const REGISTRATION_DOCUMENTS_QUERY_KEY = ['registration', 'documents'] as const;

/**
 * Query: documentos reales del conductor (`GET /drivers/me/documents`). La pantalla del paso de
 * documentos del alta usa `simpleStatus` para pintar el chip de estado real de cada documento.
 */
export function useRegistrationDocuments() {
  const { registration } = useRepositories();
  const sessionStatus = useSessionStore((s) => s.status);
  return useQuery({
    queryKey: REGISTRATION_DOCUMENTS_QUERY_KEY,
    queryFn: () => registration.listDocuments(),
    // Mismo guard de auth que el gate del perfil (useRegistrationGate): NO dispares
    // `GET /drivers/me/documents` sin sesión autenticada — un conductor nuevo daría 404/401. La
    // hidratación del resume corre vía el gate, así que sin este guard pegaría igual al reanudar sin sesión.
    enabled: sessionStatus === 'authenticated',
    // Mismo criterio de reintento que el gate: el 4xx (404 conductor sin docs) es DEFINITIVO; solo se
    // reintentan errores reintentables (red / 5xx / 429, vía `ApiError.retryable`).
    retry: (failureCount, error) =>
      error instanceof ApiError && error.retryable && failureCount < 2,
  });
}

/**
 * Mutación: registra/actualiza un documento del alta (`POST /drivers/me/documents`). Al confirmar,
 * invalida la query del listado para que los chips reflejen el nuevo estado ("en revisión").
 */
export function useSubmitRegistrationDocument() {
  const { registration } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RegistrationDocumentRequest) => registration.submitDocument(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REGISTRATION_DOCUMENTS_QUERY_KEY });
    },
  });
}

/**
 * Mutación: alta de licencia del conductor (`POST /drivers/onboard`, `driverOnboardRequest`).
 * Se dispara junto al registro del documento de licencia en el paso de documentos.
 */
export function useOnboardLicense() {
  const { registration } = useRepositories();
  return useMutation({
    mutationFn: (input: LicenseOnboardInput) => registration.onboardLicense(input),
  });
}

/**
 * Mutación: enrolamiento biométrico del alta (`POST /drivers/biometric/enroll`, UNA foto en base64).
 * La presentación solo la invoca cuando el proveedor de captura entrega una foto real (Lote 2: selfie
 * simple, sin reto/frames de liveness).
 */
export function useEnrollBiometric() {
  const { registration } = useRepositories();
  return useMutation({
    mutationFn: (input: BiometricEnrollInput) => registration.enrollBiometric(input),
  });
}

/**
 * Entrada de la subida+registro del documento desde la presentación (tipo fleet + caras + metadatos).
 *
 * Dos formas mutuamente excluyentes para la(s) imagen(es):
 *  - `file`: UNA imagen (caso histórico licencia/SOAT/tarjeta/foto). El hook la envía como cara `SINGLE`.
 *  - `sides`: N caras tipadas (sub-lote 3B · DNI → `[{ side: FRONT, file }, { side: BACK, file }]`).
 * Se exige al menos una. Si se pasan ambas, `sides` manda (es el camino explícito multi-cara).
 */
export interface UploadDocumentVars {
  /** `FleetDocumentType` canónico (p. ej. `LICENSE_A1` | `SOAT` | `PROPERTY_CARD` | `DNI`), no string libre. */
  type: FleetDocumentType;
  /** Archivo local de UNA cara (compat). El hook lo mapea a `[{ side: SINGLE, file }]`. */
  file?: PickedImage;
  /** Caras tipadas (1..N) cuando el documento tiene varias imágenes (DNI → FRONT + BACK). */
  sides?: DocumentSideFile[];
  /** Número del documento. Opcional POR TIPO: la foto del vehículo (VEHICLE_PHOTO) no lo tiene. */
  documentNumber?: string;
  /** Vencimiento en ISO-8601 (si el conductor lo ingresó / es requerido). */
  expiresAt?: string;
  /** Lote 1: data extraída por OCR on-device (unión discriminada). Solo si el escaneo la produjo. */
  extractedData?: ExtractedDocumentData;
  /** Motor de OCR que produjo `extractedData` (enum cerrado). Trazabilidad. Solo si hay `extractedData`. */
  ocrEngine?: OcrEngineValue;
  /** Instante de la extracción OCR (ISO-8601). Solo si hay `extractedData`. */
  ocrAt?: string;
}

/**
 * Normaliza las caras a subir desde `UploadDocumentVars`: prioriza `sides` (camino multi-cara explícito);
 * si no, envuelve `file` como una única cara `SINGLE` (compat con licencia/SOAT/tarjeta/foto). Lanza si
 * no se entregó ninguna imagen (error de programación de la presentación, no del conductor).
 */
function resolveSides(vars: UploadDocumentVars): DocumentSideFile[] {
  if (vars.sides && vars.sides.length > 0) {
    return vars.sides;
  }
  if (vars.file) {
    return [{ side: DocumentSide.SINGLE, file: vars.file }];
  }
  throw new Error('UploadDocumentVars requiere `file` o `sides` con al menos una imagen');
}

/**
 * Mutación: SUBE el binario del documento al almacén soberano y luego lo REGISTRA con su `fileS3Key`
 * (`UploadAndRegisterDocumentUseCase`). El registrador es el repositorio de registro
 * (`POST /drivers/me/documents`), que ya valida el body con el contrato. Al confirmar, invalida el
 * listado para que los chips reflejen el estado real. Surfacea los errores tipados de cada etapa
 * (`DocumentUploadError` en presign/read/upload/network; `ApiError` en el registro) sin fingir éxito.
 */
export function useUploadAndRegisterDocument() {
  const { registration } = useRepositories();
  const uploader = useDocumentUploader();
  const queryClient = useQueryClient();

  // El registrador adapta el repositorio de registro al puerto mínimo del caso de uso.
  const registrar: DocumentRegistrar = {
    register: (input: RegisterDocumentInput): Promise<DriverDocument> =>
      // `RegistrationDocumentRequest` y `RegisterDocumentInput` son ambos `AddDocumentRequest`.
      registration.submitDocument(input as RegistrationDocumentRequest),
  };

  return useMutation({
    mutationFn: (vars: UploadDocumentVars): Promise<DriverDocument> =>
      new UploadAndRegisterDocumentUseCase(uploader, registrar).execute({
        type: vars.type,
        sides: resolveSides(vars),
        metadata: {
          ...(vars.documentNumber ? { documentNumber: vars.documentNumber } : {}),
          ...(vars.expiresAt ? { expiresAt: vars.expiresAt } : {}),
          ...(vars.extractedData ? { extractedData: vars.extractedData } : {}),
          ...(vars.ocrEngine ? { ocrEngine: vars.ocrEngine } : {}),
          ...(vars.ocrAt ? { ocrAt: vars.ocrAt } : {}),
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REGISTRATION_DOCUMENTS_QUERY_KEY });
    },
  });
}
