/**
 * Política de reintentos con backoff exponencial. Pura y determinista (jitter opcional).
 * delay(attempt) = min(base * factor^(attempt-1), max). `attempt` = nº de intentos ya realizados (>=1).
 */
export interface RetryConfig {
  baseMs: number;
  factor: number;
  maxMs: number;
  defaultMaxAttempts: number;
  jitter: boolean;
}

export class RetryPolicy {
  constructor(
    private readonly cfg: RetryConfig,
    private readonly random: () => number = Math.random,
  ) {}

  get defaultMaxAttempts(): number {
    return this.cfg.defaultMaxAttempts;
  }

  /** Milisegundos a esperar antes del siguiente intento tras `attempt` intentos fallidos. */
  nextDelayMs(attempt: number): number {
    const exp = this.cfg.baseMs * Math.pow(this.cfg.factor, Math.max(0, attempt - 1));
    const capped = Math.min(exp, this.cfg.maxMs);
    if (!this.cfg.jitter) return Math.round(capped);
    // Full jitter en la mitad superior: [capped/2, capped] → evita estampidas sincronizadas.
    return Math.round(capped * (0.5 + this.random() * 0.5));
  }

  /** ¿Se agotaron los reintentos? */
  isExhausted(attempts: number, maxAttempts: number): boolean {
    return attempts >= maxAttempts;
  }
}
