/**
 * Puerto `Clock` (reloj inyectable) — formaliza vía DI la convención `now = Date.now()` que ya
 * circulaba a mano por el monorepo. El dominio depende de esta INTERFAZ, nunca del adaptador:
 * en prod se inyecta `SystemClock` (lee el reloj real); en tests, `FixedClock` (determinista).
 *
 * Convención de unidad: `now()` devuelve MILISEGUNDOS desde epoch (misma semántica que `Date.now()`).
 * Fuente única — si un caller necesita segundos, divide él (`Math.floor(clock.now() / 1000)`).
 *
 * Vive en @veo/utils (framework-free, como `distributed-lock`): solo tipos + clases puras. El token
 * `CLOCK` es un `Symbol` plano (sin dependencia de NestJS); cada app lo wirea en su contenedor DI.
 */

/** Puerto: una fuente de tiempo. `now()` → milisegundos desde epoch (UNIX), igual que `Date.now()`. */
export interface Clock {
  now(): number;
}

/** Adaptador de producción: lee el reloj real del sistema. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * Adaptador de test: reloj fijo y controlable. Determinista por construcción — no toca `Date.now()`.
 * `advance(ms)` lo mueve hacia adelante; `set(ms)` lo posiciona en un instante absoluto.
 */
export class FixedClock implements Clock {
  private current: number;

  constructor(ms: number) {
    this.current = ms;
  }

  now(): number {
    return this.current;
  }

  /** Avanza el reloj `ms` milisegundos (puede ser negativo para retroceder). */
  advance(ms: number): void {
    this.current += ms;
  }

  /** Posiciona el reloj en un instante absoluto (ms desde epoch). */
  set(ms: number): void {
    this.current = ms;
  }
}

/** Token de inyección del puerto `Clock`. Symbol plano (framework-free); cada app lo provee en su DI. */
export const CLOCK = Symbol('CLOCK');
