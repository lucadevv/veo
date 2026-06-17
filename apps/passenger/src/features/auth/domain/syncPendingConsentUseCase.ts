import {ApiError} from '@veo/api-client';
import type {CurrentConsent} from '@veo/api-client';
import type {PendingConsent, PendingConsentStore} from './pendingConsent';
import type {RecordConsentUseCase} from './usecases';

/** Espera antes del PRIMER reintento; crece exponencialmente (`BACKOFF_FACTOR`). */
const INITIAL_RETRY_DELAY_MS = 1_000;
/** Factor de crecimiento del backoff exponencial. */
const BACKOFF_FACTOR = 2;
/** Tope por espera individual: pasado este punto reintenta a ritmo constante, no más lento. */
const MAX_RETRY_DELAY_MS = 30_000;
/**
 * Presupuesto TOTAL de un `flush()` (~1 min). Al agotarse NO se pierde nada: la aceptación queda
 * `Pending` en disco y el próximo disparador (boot, foreground, login) reanuda el reintento. El
 * presupuesto solo acota cuánto insiste UNA pasada para no quedar en un bucle infinito en foreground.
 */
const RETRY_BUDGET_MS = 60_000;

/** Espera no bloqueante por defecto (inyectable para tests). */
function defaultDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * true si vale la pena reintentar DENTRO de esta misma pasada de `flush`.
 *
 * Divergencia frente al pánico: un `ApiError` NO-retryable (típicamente 401 cuando el onboarding
 * encoló la aceptación ANTES del login) NO se trata como fracaso definitivo — simplemente esta pasada
 * no puede entregarlo todavía. Por eso `flush` deja la aceptación `Pending` y la reintenta el próximo
 * disparador (post-login). Acá solo decidimos si seguir insistiendo EN CALIENTE: ante un 4xx
 * determinista no tiene sentido martillar el servidor en bucle dentro de la misma pasada.
 */
function isRetryableNow(error: unknown): boolean {
  if (error instanceof ApiError) return error.retryable;
  // Errores no tipados (red local, parsing): un reintento en caliente puede prosperar.
  return true;
}

/** Espera `ms` con jitter parejo (½·ms .. ms) para no sincronizar reintentos de muchos devices. */
function backoffDelay(
  ms: number,
  delay: (ms: number) => Promise<void>,
): Promise<void> {
  const jittered = ms / 2 + Math.random() * (ms / 2);
  return delay(jittered);
}

/**
 * COLA DURABLE de consentimiento (Ley N.° 29733): garantiza que la aceptación capturada en el
 * onboarding LLEGUE al backend aunque falle la red o todavía no haya sesión.
 *
 * Por qué existe: el POST `/users/me/consents` NO se reintenta a nivel transporte y el camino feliz
 * del onboarding ocurre ANTES del login (el usuario aún no tiene JWT). Sin esta pieza, una falla de
 * red —o el 401 esperado del onboarding pre-login— perdía el consentimiento EN SILENCIO, justo el
 * dato que la Ley 29733 exige conservar.
 *
 * Diseño (molde `SilentPanicDispatcher`):
 *  - El `dedupKey` (UUIDv7) lo fija quien ENCOLA (`OnboardingScreen`) y vive en el item persistido:
 *    todos los reintentos reusan la MISMA clave → el POST idempotente nunca duplica el row.
 *  - `flush()` corre backoff exponencial + jitter con presupuesto por pasada; delega el POST en
 *    `RecordConsentUseCase` (SRP: NO arma el request ni toca HTTP). Éxito → vacía la cola.
 *  - Singleton de DI: los reintentos sobreviven al desmontaje de la pantalla. Un flag `inFlight`
 *    evita doble-flush concurrente (boot + login + foreground pueden dispararse casi a la vez).
 *  - A diferencia del pánico, NO hay canal de escalamiento: agotar el presupuesto o recibir un error
 *    no-retryable (p. ej. 401 pre-login) DEJA la aceptación `Pending` para el próximo disparador.
 */
export class SyncPendingConsentUseCase {
  /** Evita dos pasadas de `flush` simultáneas (boot + foreground + post-login casi a la vez). */
  private inFlight = false;

  constructor(
    private readonly recordConsent: RecordConsentUseCase,
    private readonly store: PendingConsentStore,
    /** Inyectable para tests; en producción usa el `setTimeout` real. */
    private readonly delay: (ms: number) => Promise<void> = defaultDelay,
  ) {}

  /**
   * Intenta drenar la cola. No-op si está vacía o si ya hay una pasada en vuelo. Nunca lanza: el
   * llamador la dispara con `void` desde boot, foreground y post-login.
   */
  async flush(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    const pending = this.store.read();
    if (pending === null) {
      return; // Cola vacía (Idle): nada que entregar.
    }
    this.inFlight = true;
    try {
      await this.deliver(pending);
    } finally {
      this.inFlight = false;
    }
  }

  /** Bucle de entrega: intenta, espera con backoff y reintenta hasta confirmar o agotar el presupuesto. */
  private async deliver(pending: PendingConsent): Promise<void> {
    const deadline = Date.now() + RETRY_BUDGET_MS;
    let delayMs = INITIAL_RETRY_DELAY_MS;
    let attempts = pending.attempts;
    for (;;) {
      attempts += 1;
      try {
        await this.recordConsent.execute(pending.selection, pending.dedupKey);
        this.store.clear(); // Confirmado por el server (creado o deduplicado): la cola se vacía.
        return;
      } catch (error) {
        // Persistimos el contador de intentos para diagnóstico aunque esta pasada no entregue.
        this.store.save({...pending, attempts});
        if (!isRetryableNow(error) || Date.now() + delayMs > deadline) {
          // Determinista (401 pre-login) o presupuesto agotado: queda `Pending` para el próximo
          // disparador (login / boot / foreground). NUNCA se pierde el consentimiento.
          console.warn(
            `[consent] entrega diferida (intento ${attempts}); queda en cola:`,
            error,
          );
          return;
        }
        await backoffDelay(delayMs, this.delay);
        delayMs = Math.min(delayMs * BACKOFF_FACTOR, MAX_RETRY_DELAY_MS);
      }
    }
  }

  /**
   * Reconcilia la cola contra el consentimiento VIGENTE del servidor (lo trae `ProfileScreen` al leer
   * el consent): si el server ya tiene la MISMA versión de política que lo encolado, la aceptación ya
   * llegó (probablemente un reintento previo confirmó tras perderse la respuesta) → vacía la cola para
   * no reintentar de más. Idempotente y sin red propia (usa el dato que el llamador ya tiene).
   */
  reconcileWith(current: CurrentConsent): void {
    if (current === null) {
      return;
    }
    const pending = this.store.read();
    if (pending !== null && current.policyVersion === pending.policyVersion) {
      this.store.clear();
    }
  }
}
