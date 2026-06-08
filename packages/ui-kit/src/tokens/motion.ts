/**
 * Tokens de movimiento VEO (destilados de emil-design-eng), alineados a Reanimated.
 *
 * Reglas: UI < 300ms, ease-out para entrar (feedback inmediato), nunca ease-in en UI,
 * exit ~60-70% del enter. Curvas custom (las built-in son demasiado débiles).
 * Las curvas se guardan como puntos de control para `Easing.bezier(...)`.
 */

/** Puntos de control de una curva cubic-bezier. */
export type BezierPoints = readonly [number, number, number, number];

export const motion = {
  /** Duraciones en milisegundos. */
  duration: {
    instant: 0,
    /** feedback de press */
    fast: 120,
    /** dropdowns, pills, transiciones cortas */
    base: 200,
    /** modales, sheets entrando */
    slow: 320,
    /** reveals grandes / mapa */
    slower: 420,
  },
  /** Duraciones de salida (más rápidas que la entrada). */
  exit: {
    fast: 90,
    base: 140,
    slow: 200,
  },
  /** Curvas de easing (mismas que el sistema web en tokens.css). */
  easing: {
    /** ease-out fuerte: entrar / feedback inmediato */
    standard: [0.23, 1, 0.32, 1] as BezierPoints,
    /** ease-in-out: movimiento/morphing en pantalla */
    inOut: [0.77, 0, 0.175, 1] as BezierPoints,
    /** curva tipo drawer iOS (Ionic) para sheets */
    drawer: [0.32, 0.72, 0, 1] as BezierPoints,
  },
  /** Configs de spring (estilo Apple: razonar por duración + rebote). */
  spring: {
    /** transiciones suaves sin rebote perceptible */
    default: { damping: 26, stiffness: 240, mass: 1 },
    /** gestos / elementos "vivos" (rebote sutil) */
    bouncy: { damping: 18, stiffness: 220, mass: 1 },
  },
  /** Escalas de feedback de press (subtle: 0.95-0.98). */
  scale: {
    press: 0.97,
    pressStrong: 0.95,
  },
} as const;

export type Motion = typeof motion;
