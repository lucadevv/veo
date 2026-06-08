/**
 * Puerto biométrico (FOUNDATION §9). Motor PROPIO (biometric-service Python/ONNX) tras puerto.
 * identity-service orquesta el flujo de turno (reto → verificación → minteo de sessionRef);
 * el liveness/match real lo resuelve biometric-service.
 *
 * Contrato alineado con la API REAL del biometric-service:
 *  - POST /v1/liveness/challenge → reto de liveness activo.
 *  - POST /v1/embed             → embedding de referencia (enrolamiento).
 *  - POST /v1/verify            → veredicto liveness + match contra el embedding de referencia.
 */
export const BIOMETRIC_PROVIDER = Symbol('BIOMETRIC_PROVIDER');

export type BiometricCheckKind = 'ONBOARDING' | 'SHIFT_START' | 'REVERIFY';

/** Reto de liveness activo emitido por biometric-service. */
export interface BiometricChallenge {
  challengeId: string;
  /** Acción solicitada (p.ej. TURN_LEFT, NOD, SMILE). */
  action: string;
  /** Instrucción legible para el conductor. */
  instructions: string;
  /** Expiración ISO-8601 del reto. */
  expiresAt: string;
}

/** Entrada de verificación: frames del reto + embedding de referencia del conductor. */
export interface BiometricVerifyInput {
  /** Identificador del conductor (driverId) para trazabilidad en biometric-service. */
  driverId: string;
  challengeId: string;
  /** Frames del reto en base64 (orden temporal). */
  frames: string[];
  /** Embedding de referencia capturado en el enrolamiento. */
  referenceEmbedding: number[];
}

export interface BiometricVerifyResult {
  /** 0..100 (liveness + match). Aprobado si >= BIOMETRIC_MIN_SCORE (BR-I02). */
  score: number;
  livenessPassed: boolean;
  matchPassed: boolean;
}

export interface BiometricProvider {
  /** Emite un reto de liveness activo. */
  createChallenge(): Promise<BiometricChallenge>;
  /** Calcula el embedding de referencia de una foto (enrolamiento). */
  embed(photo: string): Promise<number[]>;
  /** Verifica los frames del reto contra el embedding de referencia. */
  verify(input: BiometricVerifyInput): Promise<BiometricVerifyResult>;
}
