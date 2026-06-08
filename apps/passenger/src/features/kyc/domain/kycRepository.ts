import type { KycChallenge, KycFrame, KycStatus } from './entities';

/**
 * Resultado de enviar una verificación de identidad al servicio biométrico (vía public-bff).
 * Forma de DOMINIO: la capa data la deriva de la respuesta validada con zod en `kycContract`.
 */
export interface KycSubmissionResult {
  /** Estado resultante de la verificación, ya normalizado a dominio. */
  status: KycStatus;
  /** Identificador de la verificación creada en el backend (para auditoría/seguimiento). */
  verificationId?: string;
  /** Motivo legible cuando el estado es `rejected` (clave/razón del servicio biométrico). */
  reason?: string;
}

/**
 * Datos de una solicitud de verificación KYC del pasajero.
 * El `challengeId` del reto de liveness activo + uno o varios frames JPEG de la cámara frontal donde
 * el pasajero ejecuta la acción solicitada (el dominio no impone cuántos frames).
 */
export interface KycSubmission {
  /** Reto de liveness activo (emitido por `requestChallenge`) que estos frames responden. */
  challengeId: string;
  /** Frames capturados (al menos uno). El bff/biometric-service decide el liveness. */
  frames: KycFrame[];
}

/**
 * Abstracción del repositorio de KYC (DIP).
 *
 * Implementación REAL contra el public-bff (`POST /kyc/verifications`, ver `kycContract`). El
 * endpoint backend aún NO existe → al llamarlo dará 404 (ApiError status 404); es esperado y la UI
 * lo trata como error recuperable (reintentar). El contrato local se reemplaza por el soberano de
 * `@veo/api-client` en cuanto el bff lo exponga, sin tocar dominio ni presentación.
 */
export interface KycRepository {
  /** POST /kyc/challenge → pide un reto de liveness activo (acción + instrucción a mostrar). */
  requestChallenge(): Promise<KycChallenge>;
  /** POST /kyc/verifications → envía el challengeId + frames y devuelve el resultado. */
  submit(input: KycSubmission): Promise<KycSubmissionResult>;
}
