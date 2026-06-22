import { ApiError } from '@veo/api-client';

/**
 * Clasificación del error que burbujea al CONFIRMAR el KYC del alta (`enroll.mutateAsync` →
 * `submit.mutateAsync`). La presentación la usa para mostrar un mensaje accionable y específico en vez
 * de un banner genérico:
 *
 *  - `missing-capture`: no hay una captura facial válida que enrolar (el proveedor no entregó la foto
 *    real). NO es un fallo de backend: es un gate del cliente que IMPIDE cerrar el alta sin biometría.
 *    El conductor debe (re)completar la verificación facial.
 *  - `liveness`: la PRUEBA DE VIDA no se superó (422 con `details.reason`): el gesto no se ejecutó bien
 *    o el motor sospechó spoofing (foto/video). Es ACCIONABLE: el conductor pide un reto NUEVO y repite el
 *    gesto. Se distingue del `face` (rostro no procesable) por el `details.reason` que trae el 422.
 *  - `face`: el backend no pudo usar la imagen (0 o 2+ rostros). El conductor reintenta con buena luz.
 *  - `network`: fallo de red (sin respuesta del servidor). Reintentar suele resolver.
 *  - `incomplete`: error de DOMINIO del cierre (`RegistrationCloseError`): el backend reporta que el alta
 *    todavía NO está completa al cerrar el KYC. Es ACCIONABLE (faltan datos/pasos), NO un fallo opaco: se
 *    mapea a un mensaje propio para NO esconder una causa real bajo `generic` (regresión de honestidad).
 *  - `generic`: cualquier otro fallo (5xx upstream, error desconocido).
 */
export type KycEnrollErrorKind =
  | 'missing-capture'
  | 'liveness'
  | 'face'
  | 'network'
  | 'incomplete'
  | 'generic';

/**
 * Error SENTINEL del cliente: se intentó confirmar el KYC sin una captura facial válida que enrolar.
 * Defense-in-depth — el enroll de la biometría es OBLIGATORIO antes de cerrar el alta, así que sin
 * foto real NO se llama a `submit`. Se enruta por el MISMO surface tipado de errores de enroll
 * (`classifyKycEnrollError` lo mapea a `'missing-capture'`) para que la pantalla muestre un banner
 * accionable ("Necesitás completar la verificación facial") en vez de un dead-end silencioso.
 */
export class MissingFaceCaptureError extends Error {
  constructor() {
    super('Necesitás completar la verificación facial');
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
 * Motivo de fallo de liveness embebido por el backend en `details.reason` del 422 "Prueba de vida no
 * superada". Lo devolvemos para que la pantalla pueda APENDARLO al mensaje i18n (de forma humana, nunca
 * como único texto crudo). Devuelve `null` si no hay un reason string utilizable.
 *
 * DEUDA(liveness-removido): el KYC del alta pasó a UNA SELFIE simple (Lote 2). La pantalla ya no
 * consume este helper (no hay reto de liveness en el alta). Se conserva junto al kind `'liveness'` del
 * clasificador por si el backend sigue emitiendo ese 422. Gatillo: borrar `livenessFailReason` + el kind
 * `'liveness'` cuando se confirme que el enroll del alta nunca devuelve "prueba de vida no superada".
 */
export function livenessFailReason(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== 'object') {
    return null;
  }
  const reason = (error.details as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : null;
}

/** true si el `details` del error trae un `reason` string (firma del 422 de "prueba de vida no superada"). */
function hasLivenessFailReason(details: unknown): boolean {
  if (!details || typeof details !== 'object') {
    return false;
  }
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim().length > 0;
}

/**
 * Clasifica el error del enroll para mapearlo a un mensaje específico. Es CONSERVADOR: solo marca
 * `face` cuando hay señal clara de "rostro no procesable" (422 directo o embebido); un 5xx genérico NO
 * se hace pasar por "rostro" (sería deshonesto y confundiría al conductor). Lo no-`ApiError` y lo
 * desconocido cae en `generic`.
 *
 * NOTA DE CONTRATO (backend): hoy el biometric-service responde 422 ("la imagen debe contener
 * exactamente un rostro claro") pero identity-service lo reescribe a `502 EXTERNAL` con
 * `details: { status: 422 }`. Por eso el puente vía `details.status`. Si el backend pasa a propagar el
 * 422 limpio, la rama `status === 422` lo cubre sin cambios en la app.
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
    // Prueba de vida no superada: 422 DIRECTO con `details.reason` (el gesto/anti-spoofing falló). Se
    // chequea ANTES que `face` porque ese 422 también es `status === 422`; el `reason` lo desambigua.
    if (error.status === FACE_UNPROCESSABLE_STATUS && hasLivenessFailReason(error.details)) {
      return 'liveness';
    }
    // Rostro no procesable (0 o 2+ rostros): 422 directo SIN reason, o el 422 embebido por identity-service.
    if (error.status === FACE_UNPROCESSABLE_STATUS || hasEmbeddedUnprocessableStatus(error.details)) {
      return 'face';
    }
    return 'generic';
  }
  return 'generic';
}
