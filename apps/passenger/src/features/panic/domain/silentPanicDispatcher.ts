import { ApiError } from '@veo/api-client';
import { NotImplementedError } from '../../../core/errors/notImplemented';
import { uuidv7 } from '../../../shared/utils/uuid';
import type { PanicEscalation } from './panicEscalation';
import type { TriggerPanicUseCase } from './usecases';

/** Espera antes del PRIMER reintento; crece exponencialmente (`BACKOFF_FACTOR`). */
const INITIAL_RETRY_DELAY_MS = 1_000;
/** Factor de crecimiento del backoff exponencial. */
const BACKOFF_FACTOR = 2;
/** Tope por espera individual: pasado este punto reintenta a ritmo constante, no más lento. */
const MAX_RETRY_DELAY_MS = 30_000;
/**
 * Presupuesto TOTAL de reintentos silenciosos (~2 min). Más allá de esto, seguir callados deja de
 * ser discreción y pasa a ser una alerta perdida: se escala al canal visible.
 */
const RETRY_BUDGET_MS = 120_000;

/**
 * true si vale la pena reintentar el disparo.
 *  - `ApiError`: usa la clasificación TIPADA del cliente (`retryable` = red caída / 5xx / 429).
 *    Un 4xx determinista (payload inválido, firma rechazada incluso tras rotar) NUNCA va a
 *    funcionar repitiendo lo mismo → escala ya.
 *  - `NotImplementedError`: falta el puerto nativo (p. ej. ubicación en el esqueleto) — reintentar
 *    es ciego, el puerto no va a aparecer solo → escala ya.
 *  - Resto (TimeoutError del fix de GPS, fallas transitorias de firma/keychain): reintenta; el
 *    próximo intento puede conseguir fix o keychain desbloqueado.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) return error.retryable;
  return !(error instanceof NotImplementedError);
}

/** Espera `ms` con jitter parejo (½·ms .. ms) para no sincronizar reintentos de muchos devices. */
function backoffDelay(ms: number): Promise<void> {
  const jittered = ms / 2 + Math.random() * (ms / 2);
  return new Promise((resolve) => setTimeout(resolve, jittered));
}

/**
 * Entrega AT-LEAST-ONCE del pánico SILENCIOSO (3× volumen), del lado app.
 *
 * Por qué existe: el `HttpClient` NO reintenta POSTs (decisión correcta a nivel transporte: no
 * todos los POST son idempotentes) y el único reintento del `TriggerPanicUseCase` es ante 401 de
 * firma. Sin esta pieza, una falla de red durante el disparo oculto perdía la alerta EN SILENCIO
 * — el peor modo de falla de toda la app.
 *
 * Diseño:
 *  - Genera el `dedupKey` (UUIDv7) UNA sola vez por disparo y lo reusa en CADA reintento: el
 *    panic-service dedup-ea por esa clave, así que reenviar nunca duplica la alerta (si el POST
 *    anterior llegó pero la respuesta se perdió, el server responde `deduplicated`).
 *  - Backoff exponencial + jitter con presupuesto total `RETRY_BUDGET_MS`. Cada intento re-corre
 *    el use case completo (ubicación FRESCA + firma sobre el payload nuevo, mismo dedupKey).
 *  - Vive como SINGLETON del contenedor de DI: el reintento NO muere si la pantalla que armó el
 *    detector se desmonta (cambio de screen durante el viaje).
 *  - Si se agota el presupuesto o el error es determinista, escala vía `PanicEscalation`
 *    (degradación honesta: deja de ser silencioso, nunca éxito falso).
 *  - Un segundo disparo para el MISMO viaje mientras hay uno en vuelo se ignora (misma regla que
 *    el anti doble-tap de la pantalla manual: el cliente no fabrica dos alertas).
 */
export class SilentPanicDispatcher {
  /** Viajes con un disparo silencioso en vuelo (entre el encolado y la confirmación/escalada). */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly triggerPanic: TriggerPanicUseCase,
    private readonly escalation: PanicEscalation,
  ) {}

  /**
   * Encola el disparo silencioso para `tripId` y devuelve de inmediato (el callback del módulo
   * nativo no debe bloquearse). La entrega corre en background con reintentos; no lanza nunca.
   */
  dispatch(tripId: string): void {
    if (this.inFlight.has(tripId)) {
      // Ya hay una alerta en vuelo para este viaje: no fabricamos una segunda con otro dedupKey.
      return;
    }
    this.inFlight.add(tripId);
    // dedupKey ÚNICO por disparo, COMPARTIDO por todos sus reintentos (idempotencia server-side).
    const dedupKey = uuidv7();
    void this.deliver(tripId, dedupKey).finally(() => {
      this.inFlight.delete(tripId);
    });
  }

  /** Bucle de entrega: intenta, espera con backoff y reintenta hasta confirmar, agotar o escalar. */
  private async deliver(tripId: string, dedupKey: string): Promise<void> {
    const deadline = Date.now() + RETRY_BUDGET_MS;
    let delayMs = INITIAL_RETRY_DELAY_MS;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.triggerPanic.execute(tripId, dedupKey);
        return; // Confirmado por el server (creado o deduplicado): la alerta NO se perdió.
      } catch (error) {
        console.warn(`[panic] disparo silencioso falló (intento ${attempt}):`, error);
        if (!isRetryable(error) || Date.now() + delayMs > deadline) {
          // Determinista o presupuesto agotado: dejar de ser silencioso (nunca éxito falso).
          this.escalation.escalate(tripId);
          return;
        }
        await backoffDelay(delayMs);
        delayMs = Math.min(delayMs * BACKOFF_FACTOR, MAX_RETRY_DELAY_MS);
      }
    }
  }
}
