/**
 * Entidades de dominio de KYC (verificación de identidad / captura facial del pasajero).
 *
 * `kycStatus` en el perfil (`GET /users/me`) es un `z.string()` libre en el contrato soberano del
 * bff; aquí lo normalizamos a un enum de DOMINIO estable para que la UI no dependa del casing ni de
 * los literales exactos del backend. El mapeo vive en `mapKycStatus` (un solo punto de verdad).
 */

/** Estado de la verificación de identidad del pasajero (dominio puro, sin transporte). */
export type KycStatus =
  /** Nunca inició la verificación (o el bff aún no la conoce). */
  | 'unverified'
  /** Enviada; el servicio biométrico la está evaluando (revisión manual/automática). */
  | 'pending'
  /** Aprobada: identidad verificada. */
  | 'approved'
  /** Rechazada: debe reintentar la captura. */
  | 'rejected';

/**
 * Normaliza el `kycStatus` libre del bff (string) a un `KycStatus` de dominio.
 *
 * Tolerante a variantes de casing y a los sinónimos más comunes del backend
 * (`verified`/`approved`, `in_review`/`pending`, `failed`/`denied`/`rejected`). Cualquier valor
 * desconocido o vacío cae en `unverified` (estado seguro: ofrece reintentar la verificación).
 */
export function mapKycStatus(raw: string | null | undefined): KycStatus {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'approved':
    case 'verified':
    case 'passed':
      return 'approved';
    case 'pending':
    case 'in_review':
    case 'in-review':
    case 'review':
    case 'processing':
    case 'submitted':
      return 'pending';
    case 'rejected':
    case 'failed':
    case 'denied':
      return 'rejected';
    default:
      return 'unverified';
  }
}

/** true si el pasajero ya está verificado (no necesita pasar por la cámara KYC). */
export function isKycVerified(raw: string | null | undefined): boolean {
  return mapKycStatus(raw) === 'approved';
}

/**
 * Reto de liveness ACTIVO emitido por el servicio biométrico (vía `POST /kyc/challenge`).
 *
 * El motor biométrico exige una acción del pasajero (parpadear, girar la cabeza…) para descartar
 * suplantación con foto/vídeo. La pantalla MUESTRA `instructions` de forma prominente antes/durante la
 * captura y devuelve `challengeId` al enviar los frames para que el backend correlacione la acción.
 */
export interface KycChallenge {
  /** Id del reto; se reenvía en `POST /kyc/verifications` para correlacionar la acción. */
  challengeId: string;
  /** Código de la acción requerida (p. ej. `BLINK`, `TURN_HEAD`). */
  action: string;
  /** Texto legible que se muestra al pasajero (p. ej. "Parpadea dos veces mirando a la cámara"). */
  instructions: string;
  /** Marca temporal ISO 8601 tras la cual el reto caduca y hay que pedir uno nuevo. */
  expiresAt: string;
}

/**
 * Fases del flujo de captura (máquina de estados de la pantalla de cámara):
 * idle → capturing (guía/overlay de liveness) → submitting → resolved (resultado).
 */
export type KycCapturePhase = 'idle' | 'capturing' | 'submitting' | 'resolved';

/**
 * Un cuadro (frame) capturado de la cámara frontal, listo para enviar al servicio biométrico.
 *
 * El contenido es un data URI / base64 JPEG. El `KycFrameSource` (puerto de presentación) es quien
 * produce estos frames; el dominio sólo conoce su forma, no cómo se obtienen.
 */
export interface KycFrame {
  /** JPEG en base64 (sin prefijo data:), tal como lo espera el contrato del bff. */
  base64Jpeg: string;
  /**
   * Ancho en píxeles del frame capturado. OPCIONAL: el módulo nativo de captura devuelve solo el
   * base64 JPEG (nada aguas abajo consume esta metadata), así que no se exige.
   */
  width?: number;
  /**
   * Alto en píxeles del frame capturado. OPCIONAL por la misma razón que `width`: el nativo no la
   * provee y el bff/biometric-service no la requiere.
   */
  height?: number;
  /** Marca de tiempo de captura (epoch ms), útil para correlacionar liveness. */
  capturedAt: number;
}
