import type { LivenessAction } from '@veo/shared-types';

/**
 * Puerto biométrico (FOUNDATION §9). Motor PROPIO (biometric-service Python/ONNX) tras puerto.
 * identity-service orquesta el flujo de turno (reto → verificación → minteo de sessionRef);
 * el liveness/match real lo resuelve biometric-service.
 *
 * Contrato alineado con la API REAL del biometric-service:
 *  - POST /v1/liveness/challenge → reto de liveness activo.
 *  - POST /v1/enroll            → enrolamiento CON liveness (frames del reto → embedding de referencia).
 *  - POST /v1/embed             → embedding de referencia de UNA foto (compat/sandbox; ver `embed`).
 *  - POST /v1/verify            → veredicto liveness + match contra el embedding de referencia.
 */
export const BIOMETRIC_PROVIDER = Symbol('BIOMETRIC_PROVIDER');

export type BiometricCheckKind = 'ONBOARDING' | 'SHIFT_START' | 'REVERIFY';

/** Reto de liveness activo emitido por biometric-service. */
export interface BiometricChallenge {
  challengeId: string;
  /** Acción solicitada (TURN_LEFT | TURN_RIGHT | NOD | SMILE). Union tipado, nunca string suelto. */
  action: LivenessAction;
  /** Instrucción legible para el conductor (es-PE). */
  instructions: string;
  /** Expiración ISO-8601 del reto. */
  expiresAt: string;
}

/** Entrada del enrolamiento CON liveness: frames del reto que el motor verifica antes de derivar el embedding. */
export interface BiometricEnrollInput {
  /** Identificador del conductor (driverId) para trazabilidad en biometric-service. */
  driverId: string;
  challengeId: string;
  /** Frames del reto de liveness en base64 (orden temporal). */
  frames: string[];
}

/**
 * Resultado del enrolamiento CON liveness. El motor primero confirma que hay una persona VIVA frente a la
 * cámara (anti-spoofing); solo si pasa, deriva el embedding de referencia. Si NO pasa, `embedding` es null
 * y `reason` explica por qué (el enrolamiento se rechaza, no se guarda nada).
 */
export interface BiometricEnrollResult {
  livenessPassed: boolean;
  /** Embedding de referencia si la prueba de vida pasó; `null` si falló. */
  embedding: number[] | null;
  /** Motivo del fallo de liveness (legible); `null` si pasó. */
  reason: string | null;
  /** Momento de la captura (ISO-8601), reportado por el motor. */
  takenAt: string;
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

/**
 * Entrada del face-match DNI↔selfie (sub-lote 3C · BINDING). La `image` es la foto FRONT del DNI (base64)
 * que el admin-bff baja de S3; `referenceEmbedding` es el `faceEmbedding` GUARDADO del conductor (NO uno
 * que mande el caller). La separación es la garantía de seguridad: el match liga la cara del DNI real
 * (almacenada por el conductor) con la biometría de referencia que él enroló con liveness.
 */
export interface BiometricDniMatchInput {
  /** Foto FRONT del DNI en base64 (la baja el admin-bff de S3, no la inventa el caller). */
  image: string;
  /** Embedding de referencia GUARDADO del conductor (faceEmbedding enrolado con liveness). */
  referenceEmbedding: number[];
}

/**
 * Resultado del face-match DNI↔selfie. `matched` = veredicto (la cara del DNI coincide con la biometría
 * de referencia); `score` en 0..100 (identity trabaja en esa escala, igual que verify); `reason` = motivo
 * legible cuando NO coincide (o no se detectó cara), `null` cuando coincide.
 */
export interface BiometricDniMatchResult {
  matched: boolean;
  /** 0..100. El biometric-service entrega 0..1; el cliente live lo reescala (igual que verify). */
  score: number;
  reason: string | null;
}

/**
 * Resultado del enrolamiento del REGISTRO con liveness PASIVO (PAD single-frame). La decisión del caller se
 * hace por BOOLEANOS (no por el string de `reason`): `livenessChecked && !live` ⇒ spoof; `embedding == null`
 * sin liveness ⇒ sin rostro; `embedding` presente ⇒ enrolado (vivo, o degradado si el PAD no estaba).
 */
export interface BiometricPassiveEnrollResult {
  /** Embedding de referencia (512-d) si la foto es de una persona real; `null` si spoof o sin rostro. */
  embedding: number[] | null;
  /** Veredicto de vida. `true` si pasó (o si el PAD no estaba cargado → degradado a sin-liveness). */
  live: boolean;
  /** ¿Corrió el PAD? `false` = modelo ausente → enrolado SIN liveness (degradación honesta). */
  livenessChecked: boolean;
  /** Score de la clase viva (0..1). */
  score: number;
  /** Motivo legible cuando NO se enroló ('spoof' | 'no_face'); `null` si enroló. */
  reason: string | null;
}

export interface BiometricProvider {
  /** Emite un reto de liveness activo. */
  createChallenge(): Promise<BiometricChallenge>;
  /**
   * Enrolamiento CON liveness ACTIVO por reto (frames girá/sonreí → prueba de vida → embedding). Hoy NO lo
   * usa el REGISTRO del conductor: el alta migró a 1 selfie (`embed`, ver `enrollFace` en drivers.service).
   * El liveness activo por reto vive en el GATE DE TURNO (`verify`). PLAN (en construcción): al registro se
   * le agrega liveness PASIVO (PAD single-frame, sin frames extra → sin lag) DENTRO del path de `embed`/
   * `enrollFace`, NO por acá. Este método queda para el camino activo (turno/legacy).
   */
  enrollWithLiveness(input: BiometricEnrollInput): Promise<BiometricEnrollResult>;
  /**
   * Calcula el embedding de referencia de UNA foto, SIN liveness. Para el DNI (face-match), el pasajero, y
   * usos server-to-server que NO deben correr el PAD (la foto del DNI ES una foto → el PAD la marcaría spoof).
   */
  embed(photo: string): Promise<number[]>;
  /**
   * Enrolamiento del REGISTRO del conductor con liveness PASIVO (PAD single-frame sobre 1 foto, SIN frames
   * extra → SIN lag). Corre el anti-spoofing ANTES del embedding: si la foto es un ataque de presentación
   * (impresa/pantalla) NO devuelve embedding (`live=false`, `livenessChecked=true`). Reemplaza el `embed`
   * directo del registro (que no tenía liveness). El liveness ACTIVO por reto sigue en el turno (`verify`).
   */
  enrollPassive(photo: string): Promise<BiometricPassiveEnrollResult>;
  /** Verifica los frames del reto contra el embedding de referencia (gate de turno). */
  verify(input: BiometricVerifyInput): Promise<BiometricVerifyResult>;
  /**
   * Face-match DNI↔selfie (sub-lote 3C · BINDING): coteja la foto FRONT del DNI contra el embedding de
   * referencia GUARDADO del conductor. El operador VE el resultado antes de aprobar (no aprueba a ciegas).
   */
  matchDniFace(input: BiometricDniMatchInput): Promise<BiometricDniMatchResult>;
}
