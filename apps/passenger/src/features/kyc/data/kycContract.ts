import {z} from 'zod';

/**
 * Contrato LOCAL del KYC del pasajero (zod). PROVISIONAL.
 *
 * El contrato SOBERANO vive normalmente en `@veo/api-client`, pero el endpoint KYC del pasajero
 * todavía NO existe en el public-bff, así que definimos aquí el request/response esperado para
 * poder construir la feature end-to-end. En cuanto el bff exponga el contrato real:
 *   1. mueve estos schemas a `@veo/api-client` (fuente de verdad compartida con el bff),
 *   2. impórtalos en `httpKycRepository` en lugar de estos,
 *   3. ajusta `KYC_SUBMIT_PATH` si la ruta difiere.
 * El dominio y la presentación NO cambian (dependen de las entidades de dominio, no de estos shapes).
 *
 * Ruta recomendada para public-bff → biometric-service: `POST /kyc/verifications`.
 */

/** Ruta del endpoint (relativa a `env.publicBffUrl`, que ya incluye `/api/v1`). */
export const KYC_SUBMIT_PATH = '/kyc/verifications';

/**
 * Ruta del reto de liveness ACTIVO (relativa a `env.publicBffUrl`).
 * `POST /kyc/challenge` (sin body) → el biometric-service emite la acción a realizar
 * (parpadear, girar la cabeza…) que el pasajero debe ejecutar frente a la cámara.
 */
export const KYC_CHALLENGE_PATH = '/kyc/challenge';

/**
 * Respuesta de `POST /kyc/challenge`. El `action` es el código de la acción (p. ej. `BLINK`,
 * `TURN_HEAD`) y `instructions` el texto legible que se MUESTRA al pasajero. `expiresAt` es la marca
 * temporal (ISO 8601) tras la cual el reto deja de ser válido y hay que pedir uno nuevo.
 */
export const kycChallengeResponse = z.object({
  challengeId: z.string().min(1),
  action: z.string().min(1),
  instructions: z.string().min(1),
  expiresAt: z.string().min(1),
});
export type KycChallengeResponse = z.infer<typeof kycChallengeResponse>;

/** Un frame JPEG (base64 sin prefijo `data:`) con sus dimensiones y marca de captura. */
export const kycFramePayload = z.object({
  /** JPEG en base64 (sin el prefijo `data:image/jpeg;base64,`). */
  base64Jpeg: z.string().min(1),
  // OPCIONALES: el módulo nativo devuelve solo el base64 JPEG; nada aguas abajo consume estas
  // dimensiones, así que no se exigen (el JS las omite cuando captura desde el nativo).
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  capturedAt: z.number().int().nonnegative(),
});
export type KycFramePayload = z.infer<typeof kycFramePayload>;

/**
 * Body de `POST /kyc/verifications`: el `challengeId` del reto de liveness activo emitido por
 * `POST /kyc/challenge`, junto a uno o varios frames de la cámara frontal donde el pasajero ejecuta
 * la acción solicitada. El biometric-service correlaciona frames ↔ reto para validar el liveness.
 */
export const kycSubmitRequest = z.object({
  challengeId: z.string().min(1),
  frames: z.array(kycFramePayload).min(1).max(5),
});
export type KycSubmitRequest = z.infer<typeof kycSubmitRequest>;

/**
 * Respuesta de `POST /kyc/verifications`. El `status` se mantiene como string libre (espeja el
 * `kycStatus` del perfil); el dominio lo normaliza con `mapKycStatus`. Los campos opcionales cubren
 * la forma esperada sin acoplarse a literales exactos del biometric-service.
 */
export const kycSubmitResponse = z.object({
  /** Estado resultante (p. ej. PENDING | APPROVED | REJECTED), tal cual lo emite el servicio. */
  status: z.string(),
  /** Id de la verificación creada (auditoría / seguimiento). */
  verificationId: z.string().optional(),
  /** Motivo del rechazo, si aplica. */
  reason: z.string().optional(),
});
export type KycSubmitResponse = z.infer<typeof kycSubmitResponse>;
