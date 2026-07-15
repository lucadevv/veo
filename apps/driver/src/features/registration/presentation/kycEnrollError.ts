import { ApiError } from '@veo/api-client';

/**
 * Clasificación del error que burbujea al CONFIRMAR el KYC del alta (`enroll.mutateAsync` →
 * `submit.mutateAsync`). La presentación la usa para mostrar un mensaje accionable y específico en vez
 * de un banner genérico:
 *
 *  - `missing-capture`: no hay una captura facial válida que enrolar (el proveedor no entregó la foto
 *    real). NO es un fallo de backend: es un gate del cliente que IMPIDE cerrar el alta sin biometría.
 *    El conductor debe (re)completar la verificación facial.
 *  - `spoof`: el ANTI-SPOOFING PASIVO (PAD single-frame) sospechó un ataque de presentación — la cámara
 *    apuntó a una FOTO o una PANTALLA, no a una persona real (422 con `details.reason === 'spoof'`). Es
 *    ACCIONABLE y distinto de `face`: el rostro se detectó, pero NO era una persona viva. El conductor
 *    repite la selfie apuntando a su cara real (sin fotos ni pantallas de por medio).
 *  - `face`: el motor no pudo usar la imagen como rostro procesable — 0/2+ rostros, o el PAD no detectó
 *    a nadie (422 con `details.reason === 'no_face'`, o un 422 sin reason). El conductor reintenta con
 *    buena luz y mirando al frente.
 *  - `network`: fallo de red (sin respuesta del servidor). Reintentar suele resolver.
 *  - `incomplete`: error de DOMINIO del cierre (`RegistrationCloseError`): el backend reporta que el alta
 *    todavía NO está completa al cerrar el KYC. Es ACCIONABLE (faltan datos/pasos), NO un fallo opaco: se
 *    mapea a un mensaje propio para NO esconder una causa real bajo `generic` (regresión de honestidad).
 *  - `generic`: cualquier otro fallo (5xx upstream, error desconocido).
 */
export type KycEnrollErrorKind =
  | 'missing-capture'
  | 'spoof'
  | 'face'
  | 'network'
  | 'incomplete'
  | 'generic';

/**
 * Vocabulario de DOMINIO del backend para el motivo del rechazo del enroll (`details.reason` del 422 que
 * tira `enrollFace` en identity-service). Tipado y centralizado: la app NUNCA compara el reason como string
 * suelto (`reason === 'spoof'`) — se chequea contra estas constantes. Un typo es ERROR DE COMPILACIÓN.
 *  - `SPOOF`:   el PAD pasivo marcó la captura como ataque de presentación (foto/pantalla).
 *  - `NO_FACE`: no se detectó un rostro usable (motor sin embedding).
 */
export const EnrollFailReason = {
  SPOOF: 'spoof',
  NO_FACE: 'no_face',
} as const;
export type EnrollFailReason = (typeof EnrollFailReason)[keyof typeof EnrollFailReason];

/**
 * Error SENTINEL del cliente: se intentó confirmar el KYC sin una captura facial válida que enrolar.
 * Defense-in-depth — el enroll de la biometría es OBLIGATORIO antes de cerrar el alta, así que sin
 * foto real NO se llama a `submit`. Se enruta por el MISMO surface tipado de errores de enroll
 * (`classifyKycEnrollError` lo mapea a `'missing-capture'`) para que la pantalla muestre un banner
 * accionable ("Necesitas completar la verificación facial") en vez de un dead-end silencioso.
 */
export class MissingFaceCaptureError extends Error {
  constructor() {
    super('Necesitas completar la verificación facial');
    this.name = 'MissingFaceCaptureError';
  }
}

/**
 * Error de DOMINIO del cierre del alta: tras enrolar la biometría, el backend (fuente de verdad) reporta
 * que el alta AÚN no está completa. Es un error tipado y ACCIONABLE — NO un `ApiError` opaco ni un fallo
 * desconocido — para que `classifyKycEnrollError` lo mapee a `'incomplete'` (mensaje propio) en vez de
 * enmascararlo como `'generic'` ("Hubo un problema"). Históricamente el cierre re-gateaba con el borrador
 * LOCAL y, en un alta REANUDADA, ese borrador venía vacío → rechazaba con un error de dominio que caía en
 * `generic`, escondiendo que el server estaba OK. El cierre ya no usa ese gate (el server decide), pero el
 * tipo existe para que cualquier "incompleto" del DOMINIO se reporte honesto y nunca vuelva a `generic`.
 */
export class RegistrationCloseError extends Error {
  constructor(message = 'El registro está incompleto') {
    super(message);
    this.name = 'RegistrationCloseError';
  }
}

/**
 * Código HTTP que el biometric-service devuelve cuando la imagen no contiene EXACTAMENTE un rostro
 * (0 o 2+). Hoy identity-service colapsa ese 422 a `502 EXTERNAL`, pero deja el original en
 * `details.status` — así que distinguimos el caso "rostro" por DOS vías (ver `classifyKycEnrollError`):
 * un 422 directo (si en el futuro el backend lo propaga limpio) o `details.status === 422` (puente actual).
 */
const FACE_UNPROCESSABLE_STATUS = 422;

/** true si el `details` del error trae `{ status: 422 }` (el 422 original embebido por identity-service). */
function hasEmbeddedUnprocessableStatus(details: unknown): boolean {
  if (!details || typeof details !== 'object') {
    return false;
  }
  const status = (details as { status?: unknown }).status;
  return status === FACE_UNPROCESSABLE_STATUS;
}

/**
 * Lee el `details.reason` del 422 del enroll (el motivo de DOMINIO que tira `enrollFace`). Devuelve el
 * string crudo (lo compara el clasificador contra `EnrollFailReason`) o `null` si no hay un reason usable.
 */
function readEnrollReason(details: unknown): string | null {
  if (!details || typeof details !== 'object') {
    return null;
  }
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : null;
}

/**
 * Clasifica el error del enroll para mapearlo a un mensaje específico. Es CONSERVADOR: solo marca `spoof`
 * ante la señal EXACTA del PAD (`details.reason === 'spoof'`); todo otro 422 sobre la selfie (sin rostro,
 * 0/2+ rostros, reason desconocido) cae en `face` — un 422 unprocessable de la selfie SIEMPRE es "la foto
 * no sirvió, retomala", lo más accionable. Un 5xx genérico NO se hace pasar por rostro ni spoof (sería
 * deshonesto). Lo no-`ApiError` y lo desconocido cae en `generic`.
 *
 * NOTA DE CONTRATO (backend): `enrollFace` (identity-service) tira el 422 PROPIO con `details.reason ∈
 * {spoof, no_face}`; el bff-exception-filter propaga LIMPIO los <500 (status+code+details intactos), así
 * que el `reason` llega a la app sin reescribir. El caso "0/2+ rostros" del biometric-service se reescribe
 * a 502 con `details.status === 422` — de ahí el puente `hasEmbeddedUnprocessableStatus`.
 */
export function classifyKycEnrollError(error: unknown): KycEnrollErrorKind {
  if (error instanceof MissingFaceCaptureError) {
    return 'missing-capture';
  }
  // Error de DOMINIO del cierre: el backend reporta el alta incompleta. Accionable y honesto: NO se
  // disfraza de `generic`. Se chequea por el TIPO (sin strings mágicos), antes que el fallback genérico.
  if (error instanceof RegistrationCloseError) {
    return 'incomplete';
  }
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return 'network';
    }
    if (error.status === FACE_UNPROCESSABLE_STATUS) {
      // Ataque de presentación (PAD pasivo): rostro detectado pero NO era una persona viva. Se chequea
      // contra la constante tipada, ANTES del fallback a `face`.
      if (readEnrollReason(error.details) === EnrollFailReason.SPOOF) {
        return 'spoof';
      }
      // Cualquier otro 422 sobre la selfie (no_face, sin reason, reason desconocido): la foto no se pudo
      // usar como rostro → retomar con buena luz.
      return 'face';
    }
    // 422 embebido por identity-service (502 EXTERNAL con `details.status === 422`): "0 o 2+ rostros".
    if (hasEmbeddedUnprocessableStatus(error.details)) {
      return 'face';
    }
    return 'generic';
  }
  return 'generic';
}
