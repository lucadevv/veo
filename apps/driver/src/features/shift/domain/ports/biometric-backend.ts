/**
 * Puerto del backend biométrico para el gate de inicio de turno (BR-I02).
 *
 * El procesamiento ONNX (detección facial + match + liveness) vive en el `biometric-service` (Python)
 * tras identity-service. El driver-bff lo expone al conductor (JWT driver):
 *   1. `POST /drivers/biometric/enroll` body `{ photo }` → RE-enrolamiento de rostro con UNA SELFIE
 *      (sin liveness; mismo contrato que el alta). El anti-suplantación vive en el face-match DNI↔selfie
 *      del binding, no en un reto girar/asentir del enroll.
 *   2. `POST /drivers/shift/biometric/challenge` → `{ challengeId, action, instructions, expiresAt }`.
 *   3. `POST /drivers/shift/biometric/verify` body `{ challengeId, frames }` →
 *      `{ sessionRef, score, livenessPassed, matchPassed }` (sessionRef de un solo uso). El GATE DE TURNO
 *      conserva la prueba de vida (frames); solo el ENROLL pasó a selfie suelta.
 *
 * El `sessionRef` resultante es el que consume `POST /drivers/shift/start`.
 */

/** Reto de prueba de vida emitido por el servidor (action es libre: la define el backend). */
export interface BiometricChallenge {
  challengeId: string;
  /** Acción de liveness (p. ej. TURN_LEFT/BLINK/SMILE); guía la captura y al conductor. */
  action: string;
  /** Instrucción legible para el conductor (es-PE). */
  instructions: string;
  /** ISO-8601: el reto vence en esta hora. */
  expiresAt: string;
}

/** Resultado de la verificación biométrica del servidor. */
export interface BiometricVerifyOutcome {
  /** Referencia opaca de un solo uso que acepta `POST /drivers/shift/start`. */
  sessionRef: string;
  /** Score de match [0..1] (informativo). */
  score: number;
  /** true si la prueba de vida (liveness) pasó. */
  livenessPassed: boolean;
  /** true si el rostro coincide con el enrolado. */
  matchPassed: boolean;
}

export interface BiometricVerificationInput {
  challengeId: string;
  /** Secuencia temporal de frames JPEG en base64 (sin encabezado data URI). */
  frames: string[];
}

/**
 * Entrada del RE-enrolamiento con UNA SELFIE (sin liveness): el conductor manda una sola foto frontal en
 * base64 (sin encabezado data URI). Mismo contrato que el alta (`driverBiometricEnrollRequest`).
 */
export interface BiometricEnrollInput {
  /** Foto frontal JPEG en base64 (sin prefijo `data:`). */
  photo: string;
}

export interface BiometricEnrollResult {
  /** ISO-8601 del enrolamiento. */
  enrolledAt: string;
}

export interface BiometricBackendPort {
  /** Solicita un reto de liveness para el GATE de inicio de turno (`POST …/shift/biometric/challenge`). */
  requestChallenge(): Promise<BiometricChallenge>;
  /** Envía los frames capturados y obtiene el resultado (sessionRef + flags). */
  verify(input: BiometricVerificationInput): Promise<BiometricVerifyOutcome>;
  /**
   * RE-enrola el rostro de referencia del conductor con UNA SELFIE (`POST /drivers/biometric/enroll`,
   * body `{ photo }`). Mismo contrato que el alta de onboarding (sin liveness; el anti-suplantación vive
   * en el face-match DNI↔selfie del binding).
   */
  enroll(input: BiometricEnrollInput): Promise<BiometricEnrollResult>;
}

/* ── Errores de dominio tipados (sin mocks: reflejan respuestas reales del backend) ── */

/** Código cuando el backend biométrico no está disponible (red / 5xx / no configurado). */
export const BIOMETRIC_BACKEND_UNAVAILABLE = 'BIOMETRIC_BACKEND_UNAVAILABLE';

/** Error claro cuando el servicio biométrico del driver-bff no responde (no se inventa sessionRef). */
export class BiometricBackendUnavailableError extends Error {
  readonly code = BIOMETRIC_BACKEND_UNAVAILABLE;
  constructor(message = 'El servicio de verificación biométrica no está disponible') {
    super(message);
    this.name = 'BiometricBackendUnavailableError';
  }
}

/** Código cuando el conductor todavía no ha enrolado su rostro (409/422 del verify/challenge). */
export const BIOMETRIC_NOT_ENROLLED = 'BIOMETRIC_NOT_ENROLLED';

/** Error claro: el conductor debe enrolar su rostro antes de poder iniciar turno. */
export class BiometricNotEnrolledError extends Error {
  readonly code = BIOMETRIC_NOT_ENROLLED;
  constructor(message = 'Debes registrar tu rostro antes de iniciar turno') {
    super(message);
    this.name = 'BiometricNotEnrolledError';
  }
}

/** Código cuando la verificación falla (liveness o match no pasaron). */
export const BIOMETRIC_REJECTED = 'BIOMETRIC_REJECTED';

/** Error claro: la prueba de vida o el match facial fallaron. */
export class BiometricRejectedError extends Error {
  readonly code = BIOMETRIC_REJECTED;
  constructor(
    message = 'No pudimos verificar tu identidad',
    readonly livenessPassed = false,
    readonly matchPassed = false,
  ) {
    super(message);
    this.name = 'BiometricRejectedError';
  }
}

/** Código cuando el conductor quedó bloqueado tras varios fallos (lockout del backend). */
export const BIOMETRIC_LOCKED = 'BIOMETRIC_LOCKED';

/** Error claro: bloqueo temporal por intentos fallidos (mensaje y ventana los define el backend). */
export class BiometricLockedError extends Error {
  readonly code = BIOMETRIC_LOCKED;
  constructor(message = 'Verificación bloqueada temporalmente por seguridad') {
    super(message);
    this.name = 'BiometricLockedError';
  }
}
