import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FleetDocumentType } from '@veo/shared-types';
import { useDocumentUploader, useRepositories } from '../../../../core/di/useDi';
import {
  UploadAndRegisterDocumentUseCase,
  type DocumentRegistrar,
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
  return useQuery({
    queryKey: REGISTRATION_DOCUMENTS_QUERY_KEY,
    queryFn: () => registration.listDocuments(),
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
 * Mutación: enrolamiento biométrico del alta (`POST /drivers/biometric/enroll`, foto en base64).
 * La presentación solo la invoca cuando el proveedor de captura entrega una foto real.
 */
export function useEnrollBiometric() {
  const { registration } = useRepositories();
  return useMutation({
    mutationFn: (input: BiometricEnrollInput) => registration.enrollBiometric(input),
  });
}

/** Entrada de la subida+registro del documento desde la presentación (tipo fleet + archivo + metadatos). */
export interface UploadDocumentVars {
  /** `FleetDocumentType` canónico (p. ej. `LICENSE_A1` | `SOAT` | `PROPERTY_CARD`), no string libre. */
  type: FleetDocumentType;
  /** Archivo local capturado/elegido por el conductor (cámara o galería). */
  file: PickedImage;
  documentNumber: string;
  /** Vencimiento en ISO-8601 (si el conductor lo ingresó / es requerido). */
  expiresAt?: string;
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
        file: vars.file,
        metadata: {
          documentNumber: vars.documentNumber,
          ...(vars.expiresAt ? { expiresAt: vars.expiresAt } : {}),
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REGISTRATION_DOCUMENTS_QUERY_KEY });
    },
  });
}
