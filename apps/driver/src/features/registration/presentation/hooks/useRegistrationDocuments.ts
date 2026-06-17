import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
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
