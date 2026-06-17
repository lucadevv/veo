/**
 * Feature KYC (verificación de identidad / captura facial del pasajero).
 *
 * Arquitectura clean feature-first:
 *  - domain/      → entidades, puerto del repositorio (DIP) y casos de uso (reglas puras).
 *  - data/        → contrato LOCAL zod (provisional) + repositorio HTTP real contra el public-bff.
 *  - presentation → pantalla de cámara (WebRTC), hooks de permiso, store de captura y el puerto
 *                   `KycFrameSource` que aísla el "grab frame" (sin lib de captura en este hilo).
 */
export * from './domain/entities';
export type {
  KycRepository,
  KycSubmission,
  KycSubmissionResult,
} from './domain/kycRepository';
export {
  RequestKycChallengeUseCase,
  SubmitKycUseCase,
  KycValidationError,
  MIN_KYC_FRAMES,
  MAX_KYC_FRAMES,
} from './domain/usecases';
export {KycCameraScreen} from './presentation';
