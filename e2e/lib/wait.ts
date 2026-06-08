/** Utilidades de espera/poll para el harness. */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Hace ping al endpoint de salud (@veo/observability HealthController). El path varía: la mayoría
 * de servicios excluyen `health` del global prefix (→ `/health`), pero identity-service NO lo excluye
 * (→ `/api/v1/health`). Por eso el path es parametrizable. Devuelve true si responde 2xx.
 */
export async function pingHealth(
  url: string,
  path = '/health',
  timeoutMs = 1000,
  acceptAnyStatus = false,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}${path}`, { signal: ctrl.signal });
    // public-bff aplica JwtAuthGuard global y su /health responde 401 (proceso ARRIBA igualmente):
    // cualquier respuesta HTTP significa que el servidor está escuchando y enrutando.
    return acceptAnyStatus ? true : res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Comprueba que un puerto TCP acepta conexiones (para Postgres/Kafka/Redis). */
export async function pingTcp(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  const net = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Espera hasta que `check()` devuelva true o se agote `timeoutMs`. Lanza con `label` si falla.
 */
export async function waitFor(
  check: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timeout esperando: ${opts.label} (${opts.timeoutMs}ms)` +
      (lastErr ? ` · último error: ${String(lastErr)}` : ''),
  );
}

/** Poll de un valor hasta que `predicate` lo acepte; devuelve el valor. Lanza si expira. */
export async function pollUntil<T>(
  fetchValue: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 400;
  const deadline = Date.now() + opts.timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fetchValue();
    if (predicate(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(
    `Timeout en poll: ${opts.label} (${opts.timeoutMs}ms). Último valor: ${JSON.stringify(last)}`,
  );
}
