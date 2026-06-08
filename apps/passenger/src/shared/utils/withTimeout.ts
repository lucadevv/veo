/**
 * Error de tope de tiempo: una promesa no resolvió dentro del plazo. Se distingue por `name`
 * para que las capas superiores puedan degradar con un mensaje claro en vez de tratarlo como
 * un fallo genérico.
 */
export class TimeoutError extends Error {
  constructor(message = 'La operación tardó demasiado') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Envuelve una promesa con un tope de tiempo. Si no resuelve antes de `ms`, RECHAZA con
 * `TimeoutError` en vez de colgar para siempre.
 *
 * Pensado para rutas críticas (pánico) donde un `getCurrentPosition()` que cuelga —GPS sin fix,
 * indoor, bajo coacción— dejaría la alerta en un spinner infinito que nunca envía ni falla. Un
 * rechazo determinista deja que la UI muestre el error y que el auto-trigger lo registre.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message?: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
